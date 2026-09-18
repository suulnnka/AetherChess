/* ============================================================
 * 评估参数与特征导出(调参基建)
 * 对应 docs/chess-eval-tuning-plan.md §3.1(参数集)与 §4.1(S0-1/S0-2/S0-3)
 *
 * 单一事实源:P(491 个参数)+ evalTerms()(局面 → 稀疏特征项)。
 *   evaluate()    = 稀疏项与 P 的点积(整数路径,搜索热区用)
 *   evalFeatures() = 同一批稀疏项散列成 491 维稠密向量(调参器用)
 * 两条路径共用 evalTerms,结构上禁止了"引擎一份特征、调参器一份特征"的漂移。
 *
 * 参数布局(索引即特征下标,共 491):
 *    0..4     子力 MG(P N B R Q)          5..9     子力 EG
 *   10..73    兵 PST MG(64 格,左右不对称,全表)
 *   74..105   马 PST MG(32 半列)        106..137  象 PST MG
 *  138..169   车 PST MG                  170..201  后 PST MG
 *  202..265   王 PST MG(64 格,不对称,全表)
 *  266..297   兵 PST EG(32)             298..329  马 PST EG
 *  330..361   象 PST EG                  362..393  车 PST EG
 *  394..425   后 PST EG                  426..457  王 PST EG
 *  458..461   叠兵 MG/EG、孤立兵 MG/EG
 *  462        王盾 MG(每缺一兵)         463..464  双象 MG/EG
 *  465..472   机动性 MG/EG × 马/象/车/后(每安全格)
 *  473..478   通路兵 MG(相对横线 2..7) 479..484  通路兵 EG
 *  485..489   王区威胁:马/象/车/后攻击者权重 + 总缩放(作用于 min(攻击数,8))
 *  490        tempo(+1 白走 / −1 黑走;拟合用,evaluate() 不含它,搜索层加)
 *
 * 半列镜像:实测左右对称的表只存 a..d 四列(hsq = r*4 + min(c,7−c)),
 * 兵/王 MG 实测不对称,保留 64 格。详见 tuning-plan §1.2。
 * 零空间钉参考格(每子类×相位一条,系数恒 0):兵 a2、轻子/重子 a1、(王无子力项,不钉)。
 * 兵第 1/8 横线不可达,对应参数恒 0 不参与拟合。
 *
 * 本文件不得 import 渲染库、不得碰 DOM —— Worker 与 Node 测试都要直接 import。
 * ============================================================ */
import { WHITE, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  mFrom, mTo, mFlag, mCap, F_EP, F_OO, F_OOO,
  N_ATK, N_ATK_LO, DIAG_RAY, DIAG_SEG, ORTHO_RAY, ORTHO_SEG } from './rules.js';

export const N_EVAL_PARAMS = 491;

export const EVAL_IDX = {
  VAL_MG: 0, VAL_EG: 5,                                   // 各 5:P N B R Q
  PST_MG_PAWN: 10, PST_MG_KNIGHT: 74, PST_MG_BISHOP: 106,
  PST_MG_ROOK: 138, PST_MG_QUEEN: 170, PST_MG_KING: 202,
  PST_EG_PAWN: 266, PST_EG_KNIGHT: 298, PST_EG_BISHOP: 330,
  PST_EG_ROOK: 362, PST_EG_QUEEN: 394, PST_EG_KING: 426,
  DOUBLED_MG: 458, DOUBLED_EG: 459, ISOLATED_MG: 460, ISOLATED_EG: 461,
  SHIELD_MG: 462, PAIR_MG: 463, PAIR_EG: 464,
  MOB_MG: 465, MOB_EG: 469,                               // 各 4:马 象 车 后
  PASSED_MG: 473, PASSED_EG: 479,                         // 各 6:相对横线 2..7
  KATK: 485,                                              // 485..488 攻击者权重,489 总缩放
  TEMPO: 490,
};

/* ============================================================
 * 参数值。FITTED 非空时整体采用拟合值(由 tuner/fit-eval.mjs
 * 生成,尺度锚定:单白兵局面 evaluate === 100);否则用手写初值(教科书量级,
 * 不是抄来的调优值)。两套来源只能存在一个。
 * ============================================================ */
const FITTED = [
100,270,310,498,888,110,265,315,542,930,0,0,0,0,0,0,0,0,61,67,73,85,71,68,59,32,10,18,20,45,55,54,45,42,-3,-10,-10,5,30,25,36,21,-11,-29,-15,0,1,10,9,11,-7,-33,-25,-34,-20,-21,7,-3,0,-37,-35,-66,-39,-12,9,-9,0,0,0,0,0,0,0,0,-17,17,27,30,22,28,72,60,31,47,72,84,35,53,69,49,25,49,62,44,-6,29,29,51,5,11,26,23,0,-23,-1,1,-5,9,7,3,8,15,16,18,34,42,9,34,8,18,31,34,8,9,6,29,20,12,18,17,11,30,26,8,0,17,-16,-9,27,22,38,42,53,49,75,76,23,29,37,43,13,20,30,33,1,7,9,10,11,24,3,-1,-18,-6,-2,-10,0,17,1,22,20,23,29,42,25,14,46,32,24,44,39,31,36,18,13,12,16,17,-2,2,11,10,6,-13,3,-2,-4,4,0,-13,-19,-6,-40,-50,-55,-60,-60,-55,-50,-40,-35,-42,-48,-53,-53,-47,-42,-35,-28,-36,-44,-48,-47,-40,-34,-29,-27,-36,-43,-48,-48,-42,-34,-30,-25,-30,-34,-42,-45,-38,-31,-28,-17,-21,-28,-35,-37,-30,-26,-30,-5,6,-20,-37,-28,-7,45,3,-9,52,53,-49,12,-52,44,5,0,0,0,0,97,117,103,87,76,96,66,41,49,53,51,17,8,26,23,2,-5,11,21,23,0,51,61,27,0,0,0,0,-5,17,33,35,23,31,49,61,31,39,72,72,36,59,68,83,21,44,45,78,14,22,38,50,11,21,24,25,0,-9,6,20,8,15,12,17,10,10,18,21,16,18,33,25,11,34,19,26,-1,13,27,22,9,5,28,24,-1,15,15,9,0,5,-22,-2,40,52,55,62,64,59,81,84,56,48,61,54,39,45,54,42,18,22,31,23,0,12,11,8,-9,1,6,-1,0,18,28,21,24,27,35,49,35,24,47,48,23,36,49,49,28,35,37,45,29,26,25,35,10,20,27,16,9,7,-10,-1,0,0,1,-5,-57,-17,-13,-11,-15,16,17,12,-5,32,56,54,-18,38,61,65,-46,-6,14,33,-48,-29,-18,-16,-43,-34,-36,-42,-76,-40,-59,-85,20,39,14,24,37,5,71,2,6,2,1,23,16,4,39,3,6,12,24,54,66,27,38,59,80,124,149,26,8,6,29,22,37,
];
export const EVAL_FITTED = !!FITTED;

const PHASE_W = [0, 0, 1, 1, 2, 4, 0];   // 兵/王相位权重 0:相位只由轻/重子决定
const PHASE_MAX = 24;

/* 手写初值:PST 与子力为引擎原有手写表(镜像表取 a..d 半列),新特征组为
 * 教科书量级的手写起点,随后由拟合产出。 */
