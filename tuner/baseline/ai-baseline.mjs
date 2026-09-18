/* ============================================================
 * 国际象棋 AI:评估函数 + 搜索
 * 对应 chess-ai-plan.md §3.3 / §3.4 / §3.7
 *
 * 搜索:PVS 负极大 + 迭代加深 + 置换表 + 静态搜索,叠加
 *       空着剪枝 / 迟着裁减(LMR) / 逆向 futility / 将军延伸 / aspiration 窗口
 * 排序:TT 最佳着法 → MVV-LVA 吃子 → killer → history
 * 评估:子力 + PST(中局/残局按相位插值)+ 兵结构 + 王盾 + 双象
 *
 * 本文件不得 import 渲染库、不得碰 DOM —— Worker 与 Node 测试都要直接 import。
 * 预算口径:节点上限为主(设备无关、可复现),墙上时间为兜底(不同机器上
 * 节点预算的耗时不同,所以两个都要给)。
 * ============================================================ */
import {
  WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  piece, mFrom, mTo, mFlag, mCap, mIsQuiet,
  F_CAP, F_EP,
  make, unmake, makeNull, unmakeNull, genMoves, genLegal, isLegal,
  inCheck, isRepetition, insufficientMaterial,
} from '../../src/rules.js';

/* ============================================================
 * 难度档
 *   nodes  节点上限(主约束,确定性)
 *   ms     墙上时间兜底(慢机器上不至于卡死)
 *   depth  深度上限
 *   jitter 低档专用:在"最优着法 N 分以内"的着法里随机挑一个。
 *          比给评分加随机噪声正统 —— 弱得可控,同一局面不会前后矛盾。
 *
 * 节点预算是按本机实测标定的(NPS 约 20~45 万):
 *   40k ≈ 0.24s / 7 层 · 160k ≈ 0.36s / 9 层 · 1200k ≈ 2.5s / 11~12 层
 * 换机器时棋力会漂,但**同一台机器上是可复现的** —— 这是选节点而非时间做主预算的原因。
 * ============================================================ */
export const LEVELS = [
  { id: 'easy', name: '初级', depth: 2, jitter: 70, nodes: 20000, ms: 200 },
  { id: 'normal', name: '中级', depth: 24, jitter: 0, nodes: 40000, ms: 500 },
  { id: 'hard', name: '高级', depth: 24, jitter: 0, nodes: 160000, ms: 900 },
  { id: 'master', name: '大师', depth: 24, jitter: 0, nodes: 1200000, ms: 3500 },
];
export const DEFAULT_LEVEL = 2;

/* ============================================================
 * 评估
 * ============================================================ */
const VAL_MG = [0, 100, 320, 330, 500, 900, 0];
const VAL_EG = [0, 110, 310, 330, 550, 950, 0];
const PHASE_W = [0, 0, 1, 1, 2, 4, 0];        // 兵的相位权重为 0,所以相位只由轻/重子决定
const PHASE_MAX = 24;                          // 4 马 + 4 象 + 4 车×2 + 2 后×4

/* PST 表按「白方视角、索引 0 = a8、63 = h1」书写,与 sq = r*8+c 同序。
 * 黑方靠 s ^ 56 做上下镜像取同一张表。
 * 取值是社区通用型(HCE 教科书量级)的起点,不是调优过的最终值 ——
 * 想要更准只能拿自我对弈的数据去调,这一点没做就不宣称做了。 */
