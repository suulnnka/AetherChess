/* 度量"一个新特征组究竟能安全给多少参数"。
 *
 * 背景:`docs/chess-eval-tuning-plan.md` §3.1 里机动性只给 8 个、通路兵只给 12 个。
 * 这里把两个真正卡住参数量的东西量化,而不是靠嘴说:
 *
 *   (1) 冗余度 —— 把候选特征对"该子所在格"做饱和回归(64 个格子哑变量)。
 *       PST 在数学上张成**全部"格子的函数"**,所以 R² 就是"已经被 PST 说掉"的比例;
 *       剩下的 1−R² 才是新信息,VIF = 1/(1−R²) 是新列被 PST 膨胀后的方差。
 *   (2) 样本量 —— "按格给表"要求每个 (子, 格) 都有足够行数。
 *       逐格统计出现次数,看多少格达不到 <200 的覆盖度闸门。
 *
 * 镜像说明:黑白两色合并统计(黑方格子翻到白方视角)。这等价于"给这个子类一张
 * 按格表"的样本量,因为本来要拟的表就是镜像共用的。
 *
 * 用法: node feature-collinearity.mjs [maxRows=200000]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRAIN = path.join(HERE, 'data', 'train.jsonl');
const MAX = Number(process.argv[2] || 200000);

const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5;
const PTYPE = { n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, p: PAWN };

/* r=0 是第 8 横线(与 FEN 摆放顺序一致),c=0 是 a 列;白方向上 = r 减小 */
const ND = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const BD = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const RD = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const inside = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

/** FEN 棋盘部分 → Int8Array(64),元素 0 或 (色<<3)|类型,小写=黑=1 */
function parseFen(fen) {
  const b = new Int8Array(64);
  let r = 0, c = 0;
  for (const ch of fen.split(' ')[0]) {
    if (ch === '/') { r++; c = 0; continue; }
    if (ch >= '1' && ch <= '8') { c += ch.charCodeAt(0) - 48; continue; }
    const t = PTYPE[ch.toLowerCase()];
    if (t) b[r * 8 + c] = ((ch === ch.toLowerCase() ? 1 : 0) << 3) | t;
    c++;
  }
  return b;
}

/** 滑子/马的机动性:可达且不被己方占据的格数(可吃格计入) */
function mobility(b, sq, type, color) {
  const r0 = sq >> 3, c0 = sq & 7;
  let n = 0;
  if (type === KNIGHT) {
    for (const [dr, dc] of ND) {
      const r = r0 + dr, c = c0 + dc;
      if (!inside(r, c)) continue;
      const p = b[r * 8 + c];
      if (p && (p >> 3) === color) continue;
      n++;
    }
    return n;
  }
  const dirs = type === BISHOP ? BD : type === ROOK ? RD : BD.concat(RD);
  for (const [dr, dc] of dirs) {
    let r = r0 + dr, c = c0 + dc;
    while (inside(r, c)) {
      const p = b[r * 8 + c];
      if (!p) { n++; r += dr; c += dc; continue; }
      if ((p >> 3) !== color) n++;   // 敌方子可吃 ⇒ 该格可达
      break;
    }
  }
  return n;
}

/** 兵:被攻击到的、非己方占据的格数 */
function pawnMobility(b, sq, color) {
  const r0 = sq >> 3, c0 = sq & 7;
  const dr = color === 0 ? -1 : 1;
  let n = 0;
  for (const dc of [-1, 1]) {
    const r = r0 + dr, c = c0 + dc;
    if (!inside(r, c)) continue;
    const p = b[r * 8 + c];
    if (p && (p >> 3) === color) continue;
    n++;
  }
  return n;
}

/** 该兵是否通路:同列或相邻列的前方没有敌兵 */
function isPassed(b, sq, color) {
  const r0 = sq >> 3, c0 = sq & 7, enemy = color ^ 1;
  for (let c = c0 - 1; c <= c0 + 1; c++) {
    if (c < 0 || c > 7) continue;
    for (let r = 0; r < 8; r++) {
      const p = b[r * 8 + c];
      if (!p || (p >> 3) !== enemy || (p & 7) !== PAWN) continue;
      if (color === 0 ? r < r0 : r > r0) return false;
    }
  }
  return true;
}

const GROUPS = ['n', 'b', 'r', 'q', 'p'];
const sqAcc = {};
for (const g of GROUPS) {
  sqAcc[g] = { n: new Float64Array(64), s: new Float64Array(64), s2: new Float64Array(64), hist: new Float64Array(32) };
}
/* 通路兵按"相对横线 1..8"计兵次,两色合并;seen 保留分色以便核对镜像 */
const passedRel = new Float64Array(9);
const seen = [new Float64Array(9), new Float64Array(9)];

