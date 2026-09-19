#!/usr/bin/env node
/* ============================================================
 * wasm 产物探针:与 JS 引擎(src/rules.js + src/ai.js,参照实现)对拍。
 *
 * 三道关,任何一道失败退出码 1(build-wasm 会拦住提交):
 *   1. perft / state:标准值 + 与 JS 的合法着法表逐项一致;
 *   2. 评估逐位对拍:随机游走 + 自对弈的全部中间局面,JS evaluate(pos)
 *      与 wasm engineEvalCp 必须**完全相等**(f64 累加顺序都一致才算过);
 *   3. 搜索逐位对拍:同一自对弈序列,同节点预算(时间给 JS 传超大 ms ⇒
 *      JS 的时间兜底与迭代早停全部失效,行为退化为纯节点预算 = wasm 的
 *      语义),JS searchBest 与 wasm engineThink 的
 *      move/score/depth/nodes 必须全部相等。搜索按对弈顺序进行,两侧
 *      置换表随搜索同步演化 —— 第一处分歧就会当场炸出来。
 *
 * 用法:node tools/probe-wasm.mjs [wasm路径] [--games N] [--nodes N]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WHITE, BLACK, QUEEN,
  mFrom, mTo, mPromo, mFlag, F_OO, F_OOO,
  newPos, genLegal, hasLegalMove, inCheck, isLegal, make,
  isThreefold, insufficientMaterial,
} from '../src/rules.js';
import { searchBest, evaluate } from '../src/ai.js';
import { bookCandidates } from '../src/book.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const WASM = argv.find((a) => a.endsWith('.wasm')) || path.join(ROOT, 'wasm', 'chess.wasm');
const argNum = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : d;
};
const GAMES = argNum('--games', 2);
const NODES = argNum('--nodes', 40000);
const MAXPLY = argNum('--plies', 60);

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) pass++;
  else {
    fail++;
    console.log('  ✗ ' + msg);
  }
};

/* ---------- wasm 实例 ---------- */
const bytes = fs.readFileSync(WASM);
const { instance } = await WebAssembly.instantiate(bytes, {});
const X = instance.exports;
const u32 = (v) => v >>> 0;

const movesPtr = X.engineMovesBuf();
const legalPtr = X.engineLegalPtr();
const boardPtr = X.engineBoardPtr();

const loadSeq = (seq) => {
  const view = new Int32Array(X.memory.buffer, movesPtr, seq.length);
  for (let i = 0; i < seq.length; i++) view[i] = seq[i];
  return X.engineLoad(seq.length) === 1;
};

/* ---------- JS 侧规则事实(与 src/worker.js describeState 同源逻辑)---------- */
const BUF = new Int32Array(256);
function jsState(pos) {
  const n = genLegal(pos, BUF);
  const legal = [];
  for (let i = 0; i < n; i++) {
    const m = BUF[i];
    const pr = mPromo(m);
    if (pr && pr !== QUEEN) continue;
    legal.push((mFrom(m) << 6) | mTo(m));
  }
  const check = inCheck(pos);
  let over = false, result = 0, winner = -1;   // wasm result 编码:1 mate 2 stale 3 material 4 threefold
  if (!hasLegalMove(pos, BUF)) {
    over = true;
    if (check) { result = 1; winner = 1 - pos.stm; } else result = 2;
  } else if (insufficientMaterial(pos)) { over = true; result = 3; }
  else if (isThreefold(pos)) { over = true; result = 4; }
  return { legal, stm: pos.stm, check: check ? 1 : 0, over: over ? 1 : 0, result, winner, board: Array.from(pos.b) };
}