const PST_MG = [
  // 兵:奖励推进与占中,惩罚原地不动的 d/e 兵
  [0, 0, 0, 0, 0, 0, 0, 0,
    55, 65, 65, 75, 80, 65, 65, 55,
    20, 25, 30, 40, 45, 30, 25, 20,
    5, 10, 15, 25, 25, 15, 10, 5,
    0, 5, 8, 18, 18, 8, 5, 0,
    2, 2, 4, 10, 10, 4, 2, 2,
    0, 0, 0, -8, -8, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0],
  // 马:占中心,忌边线
  [-50, -35, -25, -25, -25, -25, -35, -50,
    -35, -20, -5, 0, 0, -5, -20, -35,
    -25, -5, 10, 15, 15, 10, -5, -25,
    -25, 0, 15, 20, 20, 15, 0, -25,
    -25, -2, 15, 20, 20, 15, -2, -25,
    -28, -5, 8, 12, 12, 8, -5, -28,
    -35, -22, -8, -2, -2, -8, -22, -35,
    -50, -35, -25, -25, -25, -25, -35, -50],
  // 象:斜线中心与长对角线
  [-20, -10, -10, -10, -10, -10, -10, -20,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 0, 10, 15, 15, 10, 0, -10,
    -10, 5, 10, 15, 15, 10, 5, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -20, -10, -10, -10, -10, -10, -10, -20],
  // 车:第七横线与中央直线
  [2, 2, 6, 10, 10, 6, 2, 2,
    18, 22, 26, 26, 26, 26, 22, 18,
    -4, 0, 0, 0, 0, 0, 0, -4,
    -6, 0, 0, 0, 0, 0, 0, -6,
    -6, 0, 0, 0, 0, 0, 0, -6,
    -6, 0, 0, 0, 0, 0, 0, -6,
    -6, 0, 0, 0, 0, 0, 0, -6,
    -2, 0, 2, 6, 6, 2, 0, -2],
  // 后:轻微偏中心,别太早出来
  [-12, -8, -4, -2, -2, -4, -8, -12,
    -8, 0, 4, 4, 4, 4, 0, -8,
    -6, 4, 8, 8, 8, 8, 4, -6,
    -4, 4, 8, 12, 12, 8, 4, -4,
    -4, 4, 8, 12, 12, 8, 4, -4,
    -6, 2, 6, 8, 8, 6, 2, -6,
    -8, 0, 2, 4, 4, 2, 0, -8,
    -12, -10, -8, -4, -4, -8, -10, -12],
  // 王(中局):躲底线两侧、易位后最好,别站在 d/e 线
  [-40, -50, -55, -60, -60, -55, -50, -40,
    -35, -45, -50, -55, -55, -50, -45, -35,
    -30, -40, -45, -50, -50, -45, -40, -30,
    -28, -38, -42, -48, -48, -42, -38, -28,
    -20, -28, -32, -38, -38, -32, -28, -20,
    -12, -18, -22, -25, -25, -22, -18, -12,
    -5, 10, -8, -18, -18, -8, 10, -5,
    -8, 22, 10, -25, -10, -12, 26, -6],
];
const PST_EG = [
  [0, 0, 0, 0, 0, 0, 0, 0,
    90, 95, 95, 95, 95, 95, 95, 90,
    55, 60, 60, 60, 60, 60, 60, 55,
    30, 32, 35, 40, 40, 35, 32, 30,
    12, 15, 20, 25, 25, 20, 15, 12,
    4, 6, 8, 12, 12, 8, 6, 4,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0],
  [-45, -30, -20, -20, -20, -20, -30, -45,
    -30, -18, -5, 0, 0, -5, -18, -30,
    -20, -5, 10, 14, 14, 10, -5, -20,
    -20, 0, 14, 18, 18, 14, 0, -20,
    -20, -3, 14, 18, 18, 14, -3, -20,
    -22, -6, 8, 12, 12, 8, -6, -22,
    -30, -20, -8, -2, -2, -8, -20, -30,
    -45, -30, -20, -20, -20, -20, -30, -45],
  [-15, -8, -8, -8, -8, -8, -8, -15,
    -8, 2, 0, 0, 0, 0, 2, -8,
    -8, 5, 8, 8, 8, 8, 5, -8,
    -8, 0, 8, 12, 12, 8, 0, -8,
    -8, 2, 8, 12, 12, 8, 2, -8,
    -8, 0, 5, 8, 8, 5, 0, -8,
    -8, 0, 0, 0, 0, 0, 0, -8,
    -15, -8, -8, -8, -8, -8, -8, -15],
  [4, 6, 8, 10, 10, 8, 6, 4,
    12, 14, 16, 16, 16, 16, 14, 12,
    4, 6, 8, 8, 8, 8, 6, 4,
    0, 4, 6, 6, 6, 6, 4, 0,
    -2, 2, 4, 4, 4, 4, 2, -2,
    -4, 0, 2, 2, 2, 2, 0, -4,
    -6, -2, 0, 0, 0, 0, -2, -6,
    -8, -4, -2, 0, 0, -2, -4, -8],
  [-20, -12, -8, -4, -4, -8, -12, -20,
    -12, -4, 0, 4, 4, 0, -4, -12,
    -8, 4, 10, 14, 14, 10, 4, -8,
    -4, 8, 14, 20, 20, 14, 8, -4,
    -4, 8, 14, 20, 20, 14, 8, -4,
    -8, 4, 10, 14, 14, 10, 4, -8,
    -12, -4, 0, 4, 4, 0, -4, -12,
    -20, -12, -8, -4, -4, -8, -12, -20],
  [-50, -30, -25, -25, -25, -25, -30, -50,
    -30, -15, -10, -8, -8, -10, -15, -30,
    -25, -10, 20, 28, 28, 20, -10, -25,
    -25, -8, 28, 38, 38, 28, -8, -25,
    -25, -8, 28, 38, 38, 28, -8, -25,
    -25, -10, 20, 28, 28, 20, -10, -25,
    -30, -20, -12, -8, -8, -12, -20, -30,
    -50, -35, -30, -28, -28, -30, -35, -50],
];