const HAND = {
  valMG: [100, 320, 330, 500, 900],
  valEG: [110, 310, 330, 550, 950],
  pstMGPawn: [
    0, 0, 0, 0, 0, 0, 0, 0,
    55, 65, 65, 75, 80, 65, 65, 55,
    20, 25, 30, 40, 45, 30, 25, 20,
    5, 10, 15, 25, 25, 15, 10, 5,
    0, 5, 8, 18, 18, 8, 5, 0,
    2, 2, 4, 10, 10, 4, 2, 2,
    0, 0, 0, -8, -8, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0],
  pstMGKnight: [
    -50, -35, -25, -25, -35, -20, -5, 0, -25, -5, 10, 15, -25, 0, 15, 20,
    -25, -2, 15, 20, -28, -5, 8, 12, -35, -22, -8, -2, -50, -35, -25, -25],
  pstMGBishop: [
    -20, -10, -10, -10, -10, 5, 0, 0, -10, 10, 10, 10, -10, 0, 10, 15,
    -10, 5, 10, 15, -10, 0, 5, 10, -10, 0, 0, 0, -20, -10, -10, -10],
  pstMGRook: [
    2, 2, 6, 10, 18, 22, 26, 26, -4, 0, 0, 0, -6, 0, 0, 0,
    -6, 0, 0, 0, -6, 0, 0, 0, -6, 0, 0, 0, -2, 0, 2, 6],
  pstMGQueen: [
    -12, -8, -4, -2, -8, 0, 4, 4, -6, 4, 8, 8, -4, 4, 8, 12,
    -4, 4, 8, 12, -6, 2, 6, 8, -8, 0, 2, 4, -12, -10, -8, -4],
  pstMGKing: [
    -40, -50, -55, -60, -60, -55, -50, -40,
    -35, -45, -50, -55, -55, -50, -45, -35,
    -30, -40, -45, -50, -50, -45, -40, -30,
    -28, -38, -42, -48, -48, -42, -38, -28,
    -20, -28, -32, -38, -38, -32, -28, -20,
    -12, -18, -22, -25, -25, -22, -18, -12,
    -5, 10, -8, -18, -18, -8, 10, -5,
    -8, 22, 10, -25, -10, -12, 26, -6],
  pstEGPawn: [
    0, 0, 0, 0, 90, 95, 95, 95, 55, 60, 60, 60, 30, 32, 35, 40,
    12, 15, 20, 25, 4, 6, 8, 12, 0, 0, 0, 0, 0, 0, 0, 0],
  pstEGKnight: [
    -45, -30, -20, -20, -30, -18, -5, 0, -20, -5, 10, 14, -20, 0, 14, 18,
    -20, -3, 14, 18, -22, -6, 8, 12, -30, -20, -8, -2, -45, -30, -20, -20],
  pstEGBishop: [
    -15, -8, -8, -8, -8, 2, 0, 0, -8, 5, 8, 8, -8, 0, 8, 12,
    -8, 2, 8, 12, -8, 0, 5, 8, -8, 0, 0, 0, -15, -8, -8, -8],
  pstEGRook: [
    4, 6, 8, 10, 12, 14, 16, 16, 4, 6, 8, 8, 0, 4, 6, 6,
    -2, 2, 4, 4, -4, 0, 2, 2, -6, -2, 0, 0, -8, -4, -2, 0],
  pstEGQueen: [
    -20, -12, -8, -4, -12, -4, 0, 4, -8, 4, 10, 14, -4, 8, 14, 20,
    -4, 8, 14, 20, -8, 4, 10, 14, -12, -4, 0, 4, -20, -12, -8, -4],
  pstEGKing: [
    -50, -30, -25, -25, -30, -15, -10, -8, -25, -10, 20, 28, -25, -8, 28, 38,
    -25, -8, 28, 38, -25, -10, 20, 28, -30, -20, -12, -8, -50, -35, -30, -28],
  doubledMG: 12, doubledEG: 22, isolatedMG: 14, isolatedEG: 16,
  shieldMG: 14,
  pairMG: 25, pairEG: 45,
  mobMG: [4, 5, 2, 1], mobEG: [3, 3, 4, 2],           // 马 象 车 后,每安全格
  passedMG: [3, 6, 12, 24, 45, 75],                   // 相对横线 2..7
  passedEG: [8, 14, 24, 42, 72, 120],
  kingAtk: [10, 8, 6, 3], kingAtkScale: 10,           // 马 象 车 后 攻击者 + 总缩放
  tempo: 15,
};

export const EVAL_P = new Float64Array(N_EVAL_PARAMS);
{
  const put = (base, arr) => { for (let i = 0; i < arr.length; i++) EVAL_P[base + i] = arr[i]; };
  if (FITTED) {
    EVAL_P.set(FITTED);
  } else {
    put(EVAL_IDX.VAL_MG, HAND.valMG);
    put(EVAL_IDX.VAL_EG, HAND.valEG);
    put(EVAL_IDX.PST_MG_PAWN, HAND.pstMGPawn);
    put(EVAL_IDX.PST_MG_KNIGHT, HAND.pstMGKnight);
    put(EVAL_IDX.PST_MG_BISHOP, HAND.pstMGBishop);
    put(EVAL_IDX.PST_MG_ROOK, HAND.pstMGRook);
    put(EVAL_IDX.PST_MG_QUEEN, HAND.pstMGQueen);
    put(EVAL_IDX.PST_MG_KING, HAND.pstMGKing);
    put(EVAL_IDX.PST_EG_PAWN, HAND.pstEGPawn);
    put(EVAL_IDX.PST_EG_KNIGHT, HAND.pstEGKnight);
    put(EVAL_IDX.PST_EG_BISHOP, HAND.pstEGBishop);
    put(EVAL_IDX.PST_EG_ROOK, HAND.pstEGRook);
    put(EVAL_IDX.PST_EG_QUEEN, HAND.pstEGQueen);
    put(EVAL_IDX.PST_EG_KING, HAND.pstEGKing);
    EVAL_P[EVAL_IDX.DOUBLED_MG] = HAND.doubledMG;
    EVAL_P[EVAL_IDX.DOUBLED_EG] = HAND.doubledEG;
    EVAL_P[EVAL_IDX.ISOLATED_MG] = HAND.isolatedMG;
    EVAL_P[EVAL_IDX.ISOLATED_EG] = HAND.isolatedEG;
    EVAL_P[EVAL_IDX.SHIELD_MG] = HAND.shieldMG;
    EVAL_P[EVAL_IDX.PAIR_MG] = HAND.pairMG;
    EVAL_P[EVAL_IDX.PAIR_EG] = HAND.pairEG;
    put(EVAL_IDX.MOB_MG, HAND.mobMG);
    put(EVAL_IDX.MOB_EG, HAND.mobEG);
    put(EVAL_IDX.PASSED_MG, HAND.passedMG);
    put(EVAL_IDX.PASSED_EG, HAND.passedEG);
    put(EVAL_IDX.KATK, HAND.kingAtk);
    EVAL_P[EVAL_IDX.KATK + 4] = HAND.kingAtkScale;
    EVAL_P[EVAL_IDX.TEMPO] = HAND.tempo;
  }
}

/* ============================================================
 * 特征计算(热路径,全部复用模块级缓冲,不分配)
 * ============================================================ */
const ND8 = new Int8Array([1, 2, 2, 1, -1, 2, -2, 1, 1, -2, 2, -1, -1, -2, -2, -1]);
const DD4 = new Int8Array([1, 1, 1, -1, -1, 1, -1, -1]);
const OD4 = new Int8Array([1, 0, -1, 0, 0, 1, 0, -1]);

const SHIELD = [new Int32Array(8), new Int32Array(8)];
for (let r = 0; r < 8; r++) {
  let m = 0;
  if (r - 1 >= 0) m |= 1 << (r - 1);
  if (r - 2 >= 0) m |= 1 << (r - 2);
  SHIELD[0][r] = m;
  m = 0;
  if (r + 1 < 8) m |= 1 << (r + 1);
  if (r + 2 < 8) m |= 1 << (r + 2);
  SHIELD[1][r] = m;
}

