/* ============================================================
 * Texel 式 RL 拟合:自对弈胜负标签 → sigmoid(评估/K) ≈ 实际得分
 *
 * 与 fit-eval.mjs(SF 蒸馏)的区别:
 *   - 标签:每局 1 个胜负/和(白方视角),挂在全局的安静局面上(局内相关,
 *     所以 train/val 按"局"切,不按局面切);
 *   - 损失:Σ(σ(s/K) − r)²,K=300cp —— 非线性,用 Gauss-Newton 迭代,
 *     每轮仍是稀疏正规方程闭式解 (GᵀD²G+λI)δ = −GᵀDe + λ(w₀−w);
 *   - 子力 10 参数**放开**(自对弈数据没有 lichess 分析库的选择偏差);
 *   - 防御照旧:钉参考格/恒零格、覆盖度闸门、向先验收缩(先验=当前 FITTED)、
 *     棋理必正参数(含子力)的符号投影。
 *
 * 用法:node tuner/fit-texel.mjs [K=300]
 * 输出:data/fitted-rl-params.json / .js.txt + 控制台报告
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WHITE, BLACK, TYPES, C_WK, C_WQ, C_BK, C_BQ, newPos, loadPosition,
} from '../src/rules.js';
import { evalFeatures, EVAL_P, EVAL_IDX, N_EVAL_PARAMS } from '../src/eval.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'data', 'selfplay.jsonl');
const K = Number(process.argv[2] || 300);
const MIN_COVER = 200;
const GN_ITERS = 25;

/* ---------- 钉参考格与恒零格(与 eval.js 布局一一对应,同 fit-eval) ---------- */
const hsq = (t) => (t >> 3) * 4 + Math.min(t & 7, 7 - (t & 7));
const PINNED = new Set([
  EVAL_IDX.PST_MG_PAWN + 6 * 8 + 0, EVAL_IDX.PST_EG_PAWN + hsq(6 * 8 + 0),
  EVAL_IDX.PST_MG_KNIGHT + hsq(7 * 8 + 0), EVAL_IDX.PST_EG_KNIGHT + hsq(7 * 8 + 0),
  EVAL_IDX.PST_MG_BISHOP + hsq(7 * 8 + 0), EVAL_IDX.PST_EG_BISHOP + hsq(7 * 8 + 0),
  EVAL_IDX.PST_MG_ROOK + hsq(7 * 8 + 0), EVAL_IDX.PST_EG_ROOK + hsq(7 * 8 + 0),
  EVAL_IDX.PST_MG_QUEEN + hsq(7 * 8 + 0), EVAL_IDX.PST_EG_QUEEN + hsq(7 * 8 + 0),
]);
for (let t = 0; t < 8; t++) PINNED.add(EVAL_IDX.PST_MG_PAWN + t);
for (let t = 56; t < 64; t++) PINNED.add(EVAL_IDX.PST_MG_PAWN + t);
for (const r of [0, 7]) for (let f = 0; f < 4; f++) PINNED.add(EVAL_IDX.PST_EG_PAWN + r * 4 + f);

const isPst = (i) => i >= EVAL_IDX.PST_MG_PAWN && i < EVAL_IDX.PST_EG_KING + 32;

/* ---------- 先验 = 当前引擎参数(规范基) ---------- */
const w0 = new Float64Array(N_EVAL_PARAMS);
w0.set(EVAL_P);

/* ---------- 装载:局面 → 稀疏特征(一次),按局 80/20 切 ---------- */
function posFromFen(pos, fen) {
  const parts = fen.split(' ');
  const cells = new Int8Array(64);
  const rank = parts[0].split('/');
  let kings = 0;
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rank[r]) {
      if (ch >= '1' && ch <= '8') { c += +ch; continue; }
      const t = TYPES[ch.toLowerCase()];
      if (!t) return null;
      if (t === 6) kings++;
      cells[r * 8 + c] = (ch === ch.toUpperCase() ? 0 : 8) | t;
      c++;
    }
  }
  if (kings !== 2) return null;
  let castle = 0;
  if (parts[2].includes('K')) castle |= C_WK;
  if (parts[2].includes('Q')) castle |= C_WQ;
  if (parts[2].includes('k')) castle |= C_BK;
  if (parts[2].includes('q')) castle |= C_BQ;
  let ep = -1;
  if (parts[3] && parts[3] !== '-') ep = (8 - +parts[3][1]) * 8 + 'abcdefgh'.indexOf(parts[3][0]);
  return loadPosition(pos, cells, parts[1] === 'b' ? BLACK : WHITE, castle, ep);
}