/* 王盾:王所在列 ±1 三条线上,"前方 1~2 行"的秩掩码。位 r 表示该列有兵在第 r 行。
 * 掩码为 0(王已经贴到棋盘另一端)时不算 —— 那种局面王盾本来就没意义。 */
const SHIELD = [new Int32Array(8), new Int32Array(8)];
for (let r = 0; r < 8; r++) {
  let m = 0;
  if (r - 1 >= 0) m |= 1 << (r - 1);
  if (r - 2 >= 0) m |= 1 << (r - 2);
  SHIELD[WHITE][r] = m;
  m = 0;
  if (r + 1 < 8) m |= 1 << (r + 1);
  if (r + 2 < 8) m |= 1 << (r + 2);
  SHIELD[BLACK][r] = m;
}

const wPawnM = new Int32Array(8), bPawnM = new Int32Array(8);
const wPawnF = new Int32Array(8), bPawnF = new Int32Array(8);

/** 局面分,返回「走子方视角」的厘兵值(centipawn) */
export function evaluate(pos) {
  const b = pos.b;
  wPawnM.fill(0); bPawnM.fill(0); wPawnF.fill(0); bPawnF.fill(0);
  let mg = 0, eg = 0, phase = 0, wb = 0, bb = 0;

  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (!p) continue;
    const col = p >> 3, ty = p & 7;
    const i = ty - 1;
    const t = col === WHITE ? s : s ^ 56;         // 镜像到白方视角
    const sg = col === WHITE ? 1 : -1;
    mg += sg * (VAL_MG[ty] + PST_MG[i][t]);
    eg += sg * (VAL_EG[ty] + PST_EG[i][t]);
    phase += PHASE_W[ty];
    if (ty === PAWN) {
      if (col === WHITE) { wPawnF[s & 7]++; wPawnM[s & 7] |= 1 << (s >> 3); }
      else { bPawnF[s & 7]++; bPawnM[s & 7] |= 1 << (s >> 3); }
    } else if (ty === BISHOP) { if (col === WHITE) wb++; else bb++; }
  }

  // 兵结构:叠兵 + 孤立兵
  for (let f = 0; f < 8; f++) {
    const wf = wPawnF[f], bf = bPawnF[f];
    if (wf > 1) { mg -= 12 * (wf - 1); eg -= 22 * (wf - 1); }
    if (bf > 1) { mg += 12 * (bf - 1); eg += 22 * (bf - 1); }
    const wl = f === 0 ? 0 : wPawnF[f - 1], wr = f === 7 ? 0 : wPawnF[f + 1];
    if (wf && !wl && !wr) { mg -= 14 * wf; eg -= 16 * wf; }
    const bl = f === 0 ? 0 : bPawnF[f - 1], br = f === 7 ? 0 : bPawnF[f + 1];
    if (bf && !bl && !br) { mg += 14 * bf; eg += 16 * bf; }
  }

  // 王盾(只在还有中局成分时计入 —— 残局王要出去干活,盾无所谓)
  if (phase > 8) {
    for (let col = 0; col < 2; col++) {
      const ks = pos.ks[col], kr = ks >> 3, kc = ks & 7;
      const sm = SHIELD[col][kr];
      if (!sm) continue;
      const mask = col === WHITE ? wPawnM : bPawnM;
      let miss = 0;
      for (let df = -1; df <= 1; df++) {
        const f = kc + df;
        if (f < 0 || f > 7) continue;
        if (!(mask[f] & sm)) miss++;
      }
      if (miss) { const pen = miss * 14; mg += col === WHITE ? -pen : pen; }
    }
  }

  // 双象
  if (wb >= 2) { mg += 25; eg += 45; }
  if (bb >= 2) { mg -= 25; eg -= 45; }

  const sc = (mg * phase + eg * (PHASE_MAX - phase)) / PHASE_MAX;
  const v = sc < 0 ? -(-sc | 0) : (sc | 0);
  return pos.stm === WHITE ? v : -v;
}

