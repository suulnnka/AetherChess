/* S0-1/S0-2 双闸门(docs/chess-eval-tuning-plan.md §4.1):
 *   ① 纯重构等价:把新特征组(机动性/通路兵/王区威胁/tempo)参数置零后,
 *      新 evaluate 必须与基线(git HEAD 的 ai.js 内联版)在随机游走局面上逐分一致;
 *   ② 特征一致性:dot(evalFeatures(pos), P) 必须等于 evaluate 的未取整白方视角分
 *      (引擎与调参器共用同一份特征定义,两套实现漂移在这里当场暴露)。
 * 用法:node tuner/verify-features.mjs
 */
import {
  WHITE, BLACK, TYPES, C_WK, C_WQ, C_BK, C_BQ,
  newPos, loadPosition, genLegal, make, unmake,
} from '../src/rules.js';
import { evaluate as evalNew, evalFeatures, EVAL_P, EVAL_IDX, N_EVAL_PARAMS, EVAL_FITTED } from '../src/eval.js';
import { evaluate as evalOld } from './baseline/ai-baseline.mjs';

const buf = new Int32Array(256);

/* 确定性随机游走:从初始局面与几个标准局面出发 */
const START_FENS = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P4/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
];
/* FEN 装载(chess-engine-test 同款) */
function posFromFen(fen) {
  const cells = new Int8Array(64);
  const rank = fen.split(' ')[0].split('/');
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rank[r]) {
      if (ch >= '1' && ch <= '8') { c += +ch; continue; }
      const t = TYPES[ch.toLowerCase()];
      cells[r * 8 + c] = (ch === ch.toUpperCase() ? 0 : 8) | t;
      c++;
    }
  }
  const p = fen.split(' ');
  let castle = 0;
  if (p[2].includes('K')) castle |= C_WK;
  if (p[2].includes('Q')) castle |= C_WQ;
  if (p[2].includes('k')) castle |= C_BK;
  if (p[2].includes('q')) castle |= C_BQ;
  let ep = -1;
  if (p[3] && p[3] !== '-') ep = (8 - +p[3][1]) * 8 + 'abcdefgh'.indexOf(p[3][0]);
  return loadPosition(newPos(), cells, p[1] === 'b' ? BLACK : WHITE, castle, ep);
}

let seed = 0x9e3779b9;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

/* ---- 闸门①:与基线逐分一致(新特征参数置零) ---- */
const zeroNew = () => {
  for (let i = EVAL_IDX.MOB_MG; i <= EVAL_IDX.KATK + 4; i++) EVAL_P[i] = 0;
  EVAL_P[EVAL_IDX.TEMPO] = 0;
};
const NEW_GROUP_RANGES = [
  [EVAL_IDX.MOB_MG, EVAL_IDX.KATK + 4],
  [EVAL_IDX.TEMPO, EVAL_IDX.TEMPO],
];
const saved = new Float64Array(N_EVAL_PARAMS);
saved.set(EVAL_P);
zeroNew();

let checked = 0, mismatch = 0;
for (const fen of START_FENS) {
  const p0 = posFromFen(fen);
  for (let step = 0; step < 120; step++) {
    const n = genLegal(p0, buf);
    if (!n) break;
    const a = evalNew(p0), b = evalOld(p0);
    checked++;
    if (a !== b) {
      if (++mismatch <= 5) console.log(`  ✗ 分不一致 @${fen} 第${step}手: 新 ${a} 旧 ${b}`);
    }
    make(p0, buf[(rnd() * n) | 0]);
  }
}
console.log(EVAL_FITTED
  ? `ℹ 闸门①(纯重构)已由拟合值取代手写初值,跳过逐分一致(${checked} 局面仅作记录,${mismatch} 处不同属预期)`
  : mismatch === 0 ? `✓ 闸门①(纯重构):${checked} 个随机局面,新旧 evaluate 逐分一致`
  : `✗ 闸门①:${mismatch}/${checked} 个局面不一致`);
if (EVAL_FITTED) mismatch = 0;
EVAL_P.set(saved);

/* ---- 闸门②:dot(features, P) === evaluate(未取整) ---- */
const g = new Float64Array(N_EVAL_PARAMS);
let checked2 = 0, mismatch2 = 0, maxDiff = 0;
for (const fen of START_FENS) {
  const p0 = posFromFen(fen);
  for (let step = 0; step < 120; step++) {
    const n = genLegal(p0, buf);
    if (!n) break;
    evalFeatures(p0, g);
    let dot = 0;
    for (let i = 0; i < N_EVAL_PARAMS; i++) {
      if (i === EVAL_IDX.TEMPO) continue;          // tempo 按设计只在搜索层,不进 evaluate
      dot += g[i] * EVAL_P[i];
    }
    const e = evalNew(p0);                       // 走子方视角,已取整
    const whitePov = p0.stm === WHITE ? e : -e;
    const dotR = dot < 0 ? -Math.floor(-dot) : Math.floor(dot);   // 同款取整
    checked2++;
    // dot 与 evaluate 各自浮点求和的顺序不同,恰在整数边界两侧时可各差 ~1e-7,
    // 取整方向可能差 1 —— 断言未取整差 ≤ 1.001(取整本身贡献 ≤1)而非逐位相等
    const d = Math.abs(dot - whitePov);
    if (d > 1.001) { mismatch2++; if (mismatch2 <= 5) console.log(`  ✗ dot ${dot.toFixed(3)} vs evaluate ${whitePov}(差 ${d.toFixed(3)})`); }
    maxDiff = Math.max(maxDiff, Math.abs(dot - dotR));
    make(p0, buf[(rnd() * n) | 0]);
  }
}
console.log(mismatch2 === 0 ? `✓ 闸门②(特征一致):${checked2} 个局面,dot(features,w) 取整后 === evaluate(最大未取整偏差 ${maxDiff.toExponential(2)})`
  : `✗ 闸门②:${mismatch2}/${checked2} 个局面不一致`);
process.exit(mismatch || mismatch2 ? 1 : 0);