/* 稀疏特征项:idx → 参数下标,val → 有符号计数(白正黑负)。
 * MG 槽位按 phase/24、EG 槽位按 (24−phase)/24 混合,与 evaluate 的插值一致。 */
const T_IDX = new Int32Array(192), T_VAL = new Int32Array(192);   // MG 槽
const U_IDX = new Int32Array(192), U_VAL = new Int32Array(192);   // EG 槽
let nT = 0, nU = 0, curPhase = 0;

const wPawnM = new Int32Array(8), bPawnM = new Int32Array(8);     // 每列:该色兵所在行的位掩码
const wPawnF = new Int32Array(8), bPawnF = new Int32Array(8);
const wAtkRow = new Int32Array(8), bAtkRow = new Int32Array(8);   // 每行:被该色兵攻击的列位掩码
const PC_SQ = new Int32Array(32), PC_TY = new Int32Array(32), PC_COL = new Int32Array(32);
const PN_SQ = new Int32Array(32), PN_COL = new Int32Array(32);
const zoneMark = new Int32Array(64);

const hsq32 = (t) => (t >> 3) * 4 + Math.min(t & 7, 7 - (t & 7));

function evalTerms(pos) {
  const b = pos.b;
  nT = 0; nU = 0;
  wPawnM.fill(0); bPawnM.fill(0); wPawnF.fill(0); bPawnF.fill(0);
  wAtkRow.fill(0); bAtkRow.fill(0);
  const wCnt = [0, 0, 0, 0, 0, 0, 0], bCnt = [0, 0, 0, 0, 0, 0, 0];
  let phase = 0, wb = 0, bb = 0, np = 0, npn = 0;

  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (!p) continue;
    const col = p >> 3, ty = p & 7;
    const t = col === WHITE ? s : s ^ 56;
    const sg = col === WHITE ? 1 : -1;
    if (col === WHITE) wCnt[ty]++; else bCnt[ty]++;
    phase += PHASE_W[ty];
    if (ty === PAWN) {
      const f = s & 7, r = s >> 3;
      if (col === WHITE) {
        wPawnF[f]++; wPawnM[f] |= 1 << r;
        if (r - 1 >= 0) wAtkRow[r - 1] |= (f > 0 ? 1 << (f - 1) : 0) | (f < 7 ? 1 << (f + 1) : 0);
      } else {
        bPawnF[f]++; bPawnM[f] |= 1 << r;
        if (r + 1 < 8) bAtkRow[r + 1] |= (f > 0 ? 1 << (f - 1) : 0) | (f < 7 ? 1 << (f + 1) : 0);
      }
      PN_SQ[npn] = s; PN_COL[npn] = col; npn++;
      T_IDX[nT] = EVAL_IDX.PST_MG_PAWN + t; T_VAL[nT++] = sg;
      U_IDX[nU] = EVAL_IDX.PST_EG_PAWN + hsq32(t); U_VAL[nU++] = sg;
    } else if (ty === KNIGHT || ty === BISHOP || ty === ROOK || ty === QUEEN) {
      PC_SQ[np] = s; PC_TY[np] = ty; PC_COL[np] = col; np++;
      const mgBase = ty === KNIGHT ? EVAL_IDX.PST_MG_KNIGHT : ty === BISHOP ? EVAL_IDX.PST_MG_BISHOP
        : ty === ROOK ? EVAL_IDX.PST_MG_ROOK : EVAL_IDX.PST_MG_QUEEN;
      const egBase = EVAL_IDX.PST_EG_KNIGHT + (ty - KNIGHT) * 32;
      T_IDX[nT] = mgBase + hsq32(t); T_VAL[nT++] = sg;
      U_IDX[nU] = egBase + hsq32(t); U_VAL[nU++] = sg;
      if (ty === BISHOP) { if (col === WHITE) wb++; else bb++; }
    } else {                                        // KING
      T_IDX[nT] = EVAL_IDX.PST_MG_KING + t; T_VAL[nT++] = sg;
      U_IDX[nU] = EVAL_IDX.PST_EG_KING + hsq32(t); U_VAL[nU++] = sg;
    }
  }

  // 子力(P..Q,王无子力项)
  for (let ty = PAWN; ty <= QUEEN; ty++) {
    const d = wCnt[ty] - bCnt[ty];
    if (d) { T_IDX[nT] = EVAL_IDX.VAL_MG + ty - PAWN; T_VAL[nT++] = d; U_IDX[nU] = EVAL_IDX.VAL_EG + ty - PAWN; U_VAL[nU++] = d; }
  }

  // 兵结构:叠兵 / 孤立兵(与旧 evaluate 同口径;特征方向 = 敌方缺陷 − 己方缺陷,
  // 权重为正即罚分幅值:白方叠兵使白方分下降)
  let wDoub = 0, bDoub = 0, wIso = 0, bIso = 0;
  for (let f = 0; f < 8; f++) {
    const wf = wPawnF[f], bf = bPawnF[f];
    if (wf > 1) wDoub += wf - 1;
    if (bf > 1) bDoub += bf - 1;
    const wl = f === 0 ? 0 : wPawnF[f - 1], wr = f === 7 ? 0 : wPawnF[f + 1];
    if (wf && !wl && !wr) wIso += wf;
    const bl = f === 0 ? 0 : bPawnF[f - 1], br = f === 7 ? 0 : bPawnF[f + 1];
    if (bf && !bl && !br) bIso += bf;
  }
  if (wDoub !== bDoub) {
    T_IDX[nT] = EVAL_IDX.DOUBLED_MG; T_VAL[nT++] = bDoub - wDoub;
    U_IDX[nU] = EVAL_IDX.DOUBLED_EG; U_VAL[nU++] = bDoub - wDoub;
  }
  if (wIso !== bIso) {
    T_IDX[nT] = EVAL_IDX.ISOLATED_MG; T_VAL[nT++] = bIso - wIso;
    U_IDX[nU] = EVAL_IDX.ISOLATED_EG; U_VAL[nU++] = bIso - wIso;
  }

  // 王盾(只在还有中局成分时计入;残局王要出去干活)
  if (phase > 8) {
    let wMiss = 0, bMiss = 0;
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
      if (col === WHITE) wMiss = miss; else bMiss = miss;
    }
    if (wMiss !== bMiss) { T_IDX[nT] = EVAL_IDX.SHIELD_MG; T_VAL[nT++] = bMiss - wMiss; }
  }

  // 双象
  const pair = (wb >= 2 ? 1 : 0) - (bb >= 2 ? 1 : 0);
  if (pair) {
    T_IDX[nT] = EVAL_IDX.PAIR_MG; T_VAL[nT++] = pair;
    U_IDX[nU] = EVAL_IDX.PAIR_EG; U_VAL[nU++] = pair;
  }

  // 通路兵:前方三列(含本列)无敌兵 ⇒ 按相对横线计(白兵横线 = 8−r,黑兵 = r+1)
  for (let i = 0; i < npn; i++) {
    const s = PN_SQ[i], col = PN_COL[i];
    const r = s >> 3, c = s & 7;
    let passed = true;
    if (col === WHITE) {
      const ahead = (1 << r) - 1;                    // 行 0..r−1
      for (let f = c - 1; f <= c + 1 && passed; f++) {
        if (f < 0 || f > 7) continue;
        if (bPawnM[f] & ahead) passed = false;
      }
    } else {
      const ahead = ~((1 << (r + 1)) - 1);           // 行 r+1..7
      for (let f = c - 1; f <= c + 1 && passed; f++) {
        if (f < 0 || f > 7) continue;
        if (wPawnM[f] & ahead) passed = false;
      }
    }
    if (!passed) continue;
    const rank = col === WHITE ? 8 - r : r + 1;
    if (rank < 2 || rank > 7) continue;              // 1/8 横线不可达
    const sg = col === WHITE ? 1 : -1;
    T_IDX[nT] = EVAL_IDX.PASSED_MG + rank - 2; T_VAL[nT++] = sg;
    U_IDX[nU] = EVAL_IDX.PASSED_EG + rank - 2; U_VAL[nU++] = sg;
  }

  // 机动性 + 王区威胁 融合扫描(单次射线遍历同时做两件事,精确等价于原先的两段独立扫描:
  // 两者都沿射线走到第一个阻挡者为止,途经格既可能是"安全机动格"也可能是"王区格")。
  // np===0(无马/象/车/后)时两组特征恒为零,整段跳过。
  const wAtk = [0, 0, 0, 0], bAtk = [0, 0, 0, 0];   // 按 攻击方子的类型:马 象 车 后
  if (np) {
    // 两个王的危险区可能重叠(王相距两格),用位标志共存:bit0 = 白王区,bit1 = 黑王区
    zoneMark.fill(0);
    for (let col = 0; col < 2; col++) {
      const ks = pos.ks[col], kr = ks >> 3, kc = ks & 7;
      const bit = col === WHITE ? 1 : 2;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const r = kr + dr, c = kc + dc;
        if (r < 0 || r > 7 || c < 0 || c > 7) continue;
        zoneMark[r * 8 + c] |= bit;
      }
    }
    for (let i = 0; i < np; i++) {
      const s = PC_SQ[i], ty = PC_TY[i], col = PC_COL[i];
      const r0 = s >> 3, c0 = s & 7;
      const atk = col === WHITE ? bAtkRow : wAtkRow;
      const zone = col === WHITE ? 2 : 1;            // 白子攻黑王区,黑子攻白王区
      let n = 0, hits = false;
      if (ty === KNIGHT) {
        for (let k = 0; k < 16; k += 2) {
          const r = r0 + ND8[k], c = c0 + ND8[k + 1];
          if (r < 0 || r > 7 || c < 0 || c > 7) continue;
          const q = r * 8 + c;
          if (zoneMark[q] & zone) hits = true;        // 马的攻击目标不过滤占用(与原版一致)
          const v = b[q];
          if (v && (v >> 3) === col) continue;
          if (!((atk[r] >> c) & 1)) n++;
        }
      } else {
        const diag = ty === BISHOP || ty === QUEEN, orth = ty === ROOK || ty === QUEEN;
        for (let k = 0; k < 16; k += 2) {
          const isD = k < 8;
          if (isD ? !diag : !orth) continue;
          const dr = isD ? DD4[k] : OD4[k], dc = isD ? DD4[k + 1] : OD4[k + 1];
          let r = r0 + dr, c = c0 + dc;
          while (r >= 0 && r < 8 && c >= 0 && c < 8) {
            const q = r * 8 + c;
            if (zoneMark[q] & zone) hits = true;      // 途经或阻挡格在王区 ⇒ 命中
            const v = b[q];
            if (!v) { if (!((atk[r] >> c) & 1)) n++; }
            else { if ((v >> 3) !== col && !((atk[r] >> c) & 1)) n++; break; }
            r += dr; c += dc;
          }
        }
      }
      const sg = col === WHITE ? 1 : -1;
      if (n) {
        T_IDX[nT] = EVAL_IDX.MOB_MG + ty - KNIGHT; T_VAL[nT++] = sg * n;
        U_IDX[nU] = EVAL_IDX.MOB_EG + ty - KNIGHT; U_VAL[nU++] = sg * n;
      }
      if (hits) {
        if (col === WHITE) wAtk[ty - KNIGHT]++; else bAtk[ty - KNIGHT]++;
      }
    }
    zoneMark.fill(0);
    for (let k = 0; k < 4; k++) {
      if (wAtk[k] !== bAtk[k]) { T_IDX[nT] = EVAL_IDX.KATK + k; T_VAL[nT++] = wAtk[k] - bAtk[k]; }
    }
    const wTot = Math.min(wAtk[0] + wAtk[1] + wAtk[2] + wAtk[3], 8);
    const bTot = Math.min(bAtk[0] + bAtk[1] + bAtk[2] + bAtk[3], 8);
    if (wTot !== bTot) { T_IDX[nT] = EVAL_IDX.KATK + 4; T_VAL[nT++] = wTot - bTot; }
  }

  curPhase = phase;
}