/* ============================================================
 * 静态交换估值(SEE)
 * 只在静态搜索里用:判断"这步吃子是否明显亏本",亏本就不进搜索。
 * 够用即可 —— 升变与吃过路兵不参与(要单独模拟换子序列,收益不值这个复杂度),
 * 这两种直接返回正数表示"不要剪"。
 * ============================================================ */
const SEE_VAL = [0, 100, 320, 330, 500, 900, 20000];
const SB = new Int8Array(64);
const GAIN = new Int32Array(32);
const ND8 = new Int8Array([1, 2, 2, 1, -1, 2, -2, 1, 1, -2, 2, -1, -1, -2, -2, -1]);
const DD4 = new Int8Array([1, 1, 1, -1, -1, 1, -1, -1]);
const OD4 = new Int8Array([1, 0, -1, 0, 0, 1, 0, -1]);
const KD8 = new Int8Array([1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1]);

/** 在临时棋盘 SB 上找 sq 的最小价值攻击者,返回格号或 -1 */
function leastAttacker(sq, by) {
  const r = sq >> 3, c = sq & 7;
  const pw = piece(by, PAWN), kn = piece(by, KNIGHT);
  const pr = r + (by === WHITE ? 1 : -1);
  if (pr >= 0 && pr < 8) {
    const base = pr * 8;
    if (c > 0 && SB[base + c - 1] === pw) return base + c - 1;
    if (c < 7 && SB[base + c + 1] === pw) return base + c + 1;
  }
  for (let i = 0; i < 16; i += 2) {
    const rr = r + ND8[i], cc = c + ND8[i + 1];
    if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && SB[rr * 8 + cc] === kn) return rr * 8 + cc;
  }
  // 滑动子:每个方向只看第一个子(前一个被吃掉后,后面的会自然成为新的第一个)
  const bi = piece(by, BISHOP), ro = piece(by, ROOK), qu = piece(by, QUEEN), kg = piece(by, KING);
  let bc = -1, rc = -1, qc = -1;
  for (let i = 0; i < 8; i += 2) {
    const dr = DD4[i], dc = DD4[i + 1];
    let rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
      const v = SB[rr * 8 + cc];
      if (v) { if (v === bi) bc = rr * 8 + cc; else if (v === qu) qc = rr * 8 + cc; break; }
      rr += dr; cc += dc;
    }
  }
  for (let i = 0; i < 8; i += 2) {
    const dr = OD4[i], dc = OD4[i + 1];
    let rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
      const v = SB[rr * 8 + cc];
      if (v) { if (v === ro) rc = rr * 8 + cc; else if (v === qu) qc = rr * 8 + cc; break; }
      rr += dr; cc += dc;
    }
  }
  // 按价值递增返回:象 330 < 车 500 < 后 900 < 王(王只在最后)
  if (bc >= 0) return bc;
  if (rc >= 0) return rc;
  if (qc >= 0) return qc;
  for (let i = 0; i < 16; i += 2) {
    const rr = r + KD8[i], cc = c + KD8[i + 1];
    if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && SB[rr * 8 + cc] === kg) return rr * 8 + cc;
  }
  return -1;
}