const pos = newPos();
const gBuf = new Float64Array(N_EVAL_PARAMS);
const train = [], val = [];
let games = new Set(), rows = 0, badRows = 0;
const cover = new Int32Array(N_EVAL_PARAMS);
console.log('装载自对弈样本 …');
for (const line of fs.readFileSync(SRC, 'utf8').split('\n')) {
  if (!line) continue;
  let o;
  try { o = JSON.parse(line); } catch { badRows++; continue; }
  games.add(o.g);
  if (!posFromFen(pos, o.fen)) { badRows++; continue; }
  evalFeatures(pos, gBuf);
  const idx = [], v = [];
  for (let i = 0; i < N_EVAL_PARAMS; i++) {
    if (gBuf[i] !== 0) { idx.push(i); v.push(gBuf[i]); if (o.g % 10 < 8) cover[i]++; }
  }
  const row = { idx: Int32Array.from(idx), val: Float64Array.from(v), r: o.r };
  (o.g % 10 < 8 ? train : val).push(row);
  rows++;
}
console.log(`样本 ${rows.toLocaleString()} 行(train ${train.length.toLocaleString()} / val ${val.length.toLocaleString()},按局切),局 ${games.size},坏行 ${badRows}`);
if (val.length < 1000) { console.error('✗ val 样本过少'); process.exit(1); }

/* ---------- 覆盖度闸门(PST <200 次冻结先验;子力这次放开) ---------- */
const frozen = new Uint8Array(N_EVAL_PARAMS);
let nFrozen = 0;
for (let i = 0; i < N_EVAL_PARAMS; i++) {
  if (PINNED.has(i)) continue;
  if (isPst(i) && cover[i] < MIN_COVER) { frozen[i] = 1; nFrozen++; }
}
console.log(`覆盖度闸门:冻结 PST ${nFrozen} 个,钉格/恒零 ${PINNED.size} 个;子力 10 个这次放开`);

let freeIdx = [], F = 0;
const freeMap = new Int32Array(N_EVAL_PARAMS).fill(-1);
function rebuildFree() {
  freeIdx = [];
  for (let i = 0; i < N_EVAL_PARAMS; i++) if (!PINNED.has(i) && !frozen[i]) freeIdx.push(i);
  F = freeIdx.length;
  freeMap.fill(-1);
  freeIdx.forEach((v, k) => { freeMap[v] = k; });
}
rebuildFree();
console.log(`自由参数 ${F} 个(共 ${N_EVAL_PARAMS})`);

/* ---------- 预测/指标 ---------- */
const sig = (x) => 1 / (1 + Math.exp(-x));
function fullW(wFree) {
  const w = new Float64Array(N_EVAL_PARAMS);
  for (let i = 0; i < N_EVAL_PARAMS; i++) {
    if (PINNED.has(i)) w[i] = 0;
    else if (frozen[i]) w[i] = w0[i];
    else w[i] = wFree[freeMap[i]];
  }
  return w;
}
function mseOf(rowsArr, wFull) {
  let se = 0;
  for (const row of rowsArr) {
    let s = 0;
    for (let k = 0; k < row.idx.length; k++) s += wFull[row.idx[k]] * row.val[k];
    const d = sig(s / K) - row.r;
    se += d * d;
  }
  return se / rowsArr.length;
}