/* ============================================================
 * 1. perft / 基础状态
 * ============================================================ */
{
  console.log('\n== perft / 基础状态');
  ok(X.engineInit() === 0, 'engineInit === 0');
  ok(loadSeq([]), 'engineLoad(空序列)成功');
  const p4 = X.enginePerft(4);
  ok(p4 + X.enginePerftHi() * 4294967296 === 197281, `起始 perft(4) = 197281(实得 ${p4})`);

  X.engineState();
  const js = jsState(newPos());
  const wasmLegal = Array.from(new Int32Array(X.memory.buffer, legalPtr, X.engineLegalCount()));
  ok(JSON.stringify(wasmLegal) === JSON.stringify(js.legal), '起始合法着法表与 JS 一致(20 项)');
  ok(X.engineStm() === js.stm && X.engineCheck() === js.check && X.engineOver() === js.over, '起始 stm/check/over 一致');
  const wasmBoard = Array.from(new Int8Array(X.memory.buffer, boardPtr, 64));
  ok(JSON.stringify(wasmBoard) === JSON.stringify(js.board), '起始棋盘 64 格一致');
  ok(X.engineEvalCp() === evaluate(newPos()), `起始评估逐位一致(${X.engineEvalCp()})`);
  ok(loadSeq([999999]) === false, '非法序列被拒');
}

/* ============================================================
 * 2. 评估逐位对拍:随机游走局面
 * ============================================================ */
{
  console.log('\n== 评估逐位对拍(随机游走 × 6 局,每局 100 手)');
  let seed = 0x1234abcd;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let checked = 0;
  for (let g = 0; g < 6; g++) {
    const pos = newPos();
    const seq = [];
    for (let p = 0; p < 100; p++) {
      // 每个局面:两侧评估必须逐位相等
      ok(loadSeq(seq), `游走 ${g} 第 ${p} 手装载成功`);
      const w = X.engineEvalCp();
      const j = evaluate(pos);
      if (w !== j) {
        ok(false, `游走 ${g} 第 ${p} 手评估不一致:js=${j} wasm=${w}`);
        break;
      }
      checked++;
      // 只在「无升变或升后」的着法里选:线序列经 engineLoad(升变一律升后)
      // 重演必须得到同一局面,士/车升变会造成两边局面分叉(应用层只发升后)
      const cand = [];
      const n0 = genLegal(pos, BUF);
      for (let i = 0; i < n0; i++) {
        const pr = mPromo(BUF[i]);
        if (!pr || pr === QUEEN) cand.push(BUF[i]);
      }
      if (!cand.length) break;
      const m = cand[(rnd() * cand.length) | 0];
      make(pos, m);
      seq.push((mFrom(m) << 6) | mTo(m));
    }
  }
  console.log(`  局面数 ${checked}(含起始),评估全部逐位一致:${fail === 0 ? '✓' : '✗'}`);
}

/* ============================================================
 * 3. state / bind 对拍(借第二组随机游走,顺带核合法着法/终局)
 * ============================================================ */
{
  console.log('\n== state 对拍(合法着法表 / 将军 / 终局)');
  let seed = 0x5eed5eed;
  const rnd = () => { seed = (Math.imul(seed, 22695477) + 1) & 0x7fffffff; return seed / 0x7fffffff; };
  let checked = 0;
  for (let g = 0; g < 4; g++) {
    const pos = newPos();
    const seq = [];
    for (let p = 0; p < 80; p++) {
      const js = jsState(pos);
      ok(loadSeq(seq), `state 游走 ${g} 第 ${p} 手装载成功`);
      X.engineState();
      const wasmLegal = Array.from(new Int32Array(X.memory.buffer, legalPtr, X.engineLegalCount()));
      if (JSON.stringify(wasmLegal) !== JSON.stringify(js.legal)
        || X.engineStm() !== js.stm || X.engineCheck() !== js.check
        || X.engineOver() !== js.over || X.engineResult() !== js.result || X.engineWinner() !== js.winner) {
        ok(false, `state 游走 ${g} 第 ${p} 手不一致`);
        break;
      }
      // bind:每个合法着法都能绑回完整编码
      if (p % 20 === 0) {
        let bindOk = true;
        for (const l of js.legal) {
          const bound = X.engineBind(l >> 6, l & 63);
          if (!bound || mFrom(bound) !== (l >> 6) || mTo(bound) !== (l & 63)) { bindOk = false; break; }
          const pr = mPromo(bound);
          if (pr && pr !== QUEEN) { bindOk = false; break; }
        }
        if (!bindOk) { ok(false, `state 游走 ${g} 第 ${p} 手 bind 失败`); break; }
      }
      checked++;
      if (!js.legal.length) break;
      const line = js.legal[(rnd() * js.legal.length) | 0];
      // 找到与线着法对应的完整编码(JS 侧)
      const n = genLegal(pos, BUF);
      let mv = 0;
      for (let i = 0; i < n; i++) {
        const c = BUF[i];
        if (((mFrom(c) << 6) | mTo(c)) !== line) continue;
        const pr = mPromo(c);
        if (pr && pr !== QUEEN) continue;
        mv = c; break;
      }
      make(pos, mv);
      seq.push(line);
    }
  }
  console.log(`  局面数 ${checked},state/bind 全部一致:${fail === 0 ? '✓' : '✗'}`);
}