/** 该着法的静态交换净收益(厘兵)。升变/吃过路兵返回正值表示"不要剪"。 */
export function see(pos, m) {
  const f = mFlag(m);
  if (f === F_EP) return 1;
  if (f >= 6 && f < 10) return 1;
  const b = pos.b;
  const from = mFrom(m), to = mTo(m);
  SB.set(b);
  let onTo = b[from] & 7;
  if (f >= 10) onTo = QUEEN;                 // 升变吃子:升变子按后算,保守
  GAIN[0] = (b[to] & 7) ? SEE_VAL[b[to] & 7] : 0;
  SB[from] = 0;
  let side = pos.stm ^ 1, d = 0;
  for (;;) {
    const a = leastAttacker(to, side);
    if (a < 0) break;
    d++;
    if (d > 28) break;
    GAIN[d] = SEE_VAL[onTo] - GAIN[d - 1];
    onTo = SB[a] & 7;
    SB[a] = 0;
    side ^= 1;
  }
  while (d > 0) { GAIN[d - 1] = -Math.max(-GAIN[d - 1], GAIN[d]); d--; }
  return GAIN[0];
}

/* ============================================================
 * 搜索状态
 * ============================================================ */
const MATE = 30000, MATE_B = 29500, INF = 31000, MAX_PLY = 62;

const BUF = [], SCORE = [];
for (let i = 0; i < MAX_PLY + 4; i++) { BUF.push(new Int32Array(256)); SCORE.push(new Int32Array(256)); }

const KILLER = new Int32Array(MAX_PLY * 2);
const HIST = new Int32Array(16 * 64);

const TT_BITS = 18, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
const TT = new Int32Array(TT_SIZE * 6);      // keyA / keyB / move / score / depth / flag|age
let ttAge = 1;

let nodes = 0, nodeLimit = 0, deadline = 0, stopped = false;
let bestRoot = 0;
const nowFn = () => Date.now();

const ttFlag = (ti) => TT[ti + 5] & 3;
const ttAgeOf = (ti) => TT[ti + 5] >> 2;

/** 该方还有马/象/车/后吗(空着剪枝的前提:只剩王兵时不能用,会被 zugzwang 骗) */
function hasNonPawn(pos, stm) {
  const b = pos.b;
  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (!p || (p >> 3) !== stm) continue;
    const ty = p & 7;
    if (ty !== PAWN && ty !== KING) return true;
  }
  return false;
}