/* ---------- Cholesky ---------- */
function solveChol(M, rhs, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = M[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) { if (s <= 1e-12) return null; L[i * n + j] = Math.sqrt(s); }
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  const z = new Float64Array(n), x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = rhs[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * z[k];
    z[i] = s / L[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

/* ---------- Gauss-GN(向先验收缩)。返回自由参数向量 ---------- */
function runGN(lambda) {
  const w = new Float64Array(F);
  for (let ii = 0; ii < F; ii++) w[ii] = w0[freeIdx[ii]];
  let wf = fullW(w);
  let converged = false;
  for (let it = 0; it < GN_ITERS && !converged; it++) {
    const M = new Float64Array(F * F);
    const rhs = new Float64Array(F);
    for (const row of train) {
      let s = 0;
      for (let k = 0; k < row.idx.length; k++) s += wf[row.idx[k]] * row.val[k];
      const p = sig(s / K);
      const d = p * (1 - p) / K;
      if (d < 1e-7) continue;                       // 饱和行梯度可忽略
      const e = p - row.r;
      const dd = d * d, de = d * e;
      const nzI = [], nzV = [];
      for (let a = 0; a < row.idx.length; a++) {
        const fi = freeMap[row.idx[a]];
        if (fi >= 0) { nzI.push(fi); nzV.push(row.val[a]); }
      }
      for (let a = 0; a < nzI.length; a++) {
        const i = nzI[a], gi = nzV[a] * dd, rowM = i * F;
        for (let b = 0; b < nzI.length; b++) M[rowM + nzI[b]] += gi * nzV[b];
        rhs[i] -= nzV[a] * de;
      }
    }
    for (let ii = 0; ii < F; ii++) {
      M[ii * F + ii] += lambda;
      rhs[ii] -= lambda * (w[ii] - w0[freeIdx[ii]]);
    }
    const delta = solveChol(M, rhs, F);
    if (!delta) return { wFree: w, converged: false };
    let step2 = 0;
    for (let ii = 0; ii < F; ii++) { w[ii] += delta[ii]; step2 += delta[ii] * delta[ii]; }
    wf = fullW(w);
    if (step2 < 1e-6 * F) converged = true;
  }
  return { wFree: w, converged };
}

/* ---------- 基线(当前参数)指标 ---------- */
const baseVal = mseOf(val, w0), baseTrain = mseOf(train, w0);
console.log(`\n先验(当前引擎)val MSE ${baseVal.toFixed(6)} / train ${baseTrain.toFixed(6)}(sigmoid 空间)`);

/* ---------- λ 扫描 ---------- */
const GRID = [0.03, 0.1, 0.3, 1, 3, 10, 30, 100, 300];
console.log(`\nλ 扫描(GN ≤${GN_ITERS} 轮):`);
let best = null;
for (const lambda of GRID) {
  const { wFree, converged } = runGN(lambda);
  const m = mseOf(val, fullW(wFree));
  console.log(`  λ=${String(lambda).padStart(6)}  val MSE ${m.toFixed(6)}  ${converged ? '(收敛)' : '(迭代上限)'}`);
  if (!best || m < best.m) best = { lambda, m, wFree };
}
/* 平局偏好大 λ(≤0.5% 损失换稳定) */
for (const lambda of [...GRID].reverse()) {
  if (lambda <= best.lambda) break;
  const { wFree } = runGN(lambda);
  const m = mseOf(val, fullW(wFree));
  if (m <= best.m * 1.005) { console.log(`平局偏好:λ ${best.lambda} → ${lambda}`); best = { lambda, m, wFree }; break; }
}
console.log(`选定 λ=${best.lambda}(val MSE ${best.m.toFixed(6)})`);

/* ---------- 符号投影(棋理必正 + 子力必正) ---------- */
const POS_SET = [];
for (const base of [EVAL_IDX.MOB_MG, EVAL_IDX.MOB_EG]) for (let k = 0; k < 4; k++) POS_SET.push(base + k);
for (const base of [EVAL_IDX.PASSED_MG, EVAL_IDX.PASSED_EG]) for (let k = 0; k < 6; k++) POS_SET.push(base + k);
for (let k = 0; k < 5; k++) POS_SET.push(EVAL_IDX.KATK + k);
POS_SET.push(EVAL_IDX.TEMPO, EVAL_IDX.PAIR_MG, EVAL_IDX.PAIR_EG,
  EVAL_IDX.DOUBLED_MG, EVAL_IDX.DOUBLED_EG, EVAL_IDX.ISOLATED_MG, EVAL_IDX.ISOLATED_EG, EVAL_IDX.SHIELD_MG);
for (let i = 0; i < 10; i++) POS_SET.push(i);       // 子力 0..9

let nProjected = 0;
for (let round = 0; round < 4; round++) {
  const { wFree } = runGN(best.lambda);
  const wf = fullW(wFree);
  const bad = POS_SET.filter((i) => !PINNED.has(i) && !frozen[i] && wf[i] <= 0);
  if (!bad.length) { best.wFree = wFree; break; }
  for (const i of bad) { frozen[i] = 1; nFrozen++; nProjected++; }
  rebuildFree();
  console.log(`投影第 ${round + 1} 轮:${bad.length} 个非正参数冻结回先验,重拟合(自由 ${F})`);
  const redo = runGN(best.lambda);
  best.wFree = redo.wFree;
}

const wFinal = fullW(best.wFree);
const finVal = mseOf(val, wFinal);
console.log(`投影后 val MSE ${finVal.toFixed(6)}(先验 ${baseVal.toFixed(6)})`);

/* ---------- 报告 ---------- */
const S = EVAL_IDX;
console.log('\n=== 参数变化(先验 → RL)===');
console.log(`  子力 MG P/N/B/R/Q  ${[0, 1, 2, 3, 4].map((i) => w0[S.VAL_MG + i]).join('/')}  →  ${[0, 1, 2, 3, 4].map((i) => wFinal[S.VAL_MG + i].toFixed(0)).join('/')}`);
console.log(`  子力 EG P/N/B/R/Q  ${[0, 1, 2, 3, 4].map((i) => w0[S.VAL_EG + i]).join('/')}  →  ${[0, 1, 2, 3, 4].map((i) => wFinal[S.VAL_EG + i].toFixed(0)).join('/')}`);
console.log(`  tempo              ${w0[S.TEMPO]} → ${wFinal[S.TEMPO].toFixed(0)}`);
console.log(`  双象 MG/EG         ${w0[S.PAIR_MG]}/${w0[S.PAIR_EG]} → ${wFinal[S.PAIR_MG].toFixed(0)}/${wFinal[S.PAIR_EG].toFixed(0)}`);
console.log(`  叠兵罚 MG/EG       ${w0[S.DOUBLED_MG]}/${w0[S.DOUBLED_EG]} → ${wFinal[S.DOUBLED_MG].toFixed(0)}/${wFinal[S.DOUBLED_EG].toFixed(0)}`);
console.log(`  孤立兵罚 MG/EG     ${w0[S.ISOLATED_MG]}/${w0[S.ISOLATED_EG]} → ${wFinal[S.ISOLATED_MG].toFixed(0)}/${wFinal[S.ISOLATED_EG].toFixed(0)}`);
console.log(`  机动性 MG N/B/R/Q  ${[0, 1, 2, 3].map((i) => w0[S.MOB_MG + i]).join('/')} → ${[0, 1, 2, 3].map((i) => wFinal[S.MOB_MG + i].toFixed(1)).join('/')}`);
console.log(`  机动性 EG N/B/R/Q  ${[0, 1, 2, 3].map((i) => w0[S.MOB_EG + i]).join('/')} → ${[0, 1, 2, 3].map((i) => wFinal[S.MOB_EG + i].toFixed(1)).join('/')}`);
console.log(`  通路兵 EG 2..7     ${[0, 1, 2, 3, 4, 5].map((i) => w0[S.PASSED_EG + i]).join('/')} → ${[0, 1, 2, 3, 4, 5].map((i) => wFinal[S.PASSED_EG + i].toFixed(0)).join('/')}`);
{
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < N_EVAL_PARAMS; i++) {
    if (PINNED.has(i) || frozen[i]) continue;
    sxy += wFinal[i] * w0[i]; sxx += w0[i] * w0[i]; syy += wFinal[i] * wFinal[i];
  }
  console.log(`  全参数与先验的相关 r = ${(sxy / Math.sqrt(sxx * syy)).toFixed(4)}`);
}
const signFail = POS_SET.filter((i) => wFinal[i] <= 0 && !PINNED.has(i));
console.log(signFail.length ? `⚠ 符号异常(冻结于先验,应为正):${signFail.join(',')}` : '✓ 符号全部符合预期');

/* ---------- 输出(取整) ---------- */
const wOut = new Float64Array(N_EVAL_PARAMS);
for (let i = 0; i < N_EVAL_PARAMS; i++) wOut[i] = Math.round(wFinal[i]);
const finValR = mseOf(val, wOut);
const out = {
  meta: {
    date: new Date().toISOString(), K, lambda: best.lambda, games: games.size,
    rows: rows, trainRows: train.length, valRows: val.length,
    valMsePrior: baseVal, valMse: finVal, valMseRounded: finValR,
    freeParams: F, frozen: nFrozen, projected: nProjected,
    mode: 'texel sigmoid RL on self-play, prior-shrink GN, positivity projected',
  },
  params: Array.from(wOut),
};
fs.writeFileSync(path.join(HERE, 'data', 'fitted-rl-params.json'), JSON.stringify(out));
const literal = `// 由 tuner/fit-texel.mjs 生成(${out.meta.date})
// ${out.meta.mode};K=${K},λ=${best.lambda},自对弈 ${games.size} 局 ${rows.toLocaleString()} 安静局面
// val MSE(sigmoid) ${baseVal.toFixed(6)} → ${finValR.toFixed(6)}
const FITTED = [
${Array.from(wOut).map((v) => `${v},`).join('')}
];`;
fs.writeFileSync(path.join(HERE, 'data', 'fitted-rl-params.js.txt'), literal);
console.log(`\n取整后 val MSE ${finValR.toFixed(6)};已写出 data/fitted-rl-params.json / .js.txt`);
if (signFail.filter((i) => !frozen[i]).length) { console.error('✗ 存在未冻结的符号异常'); process.exit(1); }
