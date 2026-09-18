/* ============================================================
 * 评估参数训练器(闭式 ridge,docs/chess-eval-tuning-plan.md §2/§3/§4.4)
 *
 * 模型:y(白方视角 SF cp,|cp|>2000 裁到 2000,mate 行不参与拟合)
 *      y ≈ Σ_k w_k · g_k(pos),g = evalFeatures(pos)(引擎同源)
 * 闭式解:w = (ΦᵀΦ + λI)⁻¹ Φᵀ(y − 冻结项偏移)
 *
 * 可辨识性处理(§1.2 / §3.3):
 *   - 每子类×相位钉一个可达参考格(系数恒 0):兵 a2、轻/重子 a1;
 *     手写初值先做规范变换(VAL += w[ref],表值 −= w[ref])再进拟合,
 *     evaluate 数值不变。
 *   - 兵第 1/8 横线恒 0;训练集出现 <200 次的 PST 格冻结在手写初值
 *     (贡献从 y 里扣掉,不参与求解)。
 * λ 在 val 上扫网格取 MSE 最小;最终做尺度锚定(VAL_MG[兵]=100)
 * 并取整,输出可直接替换 eval.js 的 FITTED 字面量。
 *
 * 用法:node tuner/fit-eval.mjs [--max-rows N]
 * 输出:data/fitted-params.json + data/fitted-params.js.txt + 控制台报告
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WHITE, BLACK, TYPES, C_WK, C_WQ, C_BK, C_BQ,
  newPos, loadPosition,
} from '../src/rules.js';
import { evalFeatures, EVAL_P, EVAL_IDX, N_EVAL_PARAMS } from '../src/eval.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRAIN = path.join(HERE, 'data', 'train.jsonl');
const VAL = path.join(HERE, 'data', 'val.jsonl');
const MAX_ROWS = Number(process.argv.includes('--max-rows')
  ? process.argv[process.argv.indexOf('--max-rows') + 1] : Infinity);
const MIN_COVER = 200;
const CLIP = 2000;

/* ---------- 钉参考格与恒零格(与 eval.js 布局一一对应) ---------- */
const hsq = (t) => (t >> 3) * 4 + Math.min(t & 7, 7 - (t & 7));
const PINS = {
  [EVAL_IDX.VAL_MG + 0]: [EVAL_IDX.PST_MG_PAWN + 6 * 8 + 0],      // 兵 MG:白方视角 a2
  [EVAL_IDX.VAL_EG + 0]: [EVAL_IDX.PST_EG_PAWN + hsq(6 * 8 + 0)],
  [EVAL_IDX.VAL_MG + 1]: [EVAL_IDX.PST_MG_KNIGHT + hsq(7 * 8 + 0)],  // a1
  [EVAL_IDX.VAL_EG + 1]: [EVAL_IDX.PST_EG_KNIGHT + hsq(7 * 8 + 0)],
  [EVAL_IDX.VAL_MG + 2]: [EVAL_IDX.PST_MG_BISHOP + hsq(7 * 8 + 0)],
  [EVAL_IDX.VAL_EG + 2]: [EVAL_IDX.PST_EG_BISHOP + hsq(7 * 8 + 0)],
  [EVAL_IDX.VAL_MG + 3]: [EVAL_IDX.PST_MG_ROOK + hsq(7 * 8 + 0)],
  [EVAL_IDX.VAL_EG + 3]: [EVAL_IDX.PST_EG_ROOK + hsq(7 * 8 + 0)],
  [EVAL_IDX.VAL_MG + 4]: [EVAL_IDX.PST_MG_QUEEN + hsq(7 * 8 + 0)],
  [EVAL_IDX.VAL_EG + 4]: [EVAL_IDX.PST_EG_QUEEN + hsq(7 * 8 + 0)],
};
/* 兵第 1/8 横线不可达(MG 全表 16 格;EG 半表每横线 4 格 ×2 = 8) */
const UNREACHABLE = [];
for (let t = 0; t < 8; t++) UNREACHABLE.push(EVAL_IDX.PST_MG_PAWN + t);
for (let t = 56; t < 64; t++) UNREACHABLE.push(EVAL_IDX.PST_MG_PAWN + t);
for (const r of [0, 7]) for (let f = 0; f < 4; f++) UNREACHABLE.push(EVAL_IDX.PST_EG_PAWN + r * 4 + f);
const PINNED = new Set(UNREACHABLE);
for (const [valIdx, refs] of Object.entries(PINS)) for (const r of refs) PINNED.add(r);