/** 局面分,返回「走子方视角」的厘兵值。挂了增量状态(pos.evS)走 O(1) 快路径,
 * 否则全量重算(与特征导出共用 evalTerms,S0-2 验收口径)。 */
export function evaluate(pos) {
  return pos.evS ? evScore(pos) : evaluateFull(pos);
}

/** 全量路径。两条精确短路(数值恒等,非近似):相位=24 时 EG 权重恒 0,跳过整段
 * EG 点积;相位=0 时 MG 权重恒 0,只算 EG。 */
export function evaluateFull(pos) {
  evalTerms(pos);
  let mg = 0;
  for (let i = 0; i < nT; i++) mg += EVAL_P[T_IDX[i]] * T_VAL[i];
  let sc;
  if (curPhase === PHASE_MAX) sc = mg;
  else {
    let eg = 0;
    for (let i = 0; i < nU; i++) eg += EVAL_P[U_IDX[i]] * U_VAL[i];
    sc = curPhase === 0 ? eg : (mg * curPhase + eg * (PHASE_MAX - curPhase)) / PHASE_MAX;
  }
  const v = sc < 0 ? -(-sc | 0) : (sc | 0);
  return pos.stm === WHITE ? v : -v;
}

/** 491 维稠密特征向量(白方视角,MG 槽 ×phase/24、EG 槽 ×(24−phase)/24,tempo ×1)。
 * 供调参器:`label ≈ dot(evalFeatures(pos), w)`。 */
export function evalFeatures(pos, out) {
  const g = out || new Float64Array(N_EVAL_PARAMS);
  g.fill(0);
  evalTerms(pos);
  const ph = curPhase;
  for (let i = 0; i < nT; i++) g[T_IDX[i]] += T_VAL[i] * ph / PHASE_MAX;
  for (let i = 0; i < nU; i++) g[U_IDX[i]] += U_VAL[i] * (PHASE_MAX - ph) / PHASE_MAX;
  g[EVAL_IDX.TEMPO] = pos.stm === WHITE ? 1 : -1;
  return g;
}

/** 调参/测试用:与 evaluate 等价的未取整白方视角分(dot(g, P)) */
export function evalDot(pos, w) {
  const g = evalFeatures(pos);
  let s = 0;
  for (let i = 0; i < N_EVAL_PARAMS; i++) s += g[i] * w[i];
  return s;
}


/* ============================================================
 * 增量评估(T1-3):make 时只重算受影响的子,evaluate 变 O(1) 读聚合。
 *
 * 状态挂在 pos.evS(evAttach 创建/重建);rules.js 的 make/unmake/loadPosition
 * 调用 evAfterMake/evBeforeUnmake/evRebuild 维护;撤销用整帧快照
 * (每步 ~200B 拷贝),unmake 侧零逻辑 ⇒ 撤销路径没有出错面。
 * 语义与 evalTerms 全量路径逐项对齐(整数累加,顺序无关 ⇒ 应逐位相等,
 * test/incremental-test.mjs 用随机游走逐步断言)。
 * ============================================================ */