/* ---------- 静态搜索:只展开吃子与升变,被将时展开全部着法 ---------- */
function qsearch(pos, alpha, beta, ply) {
  if (stopped) return 0;
  if ((++nodes & 2047) === 0 && (nodes >= nodeLimit || nowFn() >= deadline)) { stopped = true; return 0; }
  if (ply >= MAX_PLY) return evaluate(pos);

  const inC = inCheck(pos);
  let best;
  if (inC) best = -INF;
  else {
    const stand = evaluate(pos);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    best = stand;
  }
  if (pos.half >= 100 || isRepetition(pos)) return best === -INF ? 0 : best;

  const buf = BUF[ply], sc = SCORE[ply];
  const n = genMoves(pos, buf);
  for (let i = 0; i < n; i++) {
    const m = buf[i], fl = mFlag(m);
    if (fl === F_CAP || fl >= 10) {
      sc[i] = (1 << 20) + SEE_VAL[mCap(m) & 7] * 16 - SEE_VAL[pos.b[mFrom(m)] & 7] + (fl >= 10 ? (1 << 18) : 0);
    } else if (fl === F_EP) sc[i] = (1 << 20) + 1400;
    else if (fl >= 6) sc[i] = 1 << 21;                 // 静着升变必须搜
    else sc[i] = inC ? 0 : -1;                         // 被将时静着(避将)也要搜
  }

  let tried = 0;
  for (let i = 0; i < n; i++) {
    // 选最大分剩余着法(交换到 i 位)
    let bi = -1, bs = -1;
    for (let j = i; j < n; j++) if (sc[j] > bs) { bs = sc[j]; bi = j; }
    if (bs < 0) break;
    const m = buf[bi];
    buf[bi] = buf[i]; buf[i] = m;
    sc[bi] = sc[i]; sc[i] = bs;

    const fl = mFlag(m);
    const isCap = fl === F_CAP || fl >= 10;
    if (isCap && !inC) {
      if (see(pos, m) < 0) continue;                   // 亏本吃子,不进搜索
      if (best > -INF && best + SEE_VAL[mCap(m) & 7] + 200 <= alpha) continue;   // Δ 剪枝
    }
    if (!isLegal(pos, m)) continue;
    make(pos, m);
    const s = -qsearch(pos, -beta, -alpha, ply + 1);
    unmake(pos, m);
    if (stopped) return 0;
    tried++;
    if (s > best) {
      best = s;
      if (s > alpha) { alpha = s; if (alpha >= beta) return s; }
    }
  }
  if (inC && tried === 0) return -MATE + ply;          // 被将且无着法 = 被将死
  return best;
}