/* ---------- 手写初值 → 钉参考格的规范基(VAL += w[ref],表 −= w[ref]) ---------- */
const w0 = new Float64Array(N_EVAL_PARAMS);
w0.set(EVAL_P);
for (const [valIdxStr, refs] of Object.entries(PINS)) {
  const valIdx = +valIdxStr, ref = refs[0];
  const shift = w0[ref];
  w0[valIdx] += shift;
  // 同组 PST 全部平移(组 = 从 ref 往后同一张表:同表区间由 ref 所在组推断)
  const [lo, hi] = pstRangeOf(ref);
  for (let i = lo; i <= hi; i++) w0[i] -= shift;
  w0[ref] = 0;
}
function pstRangeOf(idx) {
  const R = [
    [EVAL_IDX.PST_MG_PAWN, 64], [EVAL_IDX.PST_MG_KNIGHT, 32], [EVAL_IDX.PST_MG_BISHOP, 32],
    [EVAL_IDX.PST_MG_ROOK, 32], [EVAL_IDX.PST_MG_QUEEN, 32], [EVAL_IDX.PST_MG_KING, 64],
    [EVAL_IDX.PST_EG_PAWN, 32], [EVAL_IDX.PST_EG_KNIGHT, 32], [EVAL_IDX.PST_EG_BISHOP, 32],
    [EVAL_IDX.PST_EG_ROOK, 32], [EVAL_IDX.PST_EG_QUEEN, 32], [EVAL_IDX.PST_EG_KING, 32],
  ];
  for (const [base, len] of R) if (idx >= base && idx < base + len) return [base, base + len - 1];
  throw new Error('非 PST 下标 ' + idx);
}

/* ---------- FEN → pos(4 字段 lichess 格式) ---------- */
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

/* ---------- 数据装载:一次算特征,val 存稀疏,train 直接累积正规方程 ---------- */
const A = new Float64Array(N_EVAL_PARAMS * N_EVAL_PARAMS);   // ΦᵀΦ
const b = new Float64Array(N_EVAL_PARAMS);                    // Φᵀy
const cover = new Int32Array(N_EVAL_PARAMS);                  // 出现次数(|g|>0)
const pawnFreq = new Float64Array(64);                        // 兵格经验频率(白方视角,两色合并)
const pos = newPos();
const g = new Float64Array(N_EVAL_PARAMS);
const nz = new Int32Array(N_EVAL_PARAMS);

let trainRows = 0, mateRows = 0, clipped = 0, badRows = 0, ySum = 0, ySum2 = 0, wSum = 0;
console.log('扫描 train …');
/* 失衡行降权:lichess 分析库的选择偏差(实测)——失衡局面几乎全是弃兵/弃子
 * 且有补偿的局面(差一后的行平均标签仅 −150~−400,相位 24 亏一兵平均 +32),
 * 直接拟合会系统性低估子力(纯 OLS 把后 MG 拟成 ~34,开局减后只差 −174)。
 * 子力项已冻结手写值,这里再把失衡行按经典子力差降权,压低位置项的同类污染。 */