const EV_MAX_PLY = 512;   // 对局 ply(≤~400,50 步规则封顶)+ 搜索 ply(≤62)+ 余量

/* 每子每格的静态查表:(子编码<<6)|格 → 白方视角有符号 (VAL+PST),MG/EG 各一张 */
export const STAT_MG = new Float64Array(16 * 64), STAT_EG = new Float64Array(16 * 64);
{
  for (let pc = 0; pc < 16; pc++) {
    if ((pc & 7) === 0 || (pc & 7) === 6) continue;      // 空格/王无子力项,王单独有 PST
    const ty = pc & 7, col = pc >> 3, sg = col === 0 ? 1 : -1;
    const mgBase = ty === 1 ? EVAL_IDX.PST_MG_PAWN
      : ty === 2 ? EVAL_IDX.PST_MG_KNIGHT : ty === 3 ? EVAL_IDX.PST_MG_BISHOP
        : ty === 4 ? EVAL_IDX.PST_MG_ROOK : EVAL_IDX.PST_MG_QUEEN;
    for (let s = 0; s < 64; s++) {
      const t = col === 0 ? s : s ^ 56;
      // MG:兵是全 64 格表(索引 t),其余半表;EG:六张全是半表(索引 hsq32)
      const hm = (ty === 1) ? t : hsq32(t);
      STAT_MG[(pc << 6) | s] = sg * (EVAL_P[EVAL_IDX.VAL_MG + ty - 1] + EVAL_P[mgBase + hm]);
      STAT_EG[(pc << 6) | s] = sg * (EVAL_P[EVAL_IDX.VAL_EG + ty - 1] + EVAL_P[EVAL_IDX.PST_EG_KNIGHT + (ty - 2) * 32 + hsq32(t)]);
    }
  }
  // 王:无子力项,只有 PST(MG 全表 64,EG 半表)
  for (let col = 0; col < 2; col++) {
    const sg = col === 0 ? 1 : -1;
    for (let s = 0; s < 64; s++) {
      const t = col === 0 ? s : s ^ 56;
      STAT_MG[((col << 3) | 6) << 6 | s] = sg * EVAL_P[EVAL_IDX.PST_MG_KING + t];
      STAT_EG[((col << 3) | 6) << 6 | s] = sg * EVAL_P[EVAL_IDX.PST_EG_KING + hsq32(t)];
    }
  }
}

/* 兵结构:某列的叠兵+孤立兵贡献(白方视角)。与 evalTerms 同口径:
 * 特征方向 = 敌方缺陷 − 己方缺陷,正权重 = 罚分幅值 */
function fileStruct(f, wPF, bPF) {
  const wf = wPF[f], bf = bPF[f];
  const wl = f > 0 ? wPF[f - 1] : 0, wr = f < 7 ? wPF[f + 1] : 0;
  const bl = f > 0 ? bPF[f - 1] : 0, br = f < 7 ? bPF[f + 1] : 0;
  const wd = wf > 1 ? wf - 1 : 0, bd = bf > 1 ? bf - 1 : 0;
  const wi = (wf && !wl && !wr) ? wf : 0, bi = (bf && !bl && !br) ? bf : 0;
  return [
    EVAL_P[EVAL_IDX.DOUBLED_MG] * (bd - wd) + EVAL_P[EVAL_IDX.ISOLATED_MG] * (bi - wi),
    EVAL_P[EVAL_IDX.DOUBLED_EG] * (bd - wd) + EVAL_P[EVAL_IDX.ISOLATED_EG] * (bi - wi),
  ];
}

/* 融合单子扫描:机动数 + 王区命中(与 evalTerms 融合段逐句同语义) */
export function fusedPiece(b, s, ty, col, atkW, atkB, zoneW, zoneB) {
  const r0 = s >> 3, c0 = s & 7;
  const atk = col === WHITE ? atkB : atkW;                   // 己方视角看敌方兵攻击行
  const zone = col === WHITE ? zoneB : zoneW;
  let n = 0, hits = false;
  if (ty === KNIGHT) {
    for (let i = N_ATK_LO[s]; i < N_ATK_LO[s + 1]; i++) {
      const q = N_ATK[i], r = q >> 3, c = q & 7;
      if (zone[q]) hits = true;
      const v = b[q];
      if (v && (v >> 3) === col) continue;
      if (!((atk[r] >> c) & 1)) n++;
    }
  } else {
    // ⚠ 特征定义的历史缺陷(bug 兼容,见 docs/chess-eval-training-report.md 附录 E):
    // evalTerms 的滑子扫描自最初实现起就以 k<16 索引 8 元素的 DD4/OD4,正交方向
    // 全部落空 ⇒ 车的机动性恒 0、后只数斜线;王区命中同理(车永不计、后仅斜线)。
    // 全部训练与 A/B(+56)都是在这套特征定义上完成的,拟合时零方差列退回先验。
    // 增量路径必须与 evalTerms 逐位一致,因此这里同样只走斜线;修复需重生成数据
    // 重拟合后一并放开(届时恢复 ortho 段即可)。
    const diag = ty === BISHOP || ty === QUEEN;
    if (diag) {
      for (let dir = 0; dir < 4; dir++) {
        for (let i = DIAG_SEG[s * 4 + dir]; i < DIAG_SEG[s * 4 + dir + 1]; i++) {
          const q = DIAG_RAY[i], r = q >> 3, c = q & 7;
          if (zone[q]) hits = true;
          const v = b[q];
          if (!v) { if (!((atk[r] >> c) & 1)) n++; }
          else { if ((v >> 3) !== col && !((atk[r] >> c) & 1)) n++; break; }
        }
      }
    }
  }
  return n | (hits ? 256 : 0);                               // 打包:n 低 8 位,hits 位 8
}

/* 王盾重算(与 evalTerms 同口径:phase>8 才算,特征 = 敌方缺盾 − 己方缺盾) */
function shieldCalc(pos, wPM, bPM, phase) {
  if (phase <= 8) return 0;
  let wMiss = 0, bMiss = 0;
  for (let col = 0; col < 2; col++) {
    const ks = pos.ks[col], kr = ks >> 3, kc = ks & 7;
    const sm = SHIELD[col][kr];
    if (!sm) continue;
    const mask = col === WHITE ? wPM : bPM;
    let miss = 0;
    for (let df = -1; df <= 1; df++) {
      const f = kc + df;
      if (f < 0 || f > 7) continue;
      if (!(mask[f] & sm)) miss++;
    }
    if (col === WHITE) wMiss = miss; else bMiss = miss;
  }
  return EVAL_P[EVAL_IDX.SHIELD_MG] * (bMiss - wMiss);
}

export function evAttach(pos) {
  pos.evS = {
    top: 0,
    mg: 0, eg: 0, structMG: 0, structEG: 0, pairMG: 0, pairEG: 0,
    passMG: 0, passEG: 0, shieldMG: 0,
    mob: new Int32Array(8), atk: new Int32Array(8),
    mobN: new Uint8Array(64), mobH: new Uint8Array(64),
    passF: new Uint8Array(64),
    wPF: new Int32Array(8), bPF: new Int32Array(8),
    wPM: new Int32Array(8), bPM: new Int32Array(8),
    wb: 0, bb: 0, phase: 0,
    ctxAtkW: new Int32Array(8), ctxAtkB: new Int32Array(8), ctxZoneW: new Uint8Array(64), ctxZoneB: new Uint8Array(64),
    scratchFileMark: new Uint8Array(8), scratchFileList: new Int8Array(8), scratchSpots: new Int8Array(32),
    sSC: new Float64Array(EV_MAX_PLY * 11),   // mg eg structMG structEG pairMG pairEG passMG passEG shieldMG wb bb
    sPH: new Int32Array(EV_MAX_PLY),
    sPLY: new Int32Array(EV_MAX_PLY),   // 每帧所属 pos.ply,弹出时校验防脱钩
    sMob: new Int32Array(EV_MAX_PLY * 16),
    sMH: new Uint8Array(EV_MAX_PLY * 128),
    sPF: new Uint8Array(EV_MAX_PLY * 64),
    sPW: new Int32Array(EV_MAX_PLY * 32),
  };
  evRebuild(pos);
}