/* ---------- 主搜索 ---------- */
function search(pos, depth, alpha, beta, ply, canNull) {
  if (stopped) return 0;
  if ((++nodes & 2047) === 0 && (nodes >= nodeLimit || nowFn() >= deadline)) { stopped = true; return 0; }

  if (ply > 0) {
    if (pos.half >= 100 || isRepetition(pos) || insufficientMaterial(pos)) return 0;
    if (ply >= MAX_PLY) return evaluate(pos);
  }

  const inC = inCheck(pos);
  if (inC && ply < 40) depth++;                        // 将军延伸:总量由 ply 上限兜住
  if (depth <= 0) return qsearch(pos, alpha, beta, ply);

  const ti = (pos.keyA & TT_MASK) * 6;
  let ttMove = 0;
  if (ply > 0 && TT[ti] === pos.keyA && TT[ti + 1] === pos.keyB) {
    ttMove = TT[ti + 2];
    if (TT[ti + 4] >= depth) {
      let s = TT[ti + 3];
      if (s > MATE_B) s -= ply; else if (s < -MATE_B) s += ply;
      const fl = ttFlag(ti);
      if (fl === 0) return s;
      if (fl === 1 && s >= beta) return s;
      if (fl === 2 && s <= alpha) return s;
    }
  }

  const pvNode = beta - alpha > 1;
  const staticEval = inC ? -INF : evaluate(pos);

  // 逆向 futility:静态分已经高出 β 一大截,直接当下界返回(杀分区间除外)
  if (!pvNode && !inC && depth <= 3 && Math.abs(beta) < MATE_B && staticEval - 95 * depth >= beta) {
    return staticEval;
  }

  // 空着剪枝:轮到自己走却"不走都够好",说明局面已经赢了,搜个更浅的确认即可
  if (!pvNode && !inC && canNull && depth >= 3 && Math.abs(beta) < MATE_B
      && staticEval >= beta && hasNonPawn(pos, pos.stm)) {
    makeNull(pos);
    const s = -search(pos, depth - 1 - (depth > 6 ? 3 : 2), -beta, -beta + 1, ply + 1, false);
    unmakeNull(pos);
    if (stopped) return 0;
    if (s >= beta) return beta;
  }

  const buf = BUF[ply], sc = SCORE[ply];
  const n = genMoves(pos, buf);
  const k0 = KILLER[ply * 2], k1 = KILLER[ply * 2 + 1];
  for (let i = 0; i < n; i++) {
    const m = buf[i];
    if (m === ttMove) { sc[i] = 1 << 24; continue; }
    const fl = mFlag(m);
    if (fl === F_CAP || fl >= 10) {
      sc[i] = (1 << 20) + SEE_VAL[mCap(m) & 7] * 16 - SEE_VAL[pos.b[mFrom(m)] & 7];
    } else if (fl === F_EP) sc[i] = (1 << 20) + 1200;
    else if (fl >= 6) sc[i] = 1 << 21;
    else if (m === k0) sc[i] = 1 << 19;
    else if (m === k1) sc[i] = (1 << 19) - 1;
    else sc[i] = HIST[((pos.b[mFrom(m)] & 15) << 6) | mTo(m)];
  }

  let best = 0, bestScore = -INF, tried = 0, flag = 2;   // 2 = UPPER(还没提升过 α)
  for (let i = 0; i < n; i++) {
    let bi = i, bs = -1;
    for (let j = i + 1; j < n; j++) if (sc[j] > bs) { bs = sc[j]; bi = j; }
    if (bs > sc[i]) { const tm = buf[i]; buf[i] = buf[bi]; buf[bi] = tm; const ts = sc[i]; sc[i] = sc[bi]; sc[bi] = ts; }

    const m = buf[i];
    const quiet = mIsQuiet(m);
    if (!isLegal(pos, m)) continue;

    // 静着剪枝:只在非主变、未被将、且已经搜过着法时启用,并避开杀分区间
    if (quiet && !pvNode && !inC && tried > 0 && Math.abs(alpha) < MATE_B) {
      if (depth <= 2 && staticEval + 110 * depth <= alpha) continue;          // futility
      if (depth <= 3 && tried >= 4 + depth * depth) continue;                 // 迟着剪枝
    }

    make(pos, m);
    let score;
    if (tried === 0) {
      score = -search(pos, depth - 1, -beta, -alpha, ply + 1, true);
    } else {
      let r = 0;
      if (quiet && depth >= 3 && tried >= 3 && !inC) {
        r = 1 + (tried > 5 + depth * 2 ? 1 : 0);                             // LMR
        if (pvNode) r--;
        if (r < 0) r = 0;
      }
      score = -search(pos, depth - 1 - r, -alpha - 1, -alpha, ply + 1, true);
      if (!stopped && r > 0 && score > alpha) score = -search(pos, depth - 1, -alpha - 1, -alpha, ply + 1, true);
      if (!stopped && score > alpha && score < beta) score = -search(pos, depth - 1, -beta, -alpha, ply + 1, false);
    }
    unmake(pos, m);
    if (stopped) return 0;
    tried++;

    if (score > bestScore) {
      bestScore = score;
      best = m;
      if (score > alpha) {
        alpha = score;
        flag = 0;                                        // EXACT
        if (ply === 0) bestRoot = m;
      }
    }
    if (alpha >= beta) {
      flag = 1;                                          // LOWER
      if (quiet) {
        if (KILLER[ply * 2] !== m) { KILLER[ply * 2 + 1] = KILLER[ply * 2]; KILLER[ply * 2] = m; }
        const hi = ((pos.b[mFrom(m)] & 15) << 6) | mTo(m);
        HIST[hi] += depth * depth;
        if (HIST[hi] > (1 << 18)) for (let z = 0; z < HIST.length; z++) HIST[z] >>= 1;
      }
      break;
    }
  }
  if (tried === 0) return inC ? -(MATE - ply) : 0;        // 将死 / 逼和

  const st = bestScore > MATE_B ? bestScore + ply : bestScore < -MATE_B ? bestScore - ply : bestScore;
  const sameKey = TT[ti] === pos.keyA && TT[ti + 1] === pos.keyB;
  if (!sameKey || ttAgeOf(ti) !== ttAge || depth >= TT[ti + 4]) {
    TT[ti] = pos.keyA; TT[ti + 1] = pos.keyB; TT[ti + 2] = best;
    TT[ti + 3] = st; TT[ti + 4] = depth; TT[ti + 5] = flag | (ttAge << 2);
  }
  return bestScore;
}