const HAND_VAL_MG = [100, 320, 330, 500, 900];
for (const line of fs.readFileSync(TRAIN, 'utf8').split('\n')) {
  if (!line) continue;
  if (trainRows >= MAX_ROWS) break;
  let o;
  try { o = JSON.parse(line); } catch { badRows++; continue; }
  if (o.mate !== undefined) { mateRows++; continue; }
  if (!posFromFen(pos, o.fen)) { badRows++; continue; }
  let y = o.cp;
  if (Math.abs(y) > CLIP) { y = y > 0 ? CLIP : -CLIP; clipped++; }
  evalFeatures(pos, g);
  let nnz = 0;
  for (let i = 0; i < N_EVAL_PARAMS; i++) if (g[i] !== 0) nz[nnz++] = i;
  // 经典子力差:g[VAL_MG+i] + g[VAL_EG+i] = Δcount_i(相位权重相加恰为 1)
  let matCp = 0;
  for (let i = 0; i < 5; i++) matCp += HAND_VAL_MG[i] * (g[EVAL_IDX.VAL_MG + i] + g[EVAL_IDX.VAL_EG + i]);
  const wRow = 1 / (1 + (matCp / 400) ** 2);
  wSum += wRow;
  for (let k = 0; k < nnz; k++) {
    const i = nz[k], gi = g[i] * wRow;
    cover[i]++;
    if (i >= EVAL_IDX.PST_MG_PAWN && i < EVAL_IDX.PST_MG_PAWN + 64) pawnFreq[i - EVAL_IDX.PST_MG_PAWN] += Math.abs(g[i]);
    const row = i * N_EVAL_PARAMS;
    for (let j = 0; j < nnz; j++) A[row + nz[j]] += gi * g[nz[j]] * wRow;
    b[i] += gi * y;
  }
  ySum += y; ySum2 += y * y;
  trainRows++;
}
console.log(`train 拟合行 ${trainRows.toLocaleString()}(降权后等效 ${Math.round(wSum).toLocaleString()}),mate 另计 ${mateRows.toLocaleString()},裁剪 ${clipped.toLocaleString()},坏行 ${badRows}`);
const yMean = ySum / trainRows, yVar = ySum2 / trainRows - yMean * yMean;

console.log('扫描 val(存稀疏特征)…');
const valRows = [];
let valMate = 0;
for (const line of fs.readFileSync(VAL, 'utf8').split('\n')) {
  if (!line) continue;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  if (!posFromFen(pos, o.fen)) continue;
  evalFeatures(pos, g);
  const idx = [], val = [];
  for (let i = 0; i < N_EVAL_PARAMS; i++) if (g[i] !== 0) { idx.push(i); val.push(g[i]); }
  if (o.mate !== undefined) { valMate++; valRows.push({ idx: Int32Array.from(idx), val: Float64Array.from(val), y: null, mate: Math.sign(o.mate) }); continue; }
  let y = o.cp;
  if (Math.abs(y) > CLIP) y = y > 0 ? CLIP : -CLIP;
  valRows.push({ idx: Int32Array.from(idx), val: Float64Array.from(val), y, mate: 0 });
}
const valFit = valRows.filter((r) => r.y !== null);
console.log(`val 拟合行 ${valFit.length.toLocaleString()},mate 对照行 ${valMate}`);

/* ---------- 覆盖度闸门:< MIN_COVER 次的 PST 格冻结在手写初值 ----------
 * 另:子力 10 参数一并冻结 —— lichess 分析库的失衡行全是"有补偿"的局面,
 * 子力值在这份数据上没有无偏估计(见扫描 train 处注释),保持手写值。 */
const frozen = new Uint8Array(N_EVAL_PARAMS);
let nFrozen = 0;
for (let i = 0; i < N_EVAL_PARAMS; i++) {
  if (PINNED.has(i)) continue;
  const isPst = pstRangeOfSafe(i);
  if (i < 10 || (isPst && cover[i] < MIN_COVER)) { frozen[i] = 1; nFrozen++; }
}
function pstRangeOfSafe(idx) {
  try { pstRangeOf(idx); return true; } catch { return false; }
}
// 冻结项贡献从 y(等价地从 Φᵀy)里扣掉:y' = y − Σ w0·g
const bAdj = Float64Array.from(b);
function freezeAtPrior(i) {
  if (frozen[i]) return;
  frozen[i] = 1; nFrozen++;
  if (w0[i]) {
    const row = i * N_EVAL_PARAMS;
    for (let j = 0; j < N_EVAL_PARAMS; j++) bAdj[j] -= w0[i] * A[row + j];
  }
}
for (let i = 0; i < N_EVAL_PARAMS; i++) if (frozen[i]) {
  frozen[i] = 0; nFrozen--;
  freezeAtPrior(i);      // 复用同一偏移逻辑(等价于原内联版本)
}
console.log(`覆盖度闸门:冻结 ${nFrozen} 个参数(子力 10 个 + PST 出现 <${MIN_COVER} 次的格,保持手写初值),钉参考格+恒零格 ${PINNED.size} 个`);