export function evRebuild(pos) {
  const S = pos.evS, b = pos.b;
  S.mg = 0; S.eg = 0; S.structMG = 0; S.structEG = 0; S.pairMG = 0; S.pairEG = 0;
  S.passMG = 0; S.passEG = 0; S.shieldMG = 0;
  S.mob.fill(0); S.atk.fill(0); S.mobN.fill(0); S.mobH.fill(0); S.passF.fill(0);
  S.wPF.fill(0); S.bPF.fill(0); S.wPM.fill(0); S.bPM.fill(0);
  S.wb = 0; S.bb = 0; S.phase = 0;
  S.top = 0;
  // 静态 + 兵掩码 + 相位
  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (!p) continue;
    const col = p >> 3, ty = p & 7;
    S.mg += STAT_MG[(p << 6) | s];
    S.eg += STAT_EG[(p << 6) | s];
    S.phase += PHASE_W[ty];
    if (ty === PAWN) {
      const f = s & 7, r = s >> 3;
      if (col === WHITE) { S.wPF[f]++; S.wPM[f] |= 1 << r; }
      else { S.bPF[f]++; S.bPM[f] |= 1 << r; }
    } else if (ty === BISHOP) { if (col === WHITE) S.wb++; else S.bb++; }
  }
  for (let f = 0; f < 8; f++) {
    const c = fileStruct(f, S.wPF, S.bPF);
    S.structMG += c[0]; S.structEG += c[1];
  }
  S.pairMG = EVAL_P[EVAL_IDX.PAIR_MG] * ((S.wb >= 2 ? 1 : 0) - (S.bb >= 2 ? 1 : 0));
  S.pairEG = EVAL_P[EVAL_IDX.PAIR_EG] * ((S.wb >= 2 ? 1 : 0) - (S.bb >= 2 ? 1 : 0));
  S.shieldMG = shieldCalc(pos, S.wPM, S.bPM, S.phase);
  // 通路兵 + 融合机动/王区(临时上下文)
  evCtx(pos, S);
  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (!p) continue;
    const col = p >> 3, ty = p & 7;
    if (ty === PAWN) {
      const rel = evPassedRank(b, s, col, S);
      if (rel) {
        S.passF[s] = rel;
        const v = col === WHITE ? EVAL_P[EVAL_IDX.PASSED_MG + rel - 2] : -EVAL_P[EVAL_IDX.PASSED_MG + rel - 2];
        const ve = col === WHITE ? EVAL_P[EVAL_IDX.PASSED_EG + rel - 2] : -EVAL_P[EVAL_IDX.PASSED_EG + rel - 2];
        S.passMG += v; S.passEG += ve;
      }
    } else if (ty !== KING) {
      const nh = fusedPiece(b, s, ty, col, S.ctxAtkW, S.ctxAtkB, S.ctxZoneW, S.ctxZoneB);
      S.mobN[s] = nh & 255; S.mobH[s] = nh >> 8;
      const idx = (col << 2) | (ty - KNIGHT);
      S.mob[idx] += nh & 255; S.atk[idx] += nh >> 8;
    }
  }
}

/* 上下文:敌兵攻击行 + 两王危险区(zoneW: 白王的区 bit0… 改为两份 0/1 数组便于 fusedPiece) */
export function evCtx(pos, S) {
  // 无分配:填充挂在 S 上的持久缓冲(evRebuild 之外的调用方都是 make 热路径)
  const atkW = S.ctxAtkW, atkB = S.ctxAtkB, zoneW = S.ctxZoneW, zoneB = S.ctxZoneB;
  atkW.fill(0); atkB.fill(0); zoneW.fill(0); zoneB.fill(0);
  for (let f = 0; f < 8; f++) {
    let m = S.wPM[f];
    while (m) {
      const r = 31 - Math.clz32(m & -m);
      if (r - 1 >= 0) atkW[r - 1] |= (f > 0 ? 1 << (f - 1) : 0) | (f < 7 ? 1 << (f + 1) : 0);
      m &= m - 1;
    }
    m = S.bPM[f];
    while (m) {
      const r = 31 - Math.clz32(m & -m);
      if (r + 1 < 8) atkB[r + 1] |= (f > 0 ? 1 << (f - 1) : 0) | (f < 7 ? 1 << (f + 1) : 0);
      m &= m - 1;
    }
  }
  for (let col = 0; col < 2; col++) {
    const ks = pos.ks[col], kr = ks >> 3, kc = ks & 7;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const r = kr + dr, c = kc + dc;
      if (r < 0 || r > 7 || c < 0 || c > 7) continue;
      (col === WHITE ? zoneW : zoneB)[r * 8 + c] = 1;
    }
  }
  return S;
}

/* 通路兵相对横线(2..7),否则 0 —— 与 evalTerms 同口径 */
function evPassedRank(b, s, col, S) {
  const r = s >> 3, c = s & 7;
  if (col === WHITE) {
    const ahead = (1 << r) - 1;
    for (let f = Math.max(0, c - 1); f <= Math.min(7, c + 1); f++) if (S.bPM[f] & ahead) return 0;
    const rel = 8 - r;
    return rel >= 2 && rel <= 7 ? rel : 0;
  }
  const ahead = ~((1 << (r + 1)) - 1);
  for (let f = Math.max(0, c - 1); f <= Math.min(7, c + 1); f++) if (S.wPM[f] & ahead) return 0;
  const rel = r + 1;
  return rel >= 2 && rel <= 7 ? rel : 0;
}

/* ---------- 快照 ---------- */
function pushSnap(S, ply) {
  S.sPLY[S.top] = ply;
  const k = S.top;
  const sc = S.sSC, off = k * 11;
  sc[off] = S.mg; sc[off + 1] = S.eg; sc[off + 2] = S.structMG; sc[off + 3] = S.structEG;
  sc[off + 4] = S.pairMG; sc[off + 5] = S.pairEG; sc[off + 6] = S.passMG; sc[off + 7] = S.passEG;
  sc[off + 8] = S.shieldMG; sc[off + 9] = S.wb; sc[off + 10] = S.bb;
  S.sPH[k] = S.phase;
  S.sMob.set(S.mob.subarray(0, 8), k * 16);
  S.sMob.set(S.atk.subarray(0, 8), k * 16 + 8);
  S.sMH.set(S.mobN, k * 128);
  S.sMH.set(S.mobH, k * 128 + 64);
  S.sPF.set(S.passF, k * 64);
  const pw = S.sPW, o = k * 32;
  pw.set(S.wPF, o); pw.set(S.bPF, o + 8); pw.set(S.wPM, o + 16); pw.set(S.bPM, o + 24);
  S.top++;
}
function popSnap(S) {
  S.top--;
  const k = S.top, sc = S.sSC, off = k * 11;
  S.mg = sc[off]; S.eg = sc[off + 1]; S.structMG = sc[off + 2]; S.structEG = sc[off + 3];
  S.pairMG = sc[off + 4]; S.pairEG = sc[off + 5]; S.passMG = sc[off + 6]; S.passEG = sc[off + 7];
  S.shieldMG = sc[off + 8]; S.wb = sc[off + 9]; S.bb = sc[off + 10];
  S.phase = S.sPH[k];
  S.mob.set(S.sMob.subarray(k * 16, k * 16 + 8));
  S.atk.set(S.sMob.subarray(k * 16 + 8, k * 16 + 16));
  S.mobN.set(S.sMH.subarray(k * 128, k * 128 + 64));
  S.mobH.set(S.sMH.subarray(k * 128 + 64, k * 128 + 128));
  S.passF.set(S.sPF.subarray(k * 64, k * 64 + 64));
  const pw = S.sPW, o = k * 32;
  S.wPF.set(pw.subarray(o, o + 8)); S.bPF.set(pw.subarray(o + 8, o + 16));
  S.wPM.set(pw.subarray(o + 16, o + 24)); S.bPM.set(pw.subarray(o + 24, o + 32));
}

