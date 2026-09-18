/* ============================================================
 * A/B 自对弈:拟合版评估 vs 基线(git HEAD)评估(docs/chess-eval-tuning-plan.md §4.4.3 / 阶段 5)
 *
 * 口径:
 *   - 双方同一份搜索代码差异只在评估与 tempo(基线 = tuner/baseline/
 *     ai-baseline.mjs,从 git HEAD 提取;新版 = src/ai.js + eval.js FITTED)。
 *   - 固定节点预算(主约束,确定性),墙上时间给足不参与截断。
 *   - 开局不用手写库:由基线引擎在开局前 8 个回合(16 ply)内按固定种子在
 *     每步 top-3 着法中随机分歧批量生成 —— 开局多样性与被测改动无关。
 *   - 和棋判定:三次重复 / 50 步 / 子力不足 / 320 ply 上限。
 *   - ≥400 局,报得分率与 Elo(95% 区间)。§9.8 实测 76 局分辨率只有 ±127 Elo,
 *     400 局 ±55 左右,才够判这种量级的改动。
 *
 * 用法:node tuner/duel.mjs [局数=400] [节点预算=50000] [worker数=12]
 * ============================================================ */
import { parentPort, workerData } from 'node:worker_threads';
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAMES = Number(process.argv[2] || 400);
const NODES = Number(process.argv[3] || 50000);
const WORKERS = Math.min(Number(process.argv[4] || 12), os.cpus().length - 1);

/* ---------- worker 侧:跑一批对局 ---------- */
if (workerData) {
  const { WHITE, BLACK, TYPES, C_WK, C_WQ, C_BK, C_BQ, newPos, loadPosition,
    genLegal, make, hasLegalMove, inCheck, isRepetition, insufficientMaterial } =
    await import('../src/rules.js');
  const { searchBest: searchBase } = await import(process.env.DUEL_BASE || './baseline/ai-baseline.mjs');
  const { searchBest: searchNew } = await import('../src/ai.js');

  function posFromFen(fen) {
    const parts = fen.split(' ');
    const cells = new Int8Array(64);
    const rank = parts[0].split('/');
    for (let r = 0; r < 8; r++) {
      let c = 0;
      for (const ch of rank[r]) {
        if (ch >= '1' && ch <= '8') { c += +ch; continue; }
        cells[r * 8 + c] = (ch === ch.toUpperCase() ? 0 : 8) | TYPES[ch.toLowerCase()];
        c++;
      }
    }
    let castle = 0;
    if (parts[2].includes('K')) castle |= C_WK;
    if (parts[2].includes('Q')) castle |= C_WQ;
    if (parts[2].includes('k')) castle |= C_BK;
    if (parts[2].includes('q')) castle |= C_BQ;
    let ep = -1;
    if (parts[3] && parts[3] !== '-') ep = (8 - +parts[3][1]) * 8 + 'abcdefgh'.indexOf(parts[3][0]);
    return loadPosition(newPos(), cells, parts[1] === 'b' ? BLACK : WHITE, castle, ep);
  }

  function playGame(gameIdx, openingFen) {
    const newIsWhite = gameIdx % 2 === 0;
    const pos = posFromFen(openingFen);
    const buf = new Int32Array(256);
    let result = null;                                   // 1=白胜, -1=黑胜, 0=和
    for (let ply = 0; ply < 320; ply++) {
      if (!hasLegalMove(pos, buf)) { result = inCheck(pos) ? (pos.stm === WHITE ? -1 : 1) : 0; break; }
      if (ply > 0 && (isRepetition(pos) || pos.half >= 100 || insufficientMaterial(pos))) { result = 0; break; }
      const useNew = (pos.stm === WHITE) === newIsWhite;
      const r = (useNew ? searchNew : searchBase)(pos, { nodes: NODES, ms: 3600000, depth: 24 });
      make(pos, r.move);
    }
    if (result === null) result = 0;
    return newIsWhite ? result : -result;                // 统一为"新版视角":1 胜 / 0 和 / -1 负
  }

  const { openings, gameIdxs } = workerData;
  const out = [];
  for (const g of gameIdxs) {
    const fen = openings[g % openings.length];
    out.push(playGame(g, fen));
    parentPort.postMessage({ done: 1, g, r: out[out.length - 1] });
  }
  process.exit(0);
}

/* ---------- 主线程:生成开局 → 派发 → 汇总 ---------- */
const openingCount = Math.max(25, Math.round(GAMES / 8));
console.log(`A/B 自对弈:${GAMES} 局 × ${NODES.toLocaleString()} 节点/步,${WORKERS} workers`);
console.log('用基线引擎生成开局(16 ply,top-3 随机,固定种子)…');