/* ---------- 自由参数与求解(Cholesky) ---------- */
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

function solveRidge(lambda) {
  const M = new Float64Array(F * F);
  for (let ii = 0; ii < F; ii++) {
    const i = freeIdx[ii], row = i * N_EVAL_PARAMS;
    for (let jj = 0; jj < F; jj++) M[ii * F + jj] = A[row + freeIdx[jj]];
    M[ii * F + ii] += lambda;
  }
  /* 向手写先验收缩(不是向零):min ‖y−Φw‖² + λ‖w−w₀‖² ⇒ rhs = Φᵀy_off + λ·w₀。
   * 为什么必须这样做:钉参考格只消掉零空间方向,但参考格本身(如后 a1)在数据里
   * 几乎不出现,"VAL 与 PST 的水平拆分"缺乏支撑 —— 纯 OLS 实测把后 MG 拟成
   * 34+巨大 PST(开局减后只差 −174),外推到搜索会碰到的弃子局面是灾难。
   * 向手写先验收缩把参数保持在手写量级附近,数据强的方向仍可大幅移动。 */
  const rhs = new Float64Array(F);
  for (let ii = 0; ii < F; ii++) rhs[ii] = bAdj[freeIdx[ii]] + lambda * w0[freeIdx[ii]];
  // Cholesky(λ>0 ⇒ 正定)
  const L = new Float64Array(F * F);
  for (let i = 0; i < F; i++) {
    for (let j = 0; j <= i; j++) {
      let s = M[i * F + j];
      for (let k = 0; k < j; k++) s -= L[i * F + k] * L[j * F + k];
      if (i === j) {
        if (s <= 0) return null;
        L[i * F + j] = Math.sqrt(s);
      } else L[i * F + j] = s / L[j * F + j];
    }
  }
  const z = new Float64Array(F), w = new Float64Array(F);
  for (let i = 0; i < F; i++) {
    let s = rhs[i];
    for (let k = 0; k < i; k++) s -= L[i * F + k] * z[k];
    z[i] = s / L[i * F + i];
  }
  for (let i = F - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < F; k++) s -= L[k * F + i] * w[k];
    w[i] = s / L[i * F + i];
  }
  return w;
}

function valMse(w) {
  let se = 0, n = 0;
  for (const r of valFit) {
    let p = 0;
    for (let k = 0; k < r.idx.length; k++) {
      const i = r.idx[k];
      let wi = 0;
      if (!PINNED.has(i)) {
        if (frozen[i]) wi = w0[i];
        else wi = w[freeMap[i]];
      }
      p += wi * r.val[k];
    }
    const d = p - r.y;
    se += d * d; n++;
  }
  return { mse: se / n, r2: 1 - (se / n) / valVar };
}

/* val 方差 */
let vSum = 0, vSum2 = 0;
for (const r of valFit) { vSum += r.y; vSum2 += r.y * r.y; }
const valVar = vSum2 / valFit.length - (vSum / valFit.length) ** 2;

/* ---------- λ 扫描(向先验收缩的 λ 有意义区间在对角量级附近) ---------- */
const meanDiag = (() => { let s = 0; for (let k = 0; k < F; k++) s += A[freeIdx[k] * N_EVAL_PARAMS + freeIdx[k]]; return s / F; })();
const GRID = [0.0001, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1, 3, 10].map((x) => x * meanDiag);
console.log(`\nλ 扫描(自由参数对角均值 ${meanDiag.toFixed(1)}):`);
let best = null;
const sweep = [];
for (const lambda of GRID) {
  const w = solveRidge(lambda);
  if (!w) { console.log(`  λ=${lambda.toFixed(1)} 求解失败`); continue; }
  const { mse, r2 } = valMse(w);
  sweep.push({ lambda, mse, r2 });
  console.log(`  λ=${lambda.toFixed(0).padStart(9)}  val MSE ${mse.toFixed(1)}  R² ${r2.toFixed(4)}`);
  if (!best || mse < best.mse) best = { lambda, mse, r2, w };
}
if (!best) { console.error('全部 λ 求解失败'); process.exit(1); }
/* 平局偏好更大的 λ(参数更贴先验、更稳):取 val MSE 在最优 1% 以内的最大 λ */
{
  const ok = sweep.filter((s) => s.mse <= best.mse * 1.01);
  const pick = ok[ok.length - 1];
  if (pick && pick.lambda > best.lambda) {
    console.log(`平局偏好:λ 从 ${best.lambda.toFixed(0)} 提到 ${pick.lambda.toFixed(0)}(MSE ${best.mse.toFixed(1)} → ${pick.mse.toFixed(1)},≤1% 损失)`);
    best = { ...pick, w: solveRidge(pick.lambda) };
  }
}
console.log(`选定 λ=${best.lambda.toFixed(0)}(val MSE ${best.mse.toFixed(1)},R² ${best.r2.toFixed(4)})`);