/* ---------- make 后差分更新 ---------- */
export function evAfterMake(pos, m) {
  const S = pos.evS;
  if (S.top >= EV_MAX_PLY) { evRebuild(pos); return; }       // 栈满兜底:重建后 sPLY 校验让后续弹出自愈
  pushSnap(S, pos.ply);
  const b = pos.b;
  const from = mFrom(m), to = mTo(m), f = mFlag(m), cap = mCap(m);
  const pcPost = b[to], col = pcPost >> 3;
  const tyPre = f >= 6 ? PAWN : (pcPost & 7);
  const capSq = f === F_EP ? to + (col === WHITE ? 8 : -8) : to;
  const fromF = from & 7, toF = to & 7, capF = capSq & 7;

  // 受影响文件集合(兵结构 + 通路兵重算范围):from/to/capSq 三列各 ±1。
  // 无分配:S 上的标志位数组 + 紧凑列表
  const fileMark = S.scratchFileMark, fileList = S.scratchFileList;
  let nFiles = 0;
  const addF = (x) => {
    for (let f2 = x - 1; f2 <= x + 1; f2++) {
      if (f2 < 0 || f2 > 7 || fileMark[f2]) continue;
      fileMark[f2] = 1; fileList[nFiles++] = f2;
    }
  };
  addF(fromF); if (cap || f === F_EP) addF(capF); if (tyPre === PAWN && fromF !== toF) addF(toF);
  for (let i = 0; i < nFiles; i++) fileMark[fileList[i]] = 0;   // 清标志供通路兵段复用(列表仍有效)

  // —— 兵结构:旧贡献 → 更新掩码 → 新贡献 ——
  let oldMG = 0, oldEG = 0;
  for (let i = 0; i < nFiles; i++) { const c = fileStruct(fileList[i], S.wPF, S.bPF); oldMG += c[0]; oldEG += c[1]; }
  // 掩码更新
  if (tyPre === PAWN) {
    if (col === WHITE) { S.wPF[fromF]--; S.wPM[fromF] &= ~(1 << (from >> 3)); }
    else { S.bPF[fromF]--; S.bPM[fromF] &= ~(1 << (from >> 3)); }
    if (f < 6) {  // 仍是兵(直走/吃子),落到 to
      if (col === WHITE) { S.wPF[toF]++; S.wPM[toF] |= 1 << (to >> 3); }
      else { S.bPF[toF]++; S.bPM[toF] |= 1 << (to >> 3); }
    }
  }
  if (cap && (cap & 7) === PAWN) {
    if ((cap >> 3) === WHITE) { S.wPF[capF]--; S.wPM[capF] &= ~(1 << (capSq >> 3)); }
    else { S.bPF[capF]--; S.bPM[capF] &= ~(1 << (capSq >> 3)); }
  }
  let newMG = 0, newEG = 0;
  for (let i = 0; i < nFiles; i++) { const c = fileStruct(fileList[i], S.wPF, S.bPF); newMG += c[0]; newEG += c[1]; }
  S.structMG += newMG - oldMG; S.structEG += newEG - oldEG;

  // —— 静态(子力+PST)+ 相位 + 象数 ——
  const pcPre = (col << 3) | tyPre;
  S.mg += STAT_MG[(pcPost << 6) | to] - STAT_MG[(pcPre << 6) | from];
  S.eg += STAT_EG[(pcPost << 6) | to] - STAT_EG[(pcPre << 6) | from];
  S.phase += PHASE_W[pcPost & 7] - PHASE_W[tyPre];
  if (tyPre === BISHOP) { if (col === WHITE) S.wb--; else S.bb--; }
  if ((pcPost & 7) === BISHOP) { if (col === WHITE) S.wb++; else S.bb++; }
  if (cap) {
    const capTy = cap & 7, capCol = cap >> 3;
    S.mg -= STAT_MG[(cap << 6) | capSq];
    S.eg -= STAT_EG[(cap << 6) | capSq];
    S.phase -= PHASE_W[capTy];
    if (capTy === BISHOP) { if (capCol === WHITE) S.wb--; else S.bb--; }
  }
  if (f === F_OO || f === F_OOO) {
    const rf = f === F_OO ? to + 1 : to - 2, rt = f === F_OO ? to - 1 : to + 1;
    const rk = b[rt];
    S.mg += STAT_MG[(rk << 6) | rt] - STAT_MG[(rk << 6) | rf];
    S.eg += STAT_EG[(rk << 6) | rt] - STAT_EG[(rk << 6) | rf];
  }
  S.pairMG = EVAL_P[EVAL_IDX.PAIR_MG] * ((S.wb >= 2 ? 1 : 0) - (S.bb >= 2 ? 1 : 0));
  S.pairEG = EVAL_P[EVAL_IDX.PAIR_EG] * ((S.wb >= 2 ? 1 : 0) - (S.bb >= 2 ? 1 : 0));

  // —— 通路兵 ——
  // 顺序是关键:先按"各自的颜色"清掉已消失兵的 flag(被吃兵在 capSq —— 普通吃兵时
  // capSq===to,若放在重判之后会把刚落位兵的 flag 用错颜色抹掉,实测就这么错过兵),
  // 再对受影响列上现存的兵 + 落位兵以 old=0 起点干净重判。
  {
    const clearIfFlagged = (s2, col2) => {
      if (S.passF[s2]) {
        const old = S.passF[s2];
        S.passMG += (col2 === WHITE ? -1 : 1) * EVAL_P[EVAL_IDX.PASSED_MG + old - 2];
        S.passEG += (col2 === WHITE ? -1 : 1) * EVAL_P[EVAL_IDX.PASSED_EG + old - 2];
        S.passF[s2] = 0;
      }
    };
    if (tyPre === PAWN) clearIfFlagged(from, col);           // 移动/升变离开的兵
    if (cap && (cap & 7) === PAWN) clearIfFlagged(capSq, cap >> 3);
    for (let i = 0; i < nFiles; i++) fileMark[fileList[i]] = 1;
    for (let s2 = 0; s2 < 64; s2++) {
      const p = b[s2];
      if ((p & 7) !== PAWN) continue;
      const f2 = s2 & 7;
      if (!fileMark[f2] && s2 !== to) continue;
      const col2 = p >> 3;
      const rel = evPassedRank(b, s2, col2, S);
      const old = S.passF[s2];
      if (rel !== old) {
        if (old) {
          S.passMG += (col2 === WHITE ? -1 : 1) * EVAL_P[EVAL_IDX.PASSED_MG + old - 2];
          S.passEG += (col2 === WHITE ? -1 : 1) * EVAL_P[EVAL_IDX.PASSED_EG + old - 2];
        }
        if (rel) {
          S.passMG += (col2 === WHITE ? 1 : -1) * EVAL_P[EVAL_IDX.PASSED_MG + rel - 2];
          S.passEG += (col2 === WHITE ? 1 : -1) * EVAL_P[EVAL_IDX.PASSED_EG + rel - 2];
        }
        S.passF[s2] = rel;
      }
    }
    for (let i = 0; i < nFiles; i++) fileMark[fileList[i]] = 0;
  }

  // —— 王盾重算 ——
  S.shieldMG = shieldCalc(pos, S.wPM, S.bPM, S.phase);

  // —— 机动 + 王区:受影响子重扫 ——
  evCtx(pos, S);
  const rescan = (s2) => {
    const p = b[s2];
    if (!p) return;
    const ty2 = p & 7;
    if (ty2 === PAWN || ty2 === KING) return;
    const col2 = p >> 3, idx = (col2 << 2) | (ty2 - KNIGHT);
    const nh = fusedPiece(b, s2, ty2, col2, S.ctxAtkW, S.ctxAtkB, S.ctxZoneW, S.ctxZoneB);
    S.mob[idx] += (nh & 255) - S.mobN[s2];
    S.atk[idx] += (nh >> 8) - S.mobH[s2];
    S.mobN[s2] = nh & 255; S.mobH[s2] = nh >> 8;
  };
  // from:旧子已离开(可能是 N/B/R/Q);to:新子;capSq:被吃子;易位车两格
  const dropSlot = (s2, col2, ty2) => {
    const idx = (col2 << 2) | (ty2 - KNIGHT);
    S.mob[idx] -= S.mobN[s2]; S.atk[idx] -= S.mobH[s2];
    S.mobN[s2] = 0; S.mobH[s2] = 0;
  };
  if (tyPre !== PAWN && tyPre !== KING) dropSlot(from, col, tyPre);
  if (cap) { const ct = cap & 7; if (ct !== PAWN && ct !== KING) dropSlot(capSq, cap >> 3, ct); }
  if (f === F_OO || f === F_OOO) {
    const rf = f === F_OO ? to + 1 : to - 2, rt = f === F_OO ? to - 1 : to + 1;
    const rk = b[rt];
    dropSlot(rf, rk >> 3, rk & 7);                            // 车从 rf 离开
    rescan(rt);                                               // 车到 rt(下面还会再 rescan 一次,幂等)
  }
  rescan(to);
  // 影响面:from/to/capSq/易位车格 上"瞄着"的骑士与滑子,
  // 外加兵事件改变"敌方兵攻击图"的格子(安全机动性的分母):移动兵的旧/新攻击格、
  // 被吃兵的旧攻击格 —— 这些格上的 unsafe 状态变了,踩到它们的骑士/滑子机动数随之变
  const spots = S.scratchSpots;
  let nSpots = 0;
  spots[nSpots++] = from; spots[nSpots++] = to;
  if (cap || f === F_EP) spots[nSpots++] = capSq;
  if (f === F_OO || f === F_OOO) { spots[nSpots++] = f === F_OO ? to + 1 : to - 2; spots[nSpots++] = f === F_OO ? to - 1 : to + 1; }
  const pawnAtk = (sq, col2) => {
    const r = sq >> 3, c = sq & 7;
    if (col2 === WHITE) {
      if (r - 1 >= 0) { if (c > 0) spots[nSpots++] = sq - 9; if (c < 7) spots[nSpots++] = sq - 7; }
    } else {
      if (r + 1 < 8) { if (c > 0) spots[nSpots++] = sq + 7; if (c < 7) spots[nSpots++] = sq + 9; }
    }
  };
  if (tyPre === PAWN) { pawnAtk(from, col); if (f < 6) pawnAtk(to, col); }
  if (cap && (cap & 7) === PAWN) pawnAtk(capSq, cap >> 3);
  for (let si = 0; si < nSpots; si++) {
    const sq = spots[si];
    // 骑士:位于 sq 的马步目标的骑士(占位变化影响其可达格)
    for (let i = N_ATK_LO[sq]; i < N_ATK_LO[sq + 1]; i++) {
      const t = N_ATK[i], p = b[t];
      if (p && (p & 7) === KNIGHT) rescan(t);
    }
    // 滑子:8 个方向第一个占用格(若为滑子,其射线被该占位变化影响)
    for (let dir = 0; dir < 4; dir++) {
      for (let i = DIAG_SEG[sq * 4 + dir]; i < DIAG_SEG[sq * 4 + dir + 1]; i++) {
        const t = DIAG_RAY[i], p = b[t];
        if (p) { const ty2 = p & 7; if (ty2 === BISHOP || ty2 === QUEEN) rescan(t); break; }
      }
      for (let i = ORTHO_SEG[sq * 4 + dir]; i < ORTHO_SEG[sq * 4 + dir + 1]; i++) {
        const t = ORTHO_RAY[i], p = b[t];
        if (p) { const ty2 = p & 7; if (ty2 === ROOK || ty2 === QUEEN) rescan(t); break; }
      }
    }
  }
  // 王移动:该王危险区变了 → 敌方全部 N/B/R/Q 的 hits 重判(zone 变化只影响 hits)
  if (tyPre === KING) {
    const enemy = col ^ 1;
    for (let s2 = 0; s2 < 64; s2++) {
      const p = b[s2];
      if (!p || (p >> 3) !== enemy) continue;
      const ty2 = p & 7;
      if (ty2 === PAWN || ty2 === KING) continue;
      rescan(s2);
    }
  }
}