let rows = 0;
for (const line of fs.readFileSync(TRAIN, 'utf8').split('\n')) {
  if (!line || rows >= MAX) continue;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const b = parseFen(o.fen);
  rows++;
  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (!p) continue;
    const color = p >> 3, type = p & 7;
    const g = type === KNIGHT ? 'n' : type === BISHOP ? 'b' : type === ROOK ? 'r'
      : type === QUEEN ? 'q' : type === PAWN ? 'p' : null;
    if (!g) continue;
    /* 黑方镜像到白方视角,两色样本合并 */
    const ms = color === 0 ? s : ((7 - (s >> 3)) * 8 + (s & 7));
    const m = g === 'p' ? pawnMobility(b, s, color) : mobility(b, s, type, color);
    const t = sqAcc[g];
    t.n[ms]++; t.s[ms] += m; t.s2[ms] += m * m; t.hist[m]++;
    if (g === 'p' && isPassed(b, s, color)) {
      /* 表是按"自己那侧的相对横线"索引的(白兵第 2 横线 ↔ 黑兵第 7 横线),
         所以先换算成相对横线再合并两色,否则两色样本会错位到相反的端点 */
      const rank = 8 - (s >> 3);
      const rel = color === 0 ? rank : 9 - rank;
      passedRel[rel]++;
      if (color === 0) seen[0][rel]++; else seen[1][rel]++;
    }
  }
}

console.log(`样本行数 ${rows.toLocaleString()}(上限 ${MAX.toLocaleString()}),黑白镜像合并计数\n`);

console.log('=== (1) 机动性:对"该子所在格"做饱和回归(64 格哑变量) ===');
console.log('PST 张成全部"格子的函数" ⇒ R² 就是已被 PST 说掉的比例\n');
console.log('子类   平均机动   R²(被格解释)   新信息1−R²   VIF     ≥200 兵次/行次的格数');
for (const g of GROUPS) {
  const t = sqAcc[g];
  let N = 0, S = 0, S2 = 0, sse = 0, cover = 0;
  for (let k = 0; k < 64; k++) {
    const n = t.n[k];
    if (!n) continue;
    N += n; S += t.s[k]; S2 += t.s2[k];
    sse += t.s2[k] - (t.s[k] * t.s[k]) / n;
    if (n >= 200) cover++;
  }
  const r2 = 1 - sse / (S2 - (S * S) / N);
  console.log(
    `${g.padEnd(6)} ${(S / N).toFixed(2).padStart(8)} ${(r2 * 100).toFixed(1).padStart(13)}%` +
    ` ${((1 - r2) * 100).toFixed(1).padStart(11)}% ${(1 / (1 - r2)).toFixed(2).padStart(6)}` +
    `   ${cover}/64`
  );
}

console.log('\n=== (2) 机动性取值分布(决定"曲线版"要多少参数才有样本) ===');
console.log('每个取值至少要撑起 ≥200 行才算可拟合;横线右侧是该值的样本量(千行)');
for (const g of GROUPS) {
  const h = sqAcc[g].hist;
  const tot = h.reduce((a, v) => a + v, 0);
  let hi = 0;
  for (let i = 0; i < h.length; i++) if (h[i]) hi = i;
  const cells = [];
  let thin = 0;
  for (let i = 0; i <= hi; i++) {
    const pct = h[i] / tot * 100;
    if (h[i] > 0 && h[i] < 200) thin++;
    cells.push(`${i}:${pct >= 0.05 ? Math.round(pct) + '%' : '·'}`);
  }
  console.log(`${g} (0..${hi}, ${thin} 个取值样本 <200)  ${cells.join(' ')}`);
}

console.log('\n=== (3) 通路兵:按"自己那侧相对横线"统计的样本量 ===');
console.log('(逐横线给表 ⇒ 每档要自己撑起样本;再乘 2 个相位 = 每参数行数)');
{
  const parts = [], partsW = [], partsB = [];
  for (let r = 2; r <= 7; r++) {
    parts.push(`第${r}横线 ${passedRel[r].toLocaleString()}`);
    partsW.push(seen[0][r].toLocaleString());
    partsB.push(seen[1][r].toLocaleString());
  }
  const tot = passedRel.reduce((a, v, i) => a + (i >= 2 && i <= 7 ? v : 0), 0);
  console.log(`兵次合计 ${tot.toLocaleString()}`);
  console.log(`  合并  ${parts.join(' | ')}`);
  console.log(`  白    ${partsW.join(' | ')}`);
  console.log(`  黑    ${partsB.join(' | ')}`);
  console.log('第 7 相对横线(离升变一步)样本最少,而这正是 SF 表里权重最高的一档(第 3 横线的 16 倍)');
}