/* ============================================================
 * 4. 开局谱库对拍(wasm 二进制 blob vs book.js 参照实现)
 * ============================================================ */
{
  console.log('\n== 开局谱库对拍(随机谱内游走 × 12,候选集逐位一致)');
  const NAMEQ = (sq) => 'abcdefgh'[sq & 7] + (8 - (sq >> 3));
  let seed = 0xb00c5eed;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let plies = 0, candsChecked = 0;

  const wasmCands = (seq) => {
    if (!loadSeq(seq)) throw new Error('谱内游走装载失败');
    const n = X.engineBookCands();
    if (n === 0) return [];
    const raw = new Int32Array(X.memory.buffer, X.engineBookCandPtr(), n * 3);
    return Array.from(raw).reduce((acc, _, i, all) => {
      if (i % 3 === 0) acc.push({ line: all[i], pop: all[i + 1], fam: all[i + 2] });
      return acc;
    }, []);
  };
  const wasmFamName = (fam) => {
    const ptr = X.engineBookFamName(fam);
    if (!ptr) return null;
    const len = X.engineBookFamNameLen();
    return new TextDecoder().decode(new Uint8Array(X.memory.buffer, ptr, len));
  };

  for (let g = 0; g < 12; g++) {
    const pos = newPos();
    const seq = [];
    for (let p = 0; p < 30; p++) {
      const js = bookCandidates(seq.map((l) => NAMEQ(l >> 6) + NAMEQ(l & 63)));
      /* 权重比的是**量化档位**:wasm 不存精确谱线数,存 2 位流行度
       * (1:10:100:1000,n=10 全谱拟合,见 tools/gen-book.mjs);JS 侧按
       * 同一公式把 w 换算成期望档位再比 —— 精确权重则有意不比 */
      const popClass = (w) => Math.max(0, Math.min(3, Math.round(Math.log(w) / Math.log(10))));
      const jsList = (js || []).map((c) => {
        const from = 'abcdefgh'.indexOf(c.move[0]) + (8 - +c.move[1]) * 8;
        const to = 'abcdefgh'.indexOf(c.move[2]) + (8 - +c.move[3]) * 8;
        return { line: (from << 6) | to, pop: popClass(c.w), name: c.name };
      });
      const wasmList = wasmCands(seq);
      if (jsList.length !== wasmList.length) {
        ok(false, `谱库游走 ${g} 第 ${p} 手候选数不一致 js=${jsList.length} wasm=${wasmList.length}`);
        break;
      }
      let bad = false;
      for (let i = 0; i < jsList.length; i++) {
        const j = jsList[i], w = wasmList[i];
        const wName = w.fam < 0 ? null : wasmFamName(w.fam);
        if (j.line !== w.line || j.pop !== w.pop || (j.name || null) !== wName) {
          ok(false, `谱库游走 ${g} 第 ${p} 手第 ${i} 个候选不一致:js=${JSON.stringify(j)} wasm=${JSON.stringify({ ...w, name: wName })}`);
          bad = true;
          break;
        }
      }
      if (bad) break;
      candsChecked += jsList.length;
      if (!jsList.length) break;   // 谱尽
      // 按权重随机走一步(带种子,可复现),JS 侧用规则推进一步
      let sum = 0;
      for (const c of jsList) sum += c.w;
      let t = rnd() * sum;
      let pick = jsList[0];
      for (const c of jsList) { t -= c.w; if (t <= 0) { pick = c; break; } }
      const n2 = genLegal(pos, BUF);
      let mv = 0;
      for (let i = 0; i < n2; i++) {
        const c = BUF[i];
        if (((mFrom(c) << 6) | mTo(c)) !== pick.line) continue;
        const pr = mPromo(c);
        if (pr && pr !== QUEEN) continue;
        mv = c; break;
      }
      if (!mv) { ok(false, `谱库游走 ${g} 第 ${p} 手:谱着 ${pick.line} 不合法(谱数据坏?)`); break; }
      make(pos, mv);
      seq.push(pick.line);
      plies++;
    }
  }
  ok(plies > 100, `谱内游走 ${plies} 手 / 候选 ${candsChecked} 个(覆盖太薄)`);
  console.log(`  游走 ${plies} 手,逐位置候选(line/流行度档/族名)全一致:${fail === 0 ? '✓' : '✗'}`);
}