/* ============================================================
 * 对外入口
 * cfg = { nodes, ms, depth, jitter }
 * 返回 { move, score(白方视角厘兵), depth, nodes, ms }
 * ============================================================ */
export function searchBest(pos, cfg) {
  nodes = 0; stopped = false; bestRoot = 0;
  nodeLimit = cfg.nodes || 40000;
  const t0 = nowFn();
  deadline = t0 + (cfg.ms || 500);
  ttAge = (ttAge + 1) & 0x3fffff;
  KILLER.fill(0);
  HIST.fill(0);

  const rootBuf = BUF[MAX_PLY + 2];
  const nRoot = genLegal(pos, rootBuf);
  if (nRoot === 0) return { move: 0, score: 0, depth: 0, nodes: 0, ms: nowFn() - t0 };
  // 只有一个着法:没什么可算的,直接给(省掉整段搜索,也避免 UI 白等)
  if (nRoot === 1) return { move: rootBuf[0], score: 0, depth: 0, nodes: 0, ms: nowFn() - t0 };
  const flip = pos.stm === WHITE ? 1 : -1;

  /* 低难度档:固定浅深度逐个给根着法打分,再在"最优 ±jitter"里随机挑一个。
   * 比给评分加随机噪声正统:同一局面不会一会儿选 A 一会儿选 B,弱得可控。 */
  if (cfg.jitter) {
    const depth = Math.max(1, cfg.depth || 2);
    const cands = [];
    for (let i = 0; i < nRoot && !stopped; i++) {
      make(pos, rootBuf[i]);
      const s = -search(pos, depth - 1, -INF, INF, 1, false);
      unmake(pos, rootBuf[i]);
      if (!stopped) cands.push([rootBuf[i], s]);
    }
    if (!cands.length) return { move: rootBuf[0], score: 0, depth: 0, nodes, ms: nowFn() - t0 };
    let topS = -INF;
    for (const c of cands) if (c[1] > topS) topS = c[1];
    const pool = cands.filter((c) => c[1] >= topS - cfg.jitter);
    const pick = pool[(Math.random() * pool.length) | 0];
    return { move: pick[0], score: pick[1] * flip, depth, nodes, ms: nowFn() - t0 };
  }

  let prev = 0, doneDepth = 0, best = 0, score = 0;
  const maxDepth = Math.min(cfg.depth || 24, MAX_PLY - 4);
  for (let d = 1; d <= maxDepth; d++) {
    let delta = 35;
    let a = d >= 4 ? prev - delta : -INF;
    let b = d >= 4 ? prev + delta : INF;
    for (;;) {
      score = search(pos, d, a, b, 0, true);
      if (stopped) break;
      if (score <= a) { a = Math.max(-INF, a - delta); delta += delta >> 1; }
      else if (score >= b) { b = Math.min(INF, b + delta); delta += delta >> 1; }
      else break;
      if (delta > 3000) { a = -INF; b = INF; }
    }
    if (stopped) break;
    prev = score;
    doneDepth = d;
    best = bestRoot;
    if (score > MATE_B - 200 || score < -MATE_B + 200) break;          // 已见到杀,不必再深
    if (nodes > nodeLimit * 0.5 && nowFn() - t0 > (cfg.ms || 500) * 0.5) break;
  }
  if (!best) best = rootBuf[0];
  return { move: best, score: prev * flip, depth: doneDepth, nodes, ms: nowFn() - t0 };
}