/* ---------- 知识约束投影:棋理上必须为正的参数拟出 ≤0 ⇒ 冻结回手写先验并重拟合 ----------
 * 这些是 §4.4.2 的 sanity 硬约束:tempo、双象、叠/孤立/王盾罚幅、机动性、通路兵、王区威胁。
 * 拟出负值不是"数据发现了新棋理",而是失衡行选择偏差在位置项上的残余(见扫描 train 处注释)。 */
const POS_SET = [];
for (const base of [EVAL_IDX.MOB_MG, EVAL_IDX.MOB_EG]) for (let k = 0; k < 4; k++) POS_SET.push(base + k);
for (const base of [EVAL_IDX.PASSED_MG, EVAL_IDX.PASSED_EG]) for (let k = 0; k < 6; k++) POS_SET.push(base + k);
for (let k = 0; k < 5; k++) POS_SET.push(EVAL_IDX.KATK + k);
POS_SET.push(EVAL_IDX.TEMPO, EVAL_IDX.PAIR_MG, EVAL_IDX.PAIR_EG,
  EVAL_IDX.DOUBLED_MG, EVAL_IDX.DOUBLED_EG, EVAL_IDX.ISOLATED_MG, EVAL_IDX.ISOLATED_EG, EVAL_IDX.SHIELD_MG);
let nProjected = 0;
for (let round = 0; round < 4; round++) {
  const w = solveRidge(best.lambda);
  if (!w) break;
  const bad = [];
  for (const i of POS_SET) {
    if (PINNED.has(i) || frozen[i]) continue;
    if (w[freeMap[i]] <= 0) bad.push(i);
  }
  if (!bad.length) break;
  for (const i of bad) { freezeAtPrior(i); nProjected++; }
  rebuildFree();
  console.log(`投影第 ${round + 1} 轮:${bad.length} 个非正参数冻结回先验,重拟合`);
}
const wBest = solveRidge(best.lambda);

/* ---------- 组装完整参数向量 + 尺度锚定 + 取整 ---------- */
if (!wBest) { console.error('✗ 投影后求解失败'); process.exit(1); }
const wFull = new Float64Array(N_EVAL_PARAMS);
for (let i = 0; i < N_EVAL_PARAMS; i++) {
  if (PINNED.has(i)) wFull[i] = 0;
  else if (frozen[i]) wFull[i] = w0[i];
  else wFull[i] = wBest[freeMap[i]];
}
/* 尺度:子力已冻结在手写值(兵 MG=100,与旧引擎/搜索 margin 同尺度),不再缩放。
 * 经验平均兵值仅作体检:PST 会小幅漂移,平均值落在 80~130 都正常。 */
const pawnAvgMG = (() => {
  let f = 0, s = 0;
  for (let t = 0; t < 64; t++) { f += pawnFreq[t]; s += pawnFreq[t] * wFull[EVAL_IDX.PST_MG_PAWN + t]; }
  return wFull[EVAL_IDX.VAL_MG] + s / f;
})();
if (!(pawnAvgMG > 60 && pawnAvgMG < 180)) { console.error(`✗ 体检失败:经验平均兵值 ${pawnAvgMG.toFixed(1)} 超出 60~180,PST 漂移过大`); process.exit(1); }
const scale = 1;
const wScaled = new Float64Array(N_EVAL_PARAMS);
for (let i = 0; i < N_EVAL_PARAMS; i++) wScaled[i] = Math.round(wFull[i] * scale);

