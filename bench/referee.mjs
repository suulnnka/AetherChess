/* ============================================================
 * wasm 驱动的棋规裁判 + 本引擎驱动(bench 三件套共用)。
 *
 * src/rules.js(JS 参照实现)移除后,棋规仲裁只能也只该走 wasm 本体:
 * engineLoad 全序列重演 → engineState 取合法表/终局判定 → engineThink 出招。
 * 引擎是全局单实例状态,「裁判」与「我方引擎」天然同状态,不存在两套棋规。
 *
 * 位序契约(见 tools/wasm-smoke.mjs 头注释):
 *   engineState.legalOut / engineLoad 输入 = 线格式 (from<<6|to)
 *   engineThink 返回 = 内部打包 (from 低 6 位)
 *
 * wasm 的终局判定覆盖 将死/逼和/子力不足/三次重复;五十步规则 wasm 没有导出
 * 计数器,这里按规则手工维护(兵动或吃子清零,否则 +1,≥100 判和)。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WASM_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'wasm', 'chess.wasm');

export async function createEngine(wasmPath = WASM_PATH) {
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
  const X = instance.exports;
  if (X.engineInit() !== 0) throw new Error('engineInit 失败');

  const FILE = 'abcdefgh';
  const sqName = (s) => FILE[s & 7] + (8 - (s >> 3));
  const sqOf = (s) => (8 - Number(s[1])) * 8 + FILE.indexOf(s[0]);

  /* 难度档(worker 内联表同款;bench 用节点预算做确定性约束,ms 在 wasm 无效) */
  const LEVELS = {
    easy: { depth: 2, jitter: 70, nodes: 20000 },
    normal: { depth: 24, jitter: 0, nodes: 40000 },
    hard: { depth: 24, jitter: 0, nodes: 160000 },
    master: { depth: 24, jitter: 0, nodes: 900000 },
  };

  const eng = {
    X,
    LEVELS,
    seq: [],          // 线格式全序列(engineLoad 语义:从初始局面重演)
    half: 0,          // 五十步计数(兵动/吃子清零)
    depthSum: 0, depthN: 0,

    reset() {
      eng.seq = [];
      eng.half = 0;
      eng.depthSum = 0;
      eng.depthN = 0;
      if (X.engineLoad(0) !== 1) throw new Error('engineLoad(0) 失败');
    },

    /** worker 契约:先把全序列写进 engineMovesBuf,再 engineLoad(n) 重演 */
    loadSeq() {
      const view = new Int32Array(X.memory.buffer, X.engineMovesBuf(), eng.seq.length);
      for (let i = 0; i < eng.seq.length; i++) view[i] = eng.seq[i];
      return X.engineLoad(eng.seq.length) === 1;
    },

    /** 装载当前序列并刷新合法表。返回 { legal, over, result }。
     *  legal 是 [{uci, wire}];result:'mate'|'stale'|'material'|'threefold'|'fiftymove'|null */
    refresh() {
      if (!eng.loadSeq()) throw new Error('非法序列');
      // 五十步:引擎不判,序列重演后按本地计数补判
      if (eng.half >= 100) return { legal: [], over: true, result: 'fiftymove' };
      X.engineState();
      const board = new Int8Array(X.memory.buffer, X.engineBoardPtr(), 64);
      const wires = Array.from(new Int32Array(X.memory.buffer, X.engineLegalPtr(), X.engineLegalCount()));
      const legal = wires.map((w) => {
        const from = (w >> 6) & 63, to = w & 63;
        /* legalOut 只有 from/to(升变只留升后,标志位被丢):兵到底线即升变 */
        const promo = (board[from] & 7) === 1 && (to >> 3) === 0;
        return { uci: sqName(from) + sqName(to) + (promo ? 'q' : ''), wire: w };
      });
      let over = false, result = null;
      if (X.engineOver() === 1) {
        over = true;
        result = ['', 'mate', 'stale', 'material', 'threefold'][X.engineResult()];
      }
      return { legal, over, result };
    },

    /** 按线格式落子(半步计数在这里维护:读落子前的棋盘判兵动/吃子) */
    playWire(wire) {
      const board = new Int8Array(X.memory.buffer, X.engineBoardPtr(), 64);
      const from = (wire >> 6) & 63, to = wire & 63;
      const mover = board[from];
      const piecesBefore = board.reduce((a, p) => a + (p ? 1 : 0), 0);
      eng.seq.push(wire);
      if (!eng.loadSeq()) throw new Error('非法着法');
      const piecesAfter = board.reduce((a, p) => a + (p ? 1 : 0), 0);
      if ((mover & 7) === 1 || piecesAfter < piecesBefore) eng.half = 0;
      else eng.half += 1;
    },

    playUci(uci) {
      const { legal } = eng.refresh();
      const hit = legal.find((m) => m.uci === uci);
      if (!hit) throw new Error('非合法着法: ' + uci);
      eng.playWire(hit.wire);
    },

    /** 本引擎出招(确定性:seed 固定)。返回 uci;深度计入均值。 */
    think(levelId = 'hard', seed = 1) {
      const lv = eng.LEVELS[levelId];
      const m = X.engineThink(lv.depth, lv.nodes, lv.jitter, seed);
      if (!m) return null;
      eng.depthSum += X.engineDepth();
      eng.depthN += 1;
      const from = m & 63, to = (m >> 6) & 63;
      const flag = (m >> 12) & 15;
      return sqName(from) + sqName(to) + (flag >= 6 ? 'q' : '');
    },

    /** 内部打包着法 → 线格式(自弈/记录用) */
    toWire(m) {
      return ((m & 63) << 6) | ((m >> 6) & 63);
    },

    /** 静态评估,白方视角厘兵(engineEvalCp 是走子方视角) */
    evalWhite() {
      const cp = X.engineEvalCp();
      return X.engineStm() === 0 ? cp : -cp;
    },

    ourAvgDepth() {
      return eng.depthN ? eng.depthSum / eng.depthN : 0;
    },
  };
  eng.reset();
  return eng;
}

/* ---------- UCI ↔ 序列(开局谱用) ---------- */
export function openingToUcis(opening) {
  return opening; // 开局谱本来就是 uci 数组,保持类型直观
}