// 开局生成在 worker 里做太绕,直接在主线程 import 基线引擎跑一次
{
  // 复用 worker 代码:开一个只干开局生成的临时 worker 太复杂,这里内联同款逻辑
  const { WHITE, BLACK, TYPES, CHARS, C_WK, C_WQ, C_BK, C_BQ, newPos, loadPosition, genLegal, make, unmake } =
    await import('../src/rules.js');
  const { searchBest: searchBase } = await import(process.env.DUEL_BASE || './baseline/ai-baseline.mjs');
  const posFromFenLocal = (fen) => {
    const parts = fen.split(' ');
    const cells = new Int8Array(64);
    const rank = parts[0].split('/');
    for (let r = 0; r < 8; r++) {
      let c = 0;
      for (const ch of rank[r]) {
        if (ch >= '1' && ch <= '8') { c += +ch; continue; }
        cells[r * 8 + c] = (ch === ch.toUpperCase() ? 0 : 8) | TYPES[ch.toLowerCase()];
        c++;
      }
    }
    let castle = 0;
    if (parts[2].includes('K')) castle |= C_WK;
    if (parts[2].includes('Q')) castle |= C_WQ;
    if (parts[2].includes('k')) castle |= C_BK;
    if (parts[2].includes('q')) castle |= C_BQ;
    let ep = -1;
    if (parts[3] && parts[3] !== '-') ep = (8 - +parts[3][1]) * 8 + 'abcdefgh'.indexOf(parts[3][0]);
    return loadPosition(newPos(), cells, parts[1] === 'b' ? BLACK : WHITE, castle, ep);
  };
  const toFen = (pos) => {
    let fen = '';
    for (let r = 0; r < 8; r++) {
      let row = '', empty = 0;
      for (let c = 0; c < 8; c++) {
        const p = pos.b[r * 8 + c];
        if (!p) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += (p >> 3) ? CHARS[p & 7] : CHARS[p & 7].toUpperCase();
      }
      if (empty) row += empty;
      fen += (r ? '/' : '') + row;
    }
    let cs = (pos.castle & C_WK ? 'K' : '') + (pos.castle & C_WQ ? 'Q' : '') + (pos.castle & C_BK ? 'k' : '') + (pos.castle & C_BQ ? 'q' : '');
    fen += ` ${pos.stm === WHITE ? 'w' : 'b'} ${cs || '-'} ${pos.ep >= 0 ? 'abcdefgh'[pos.ep & 7] + (8 - (pos.ep >> 3)) : '-'}`;
    return fen;
  };
  const openings = [];
  const buf = new Int32Array(256);
  for (let k = 0; k < openingCount; k++) {
    let s = (Number(process.env.DUEL_SEED) || 0x51ab) + k * 7919;   // 种子可换:整条管线确定性,重跑同种子=复现,异种子=独立样本
    const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const pos = posFromFenLocal('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    for (let p = 0; p < 16; p++) {
      const n = genLegal(pos, buf);
      if (!n) break;
      const cands = [];
      for (let i = 0; i < n; i++) {
        make(pos, buf[i]);
        const r = searchBase(pos, { nodes: 20000, ms: 3600000, depth: 4 });
        unmake(pos, buf[i]);
        cands.push([buf[i], pos.stm === WHITE ? r.score : -r.score]);
      }
      cands.sort((a, b) => b[1] - a[1]);
      const top = cands.slice(0, 3);
      make(pos, top[(rnd() * top.length) | 0][0]);
    }
    openings.push(toFen(pos));
  }
  console.log(`开局 ${openings.length} 个,样例: ${openings[0]}`);

  // 派发
  const gameIdxs = Array.from({ length: GAMES }, (_, i) => i);
  const per = Math.ceil(GAMES / WORKERS);
  const results = new Int8Array(GAMES);
  let received = 0;
  const t0 = Date.now();
  await new Promise((resolve) => {
    let launched = 0;
    for (let w = 0; w < WORKERS; w++) {
      const idxs = gameIdxs.slice(w * per, (w + 1) * per);
      if (!idxs.length) break;
      launched++;
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { openings, gameIdxs: idxs },
        resourceLimits: { stackSizeMb: 64 },
      });
      worker.on('message', ({ g, r }) => {
        results[g] = r;
        received++;
        if (received % 40 === 0) {
          const soFar = Array.from(results.slice(0, received));
          const sc = soFar.reduce((a, v) => a + (v === 1 ? 1 : v === 0 ? 0.5 : 0), 0) / received;
          process.stdout.write(`\r  ${received}/${GAMES} 局,当前得分率 ${(sc * 100).toFixed(1)}%(${((Date.now() - t0) / 1000 / 60).toFixed(1)} min)   `);
        }
        if (received === GAMES) { resolve(); }
      });
      worker.on('error', (e) => { console.error('worker error', e); process.exit(1); });
    }
    if (received === GAMES) resolve();
  });

  // 汇总
  let win = 0, draw = 0, loss = 0;
  for (const r of results) { if (r === 1) win++; else if (r === 0) draw++; else loss++; }
  const N = GAMES;
  const score = (win + draw * 0.5) / N;
  // Elo 与 95% 区间(Wald,逐局得分 0/0.5/1)
  const mean = score;
  let varr = 0;
  for (const r of results) { const x = r === 1 ? 1 : r === 0 ? 0.5 : 0; varr += (x - mean) ** 2; }
  const se = Math.sqrt(varr / (N - 1) / N);
  const elo = mean > 0 && mean < 1 ? 400 * Math.log10(mean / (1 - mean)) : Infinity;
  const lo = Math.max(0.0005, mean - 1.96 * se), hi = Math.min(0.9995, mean + 1.96 * se);
  const eloLo = 400 * Math.log10(lo / (1 - lo)), eloHi = 400 * Math.log10(hi / (1 - hi));
  console.log(`\n\n=== 结果(新版视角)===`);
  console.log(`${win} 胜 / ${draw} 和 / ${loss} 负 = 得分率 ${(score * 100).toFixed(1)}%`);
  console.log(`Elo 差 ${elo >= 0 ? '+' : ''}${elo.toFixed(0)}(95% CI ${eloLo.toFixed(0)} ~ ${eloHi.toFixed(0)}),用时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
  process.exit(0);
}