/* 取整后最终指标 */
function metricsFinal(wv) {
  let se = 0;
  for (const r of valFit) {
    let p = 0;
    for (let k = 0; k < r.idx.length; k++) p += wv[r.idx[k]] * r.val[k];
    const d = p - r.y;
    se += d * d;
  }
  return { mse: se / valFit.length, r2: 1 - (se / valFit.length) / valVar };
}
const fin = metricsFinal(wScaled);

/* ---------- sanity check(§4.4.2) ---------- */
console.log('\n=== sanity check ===');
const S = EVAL_IDX;
const row = (k, v, expect) => console.log(`  ${k.padEnd(24)} ${String(v).padStart(7)}   ${expect}`);
row('子力 MG P/N/B/R/Q', [0, 1, 2, 3, 4].map((i) => wScaled[S.VAL_MG + i]).join('/'), '冻结手写值(钉格基:轻子值=离开 a1 的价值)');
row('子力 EG P/N/B/R/Q', [0, 1, 2, 3, 4].map((i) => wScaled[S.VAL_EG + i]).join('/'), '');
row('tempo', wScaled[S.TEMPO], '应 >0');
row('双象 MG/EG', `${wScaled[S.PAIR_MG]}/${wScaled[S.PAIR_EG]}`, '应 >0');
row('叠兵罚 MG/EG', `${wScaled[S.DOUBLED_MG]}/${wScaled[S.DOUBLED_EG]}`, '应 >0(罚分幅值)');
row('孤立兵罚 MG/EG', `${wScaled[S.ISOLATED_MG]}/${wScaled[S.ISOLATED_EG]}`, '应 >0(罚分幅值)');
row('王盾罚 MG', wScaled[S.SHIELD_MG], '应 >0(罚分幅值)');
row('机动性 MG N/B/R/Q', [0, 1, 2, 3].map((i) => wScaled[S.MOB_MG + i]).join('/'), '应 >0');
row('机动性 EG N/B/R/Q', [0, 1, 2, 3].map((i) => wScaled[S.MOB_EG + i]).join('/'), '应 >0');
console.log(`  通路兵 MG 横线2..7  ${[0, 1, 2, 3, 4, 5].map((i) => wScaled[S.PASSED_MG + i]).join('/')}   应>0 且随横线不减`);
console.log(`  通路兵 EG 横线2..7  ${[0, 1, 2, 3, 4, 5].map((i) => wScaled[S.PASSED_EG + i]).join('/')}   同上`);
console.log(`  王区威胁 N/B/R/Q+缩放 ${[0, 1, 2, 3, 4].map((i) => wScaled[S.KATK + i]).join('/')}   应 ≥0`);

/* 符号硬校验:任何一项反了都不是"拟合背锅"而是特征/正则有错 —— 硬失败 */
const signFail = [];
if (wScaled[S.TEMPO] <= 0) signFail.push('tempo');
for (let i = 0; i < 5; i++) {
  if (wScaled[S.VAL_MG + i] <= 0) signFail.push('子力MG' + 'PNBRQ'[i]);
  if (wScaled[S.VAL_EG + i] <= 0) signFail.push('子力EG' + 'PNBRQ'[i]);
}
for (const i of [S.PAIR_MG, S.PAIR_EG, S.DOUBLED_MG, S.DOUBLED_EG, S.ISOLATED_MG, S.ISOLATED_EG, S.SHIELD_MG]) if (wScaled[i] <= 0) signFail.push(i);
for (let i = 0; i < 8; i++) if (wScaled[S.MOB_MG + i] <= 0) signFail.push('mob' + i);
for (let i = 0; i < 12; i++) if (wScaled[S.PASSED_MG + i] <= 0) signFail.push('passed' + i);
console.log(signFail.length ? `⚠ 符号异常:${signFail.join(', ')}` : '✓ 全部符号符合预期');

/* 通路兵单调性(硬校验只查符号;单调性给警告) */
{
  let mono = true;
  for (const base of [S.PASSED_MG, S.PASSED_EG]) {
    for (let i = 1; i < 6; i++) if (wScaled[base + i] < wScaled[base + i - 1]) mono = false;
  }
  console.log(mono ? '✓ 通路兵随横线单调不减' : '⚠ 通路兵存在非单调档(逐格检查,小幅度可接受)');
}