/* 空着:棋盘与评估状态都不变,但 pos.ply 会走一格 —— 必须压/弹占位帧,
 * 否则帧的 ply 校验失配,后续每次 unmake 都触发全量重建(NPS 崩到 1/4 就是这么来的) */
export function evAfterMakeNull(pos) {
  const S = pos.evS;
  if (!S) return;
  if (S.top >= EV_MAX_PLY) { evRebuild(pos); return; }
  pushSnap(S, pos.ply);
}

export function evBeforeUnmakeNull(pos) {
  const S = pos.evS;
  if (!S) return;
  if (S.top > 0 && S.sPLY[S.top - 1] === pos.ply) popSnap(S); else evRebuild(pos);
}

export function evBeforeUnmake(pos) {
  const S = pos.evS;
  // 弹帧前校验所属 ply:栈满重建会让帧与着法栈脱钩,错位时自愈重建
  if (S.top > 0 && S.sPLY[S.top - 1] === pos.ply) popSnap(S); else evRebuild(pos);
}

/* ---------- O(1) 计分 ---------- */
function evScore(pos) {
  const S = pos.evS;
  let mg = S.mg + S.structMG + S.pairMG + S.passMG + S.shieldMG;
  let eg = S.eg + S.structEG + S.pairEG + S.passEG;
  const mob = S.mob, atk = S.atk, P = EVAL_P;
  for (let k = 0; k < 4; k++) {
    mg += (mob[k] - mob[k + 4]) * P[EVAL_IDX.MOB_MG + k];
    eg += (mob[k] - mob[k + 4]) * P[EVAL_IDX.MOB_EG + k];
    mg += (atk[k] - atk[k + 4]) * P[EVAL_IDX.KATK + k];
  }
  let wt = atk[0] + atk[1] + atk[2] + atk[3]; if (wt > 8) wt = 8;
  let bt = atk[4] + atk[5] + atk[6] + atk[7]; if (bt > 8) bt = 8;
  mg += (wt - bt) * P[EVAL_IDX.KATK + 4];
  const ph = S.phase;
  let sc;
  if (ph === PHASE_MAX) sc = mg;
  else if (ph === 0) sc = eg;
  else sc = (mg * ph + eg * (PHASE_MAX - ph)) / PHASE_MAX;
  const v = sc < 0 ? -(-sc | 0) : (sc | 0);
  return pos.stm === WHITE ? v : -v;
}