/* ============================================================
 * 5. 搜索逐位对拍(自对弈,同节点预算;TT 两侧同步演化)
 * ============================================================ */
{
  console.log(`\n== 搜索逐位对拍(自对弈 ${GAMES} 局 × ≤${MAXPLY} 手,${NODES} 节点/手)`);
  ok(X.engineInit() === 0, '对拍前 engineInit 清表');
  let plies = 0;
  for (let g = 0; g < GAMES; g++) {
    const pos = newPos();
    const seq = [];
    for (let p = 0; p < MAXPLY; p++) {
      const r = searchBest(pos, { nodes: NODES, ms: 1e12, depth: 24 });  // ms 超大:JS 时间兜底/早停失效
      if (!r.move) break;                                                // 终局
      if (!loadSeq(seq)) { ok(false, `对局 ${g} 第 ${p} 手装载失败`); break; }
      const wm = X.engineThink(24, NODES, 0, 1);
      const wScore = X.engineScore(), wDepth = X.engineDepth(), wNodes = u32(X.engineNodesLo()) + u32(X.engineNodesHi()) * 4294967296;
      if (wm !== r.move || wScore !== r.score || wDepth !== r.depth || wNodes !== r.nodes) {
        ok(false, `对局 ${g} 第 ${p} 手搜索不一致:js=(${r.move},${r.score},${r.depth},${r.nodes}) wasm=(${wm},${wScore},${wDepth},${wNodes})`);
        break;
      }
      plies++;
      // 引擎极少选士/车升变;发生时按「升变一律升后」重绑,保证两侧局面同源
      let mvApply = r.move;
      if (mPromo(r.move) && mPromo(r.move) !== QUEEN) {
        const n2 = genLegal(pos, BUF);
        for (let i = 0; i < n2; i++) {
          const c = BUF[i];
          if (mFrom(c) !== mFrom(r.move) || mTo(c) !== mTo(r.move)) continue;
          const pr = mPromo(c);
          if (pr && pr !== QUEEN) continue;
          mvApply = c;
          break;
        }
      }
      make(pos, mvApply);
      seq.push((mFrom(mvApply) << 6) | mTo(mvApply));
    }
  }
  console.log(`  共 ${plies} 手,move/score/depth/nodes 全部逐位一致:${fail === 0 ? '✓' : '✗'}`);
}

console.log(`\n探针结果:${pass} 项通过,${fail} 项失败(${WASM})`);
if (fail) process.exit(1);
console.log('✓ wasm 与 JS 参照实现逐位一致');