/* 子力差分外推检验:开局局面依次拿掉一个子,评估变化应接近常识子力价 */
{
  const DIFF_FENS = [
    ['兵', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPP1/RNBQKBNR w KQkq - 0 1'],
    ['马', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKB1R w KQkq - 0 1'],
    ['象', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/R1BQKBNR w KQkq - 0 1'],
    ['车', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/1NBQKBNR w KQkq - 0 1'],
    ['后', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1'],
  ];
  console.log('  子力差分(开局减子,负值越大越合理):');
  for (const [name, fen] of DIFF_FENS) {
    if (!posFromFen(pos, fen)) continue;
    evalFeatures(pos, g);
    let p = 0;
    for (let i = 0; i < N_EVAL_PARAMS; i++) if (g[i] !== 0) p += wScaled[i] * g[i];
    console.log(`    −${name}  ${p.toFixed(0)}`);
  }
}

/* 与手写初值的相关性(PST 部分) */
{
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < N_EVAL_PARAMS; i++) {
    if (!pstRangeOfSafe(i) || PINNED.has(i) || frozen[i]) continue;
    sxy += wScaled[i] * w0[i]; sxx += w0[i] * w0[i]; syy += wScaled[i] * wScaled[i];
  }
  console.log(`拟合 PST 与手写初值的相关系数 r = ${(sxy / Math.sqrt(sxx * syy)).toFixed(3)}(自由 PST 格)`);
}

/* mate 对照:胜负已定局面,拟合评估与 mate 符号同向的比例(旧参数 vs 新参数) */
{
  let agreeNew = 0, agreeOld = 0, n = 0;
  for (const r of valRows) {
    if (!r.mate) continue;
    let p = 0, p0 = 0;
    for (let k = 0; k < r.idx.length; k++) {
      p += wScaled[r.idx[k]] * r.val[k];
      p0 += w0[r.idx[k]] * r.val[k];
    }
    if (Math.sign(p) === r.mate) agreeNew++;
    if (Math.sign(p0) === r.mate) agreeOld++;
    n++;
  }
  console.log(`mate 符号对照(${n} 行):拟合 ${(agreeNew / n * 100).toFixed(1)}% 同向,手写初值 ${(agreeOld / n * 100).toFixed(1)}% 同向`);
}

console.log(`\n尺度:子力冻结手写值(兵 MG=100),不做缩放;经验平均兵值体检 = ${pawnAvgMG.toFixed(1)}(PST 漂移所致)`);
console.log(`最终(取整后)val MSE ${fin.mse.toFixed(1)}  R² ${fin.r2.toFixed(4)}`);
console.log(`参考:恒零预测的 MSE = ${valVar.toFixed(1)}(R²=0 基线)`);

/* ---------- 输出 ---------- */
const out = {
  meta: {
    date: new Date().toISOString(), lambda: best.lambda, rows: trainRows,
    valRows: valFit.length, minCover: MIN_COVER, clip: CLIP,
    valMse: fin.mse, valR2: fin.r2, pawnAvgMG,
    freeParams: F, frozen: nFrozen, projected: nProjected,
    mode: 'material-frozen + imbalance-downweight + prior-shrink ridge',
  },
  params: Array.from(wScaled),
};
fs.writeFileSync(path.join(HERE, 'data', 'fitted-params.json'), JSON.stringify(out));
const literal = `// 由 tuner/fit-eval.mjs 生成(${out.meta.date})
// ${out.meta.mode};λ=${best.lambda.toFixed(1)},train ${trainRows.toLocaleString()} 行,val R²=${fin.r2.toFixed(4)}(MSE ${fin.mse.toFixed(1)});子力冻结手写值(兵 MG=100)
const FITTED = [
${Array.from(wScaled).map((v) => `${v},`).join('')}
];`;
fs.writeFileSync(path.join(HERE, 'data', 'fitted-params.js.txt'), literal);
console.log(`\n已写出 data/fitted-params.json 与 data/fitted-params.js.txt`);
if (signFail.length) { console.error('✗ 符号硬校验未过,拒绝产出可用参数'); process.exit(1); }
