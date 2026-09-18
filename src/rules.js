/* ============================================================
 * 国际象棋棋规引擎(无渲染 / 无 DOM)
 *
 * 为什么和 UI 分开:Worker 要直接 import 它,test/engine-test.mjs
 * 也要能在 Node 里直接 import 它跑 perft。所以本文件不许 import
 * three / ogl,不许碰 document / window。
 *
 * 内部表示(对应 chess-ai-plan.md §3.2):
 *  - 棋盘 Int8Array(64) mailbox:棋子编码 (色<<3)|型,0 = 空。
 *    白 1..6、黑 9..14,所以 `if (!p)` 就是"空格",不需要额外判断。
 *  - 格子 sq = r*8+c,r=0 是 8 线(黑底线)、r=7 是 1 线(白底线),
 *    与 UI 侧历史沿用的 board[r][c] 同序,便于回归对照。
 *  - 走法 int32 打包(起/终/标志/被吃子),搜索全程零对象分配。
 *  - make/unmake 原地修改 + undo 栈,不再整盘深拷贝。
 *  - Zobrist 增量哈希 keyA/keyB 两个 32 位:置换表里两个都存,
 *    32 位单 key 在几十万节点量级会攒出可观的假命中,双 key 是廉价保险。
 * ============================================================ */

export const WHITE = 0, BLACK = 1;
export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;

export const piece = (c, t) => (c << 3) | t;
export const colorOf = (p) => p >> 3;
export const typeOf = (p) => p & 7;

/** 型 → UI/记谱用的字符 */
export const CHARS = ['', 'p', 'n', 'b', 'r', 'q', 'k'];
/** 字符 → 型 */
export const TYPES = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };

/* ---------- 走法打包 ----------
 * bit 0-5 起格 / 6-11 终格 / 12-15 标志 / 16-19 被吃子(0=无)
 * 标志:0 静着 · 1 兵双步 · 2 短易位 · 3 长易位 · 4 吃子 · 5 吃过路兵
 *       6..9  升变为 N/B/R/Q(静着)
 *       10..13 升变且吃子(升变子型号 = (标志&3)+2)
 * 单独拆出 mkMove 而不是内联,是因为生成的走法要塞进 typed array,
 * 位运算语义集中在一处才好核对。 */
export const F_QUIET = 0, F_DOUBLE = 1, F_OO = 2, F_OOO = 3, F_CAP = 4, F_EP = 5;
export const mFrom = (m) => m & 63;
export const mTo = (m) => (m >> 6) & 63;
export const mFlag = (m) => (m >> 12) & 15;
export const mCap = (m) => (m >> 16) & 15;
export const mPromo = (m) => { const f = mFlag(m); return f >= 6 ? ((f - 6) & 3) + 2 : 0; };
export const mkMove = (from, to, f, cap = 0) => from | (to << 6) | (f << 12) | (cap << 16);
/** 该走法是不是"静着"(用于剪枝判断:吃子/升变要例外) */
export const mIsQuiet = (m) => mFlag(m) === F_QUIET || mFlag(m) === F_DOUBLE;

export const NAME = (sq) => 'abcdefgh'[sq & 7] + (8 - (sq >> 3));

/* ---------- 易位权位掩码 ---------- */
export const C_WK = 1, C_WQ = 2, C_BK = 4, C_BQ = 8;

/* 四个车角 + 两个王位(SQ 编号) */
const SQ_A1 = 56, SQ_H1 = 63, SQ_A8 = 0, SQ_H8 = 7, SQ_E1 = 60, SQ_E8 = 4;

/* ---------- 方向表(扁平 Int8Array,避免热路径上解构数组) ---------- */
const ND = new Int8Array([1, 2, 2, 1, -1, 2, -2, 1, 1, -2, 2, -1, -1, -2, -2, -1]);
const KD = new Int8Array([1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1]);
const DD = new Int8Array([1, 1, 1, -1, -1, 1, -1, -1]);
const OD = new Int8Array([1, 0, -1, 0, 0, 1, 0, -1]);

/* ============================================================
 * Zobrist
 * 索引区间:棋子 (编码<<6)|格 → 0..1023;1024 走子权;1025..1040 易位权;
 * 1041..1048 吃过路兵目标格所在的线(列)。
 * 随机数用 mulberry32(与黑白棋同源),种子固定 ⇒ 每次运行哈希一致,
 * 置换表在测试里可复现。 */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}
const Z_LEN = 1049;
const ZA = new Int32Array(Z_LEN), ZB = new Int32Array(Z_LEN);
{
  const r1 = mulberry32(0x1a2b3c4d), r2 = mulberry32(0x7f4a8c19);
  for (let i = 0; i < Z_LEN; i++) { ZA[i] = r1() | 0; ZB[i] = r2() | 0; }
}

/* ============================================================
 * 局面对象
 *  b       Int8Array(64) 棋盘
 *  stm     走子方
 *  castle  易位权掩码
 *  ep      吃过路兵目标格(-1 表示无)
 *  half    半步计数器(50 步和棋用)
 *  keyA/B  Zobrist 增量哈希
 *  ks      王的位置缓存 ks[色],省掉每次找王扫盘
 *  hist    历史 keyA 栈(重复局面判定用,存的是"走这步之前"的哈希)
 *  ply/undo  make/unmake 的 undo 栈(每条 6 个字)
 * ============================================================ */
export function newPos() {
  const pos = {
    b: new Int8Array(64),
    stm: WHITE, castle: 15, ep: -1, half: 0,
    keyA: 0, keyB: 0,
    ks: new Int8Array(2),
    hist: [],
    ply: 0,
    undo: new Int32Array(6 * 256),
  };
  const back = [ROOK, KNIGHT, BISHOP, QUEEN, KING, BISHOP, KNIGHT, ROOK];
  for (let c = 0; c < 8; c++) {
    pos.b[c] = piece(BLACK, back[c]);
    pos.b[8 + c] = piece(BLACK, PAWN);
    pos.b[48 + c] = piece(WHITE, PAWN);
    pos.b[56 + c] = piece(WHITE, back[c]);
  }
  pos.ks[WHITE] = SQ_E1; pos.ks[BLACK] = SQ_E8;
  recomputeKeys(pos);
  return pos;
}

/** 全量重算哈希(初始化与测试用;搜索路径上只用增量) */
export function recomputeKeys(pos) {
  let a = 0, b = 0;
  const bd = pos.b;
  for (let s = 0; s < 64; s++) {
    const p = bd[s];
    if (p) { const i = (p << 6) | s; a ^= ZA[i]; b ^= ZB[i]; }
  }
  if (pos.stm) { a ^= ZA[1024]; b ^= ZB[1024]; }
  a ^= ZA[1025 + pos.castle]; b ^= ZB[1025 + pos.castle];
  if (pos.ep >= 0) { const f = pos.ep & 7; a ^= ZA[1041 + f]; b ^= ZB[1041 + f]; }
  pos.keyA = a; pos.keyB = b;
  return a;
}

/** 按 64 格数组(0 或棋子编码)+ 状态装载局面(测试/工具用) */
export function loadPosition(pos, cells, stm, castle, ep) {
  pos.b.fill(0);
  for (let s = 0; s < 64; s++) pos.b[s] = cells[s] | 0;
  pos.stm = stm; pos.castle = castle; pos.ep = ep; pos.half = 0;
  pos.ply = 0; pos.hist.length = 0;
  for (let s = 0; s < 64; s++) {
    const p = pos.b[s];
    if (p && (p & 7) === KING) pos.ks[p >> 3] = s;
  }
  recomputeKeys(pos);
  return pos;
}

/* ============================================================
 * 攻击判定
 * ============================================================ */
export function attacked(b, sq, by) {
  const r = sq >> 3, c = sq & 7;
  const pawn = piece(by, PAWN);
  // 兵:白兵在白方视角"上一行",即 r+1
  const pr = r + (by === WHITE ? 1 : -1);
  if (pr >= 0 && pr < 8) {
    const base = pr * 8;
    if (c > 0 && b[base + c - 1] === pawn) return true;
    if (c < 7 && b[base + c + 1] === pawn) return true;
  }
  const kn = piece(by, KNIGHT);
  for (let i = 0; i < 16; i += 2) {
    const rr = r + ND[i], cc = c + ND[i + 1];
    if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === kn) return true;
  }
  const kg = piece(by, KING);
  for (let i = 0; i < 16; i += 2) {
    const rr = r + KD[i], cc = c + KD[i + 1];
    if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === kg) return true;
  }
  const bi = piece(by, BISHOP), qu = piece(by, QUEEN), ro = piece(by, ROOK);
  for (let i = 0; i < 8; i += 2) {
    const dr = DD[i], dc = DD[i + 1];
    let rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
      const v = b[rr * 8 + cc];
      if (v) { if (v === bi || v === qu) return true; break; }
      rr += dr; cc += dc;
    }
  }
  for (let i = 0; i < 8; i += 2) {
    const dr = OD[i], dc = OD[i + 1];
    let rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
      const v = b[rr * 8 + cc];
      if (v) { if (v === ro || v === qu) return true; break; }
      rr += dr; cc += dc;
    }
  }
  return false;
}

/** 走子方是否被将军 */
export function inCheck(pos, color = pos.stm) {
  return attacked(pos.b, pos.ks[color], color ^ 1);
}

/* ============================================================
 * 走法生成(伪合法;合法性由 isLegal / genLegal 过滤)
 * ============================================================ */
export function genMoves(pos, out) {
  const b = pos.b, stm = pos.stm;
  let n = 0;
  for (let sq = 0; sq < 64; sq++) {
    const pc = b[sq];
    if (!pc || (pc >> 3) !== stm) continue;
    const ty = pc & 7;
    const r = sq >> 3, c = sq & 7;

    if (ty === PAWN) {
      const up = stm === WHITE ? -8 : 8;
      const startR = stm === WHITE ? 6 : 1;
      const lastR = stm === WHITE ? 0 : 7;
      const t = sq + up;
      if (t >= 0 && t < 64 && !b[t]) {
        if ((t >> 3) === lastR) {
          for (let q = 0; q < 4; q++) out[n++] = mkMove(sq, t, 6 + q);
        } else {
          out[n++] = mkMove(sq, t, F_QUIET);
          if (r === startR && !b[t + up]) out[n++] = mkMove(sq, t + up, F_DOUBLE);
        }
      }
      for (let dc = -1; dc <= 1; dc += 2) {
        const cc = c + dc;
        if (cc < 0 || cc > 7) continue;            // 列越界检查同时也是"不绕行"的保证
        const t2 = t + dc;
        if (t2 < 0 || t2 > 63) continue;
        const tp = b[t2];
        if (tp) {
          if ((tp >> 3) === stm) continue;
          if ((t2 >> 3) === lastR) { for (let q = 0; q < 4; q++) out[n++] = mkMove(sq, t2, 10 + q, tp); }
          else out[n++] = mkMove(sq, t2, F_CAP, tp);
        } else if (t2 === pos.ep) {
          out[n++] = mkMove(sq, t2, F_EP, piece(stm ^ 1, PAWN));
        }
      }
    } else if (ty === KNIGHT || ty === KING) {
      const dirs = ty === KNIGHT ? ND : KD;
      for (let i = 0; i < 16; i += 2) {
        const rr = r + dirs[i], cc = c + dirs[i + 1];
        if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
        const t = rr * 8 + cc, tp = b[t];
        if (tp && (tp >> 3) === stm) continue;
        out[n++] = tp ? mkMove(sq, t, F_CAP, tp) : mkMove(sq, t, F_QUIET);
      }
      if (ty === KING) {
        const hb = stm === WHITE ? 56 : 0;
        if (sq === hb + 4) {
          const kR = stm === WHITE ? C_WK : C_BK, qR = stm === WHITE ? C_WQ : C_BQ;
          if ((pos.castle & kR) && b[hb + 7] === piece(stm, ROOK) && !b[hb + 5] && !b[hb + 6]) {
            out[n++] = mkMove(sq, hb + 6, F_OO);
          }
          if ((pos.castle & qR) && b[hb] === piece(stm, ROOK) && !b[hb + 1] && !b[hb + 2] && !b[hb + 3]) {
            out[n++] = mkMove(sq, hb + 2, F_OOO);
          }
        }
      }
    } else {
      // 象 / 车 / 后:按方向射线
      if (ty === BISHOP || ty === QUEEN) for (let i = 0; i < 8; i += 2) n = rayWalk(b, sq, DD[i], DD[i + 1], stm, out, n);
      if (ty === ROOK || ty === QUEEN) for (let i = 0; i < 8; i += 2) n = rayWalk(b, sq, OD[i], OD[i + 1], stm, out, n);
    }
  }
  return n;
}

/** 单方向射线:把沿途空格写成静着,遇到子则(敌子)吃子后停 */
function rayWalk(b, sq, dr, dc, stm, out, n) {
  let rr = (sq >> 3) + dr, cc = (sq & 7) + dc;
  while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
    const t = rr * 8 + cc, tp = b[t];
    if (!tp) out[n++] = mkMove(sq, t, F_QUIET);
    else { if ((tp >> 3) !== stm) out[n++] = mkMove(sq, t, F_CAP, tp); break; }
    rr += dr; cc += dc;
  }
  return n;
}

/* ============================================================
 * make / unmake
 * ============================================================ */
export function make(pos, m) {
  const b = pos.b;
  const from = m & 63, to = (m >> 6) & 63, f = (m >> 12) & 15, cap = (m >> 16) & 15;
  const u = pos.undo, k = pos.ply * 6;
  u[k] = cap; u[k + 1] = pos.castle; u[k + 2] = pos.ep; u[k + 3] = pos.half;
  u[k + 4] = pos.keyA; u[k + 5] = pos.keyB;
  pos.ply++;
  pos.hist.push(pos.keyA);

  const pc = b[from], col = pc >> 3, ty = pc & 7;
  let a = pos.keyA, bb = pos.keyB;

  if (f === F_EP) {
    // 被吃的兵不在落点上,而在落点"后面一格"
    const cs = to + (col === WHITE ? 8 : -8);
    const cp = b[cs];
    b[cs] = 0;
    const i = (cp << 6) | cs; a ^= ZA[i]; bb ^= ZB[i];
  } else if (cap) {
    const i = (cap << 6) | to; a ^= ZA[i]; bb ^= ZB[i];
  }
  // 移走源子。升变时源子是兵,落子换成升变子,所以 from 上 XOR 的始终是原兵
  let i = (pc << 6) | from; a ^= ZA[i]; bb ^= ZB[i];
  b[from] = 0;

  // 升变的落子型号 = ((标志-6)&3)+2:6..9 与 10..13 两段都映射到 N/B/R/Q
  const np = f >= 6 ? piece(col, ((f - 6) & 3) + 2) : pc;
  b[to] = np;
  i = (np << 6) | to; a ^= ZA[i]; bb ^= ZB[i];

  if (f === F_OO || f === F_OOO) {
    const rf = f === F_OO ? to + 1 : to - 2;
    const rt = f === F_OO ? to - 1 : to + 1;
    const rk = b[rf];
    b[rf] = 0; b[rt] = rk;
    i = (rk << 6) | rf; a ^= ZA[i]; bb ^= ZB[i];
    i = (rk << 6) | rt; a ^= ZA[i]; bb ^= ZB[i];
  }

  // 易位权:王动了清两侧;车离开了原位或车被吃也清
  const oldC = pos.castle;
  if (ty === KING) pos.castle &= col === WHITE ? ~(C_WK | C_WQ) : ~(C_BK | C_BQ);
  else if (ty === ROOK) {
    if (from === SQ_A1) pos.castle &= ~C_WQ;
    else if (from === SQ_H1) pos.castle &= ~C_WK;
    else if (from === SQ_A8) pos.castle &= ~C_BQ;
    else if (from === SQ_H8) pos.castle &= ~C_BK;
  }
  if (to === SQ_A1) pos.castle &= ~C_WQ;
  else if (to === SQ_H1) pos.castle &= ~C_WK;
  else if (to === SQ_A8) pos.castle &= ~C_BQ;
  else if (to === SQ_H8) pos.castle &= ~C_BK;
  if (oldC !== pos.castle) {
    a ^= ZA[1025 + oldC] ^ ZA[1025 + pos.castle];
    bb ^= ZB[1025 + oldC] ^ ZB[1025 + pos.castle];
  }

  const oldEp = pos.ep;
  pos.ep = f === F_DOUBLE ? (from + to) >> 1 : -1;
  if (oldEp >= 0) { const j = 1041 + (oldEp & 7); a ^= ZA[j]; bb ^= ZB[j]; }
  if (pos.ep >= 0) { const j = 1041 + (pos.ep & 7); a ^= ZA[j]; bb ^= ZB[j]; }

  if (ty === KING) pos.ks[col] = to;
  if (ty === PAWN || cap) pos.half = 0; else pos.half++;

  pos.stm ^= 1;
  a ^= ZA[1024]; bb ^= ZB[1024];
  pos.keyA = a; pos.keyB = bb;
}

export function unmake(pos, m) {
  pos.ply--;
  const u = pos.undo, k = pos.ply * 6;
  const cap = u[k], castle = u[k + 1], ep = u[k + 2], half = u[k + 3];
  const from = m & 63, to = (m >> 6) & 63, f = (m >> 12) & 15;
  const b = pos.b;

  const np = b[to], col = np >> 3, ty = np & 7;
  b[to] = 0;
  b[from] = f >= 6 ? piece(col, PAWN) : np;
  if (f === F_EP) b[to + (col === WHITE ? 8 : -8)] = piece(col ^ 1, PAWN);
  else if (cap) b[to] = cap;

  if (f === F_OO) { b[to + 1] = b[to - 1]; b[to - 1] = 0; }
  else if (f === F_OOO) { b[to - 2] = b[to + 1]; b[to + 1] = 0; }

  if (ty === KING) pos.ks[col] = from;

  pos.castle = castle; pos.ep = ep; pos.half = half;
  pos.keyA = u[k + 4]; pos.keyB = u[k + 5];
  pos.stm ^= 1;
  pos.hist.pop();
}

/** 空着(不走子,只把走子权交出去)。仅空着剪枝用,外面不要调用。 */
export function makeNull(pos) {
  const u = pos.undo, k = pos.ply * 6;
  u[k] = 0; u[k + 1] = pos.castle; u[k + 2] = pos.ep; u[k + 3] = pos.half;
  u[k + 4] = pos.keyA; u[k + 5] = pos.keyB;
  pos.ply++;
  pos.hist.push(pos.keyA);
  let a = pos.keyA ^ ZA[1024], bb = pos.keyB ^ ZB[1024];
  if (pos.ep >= 0) { const j = 1041 + (pos.ep & 7); a ^= ZA[j]; bb ^= ZB[j]; pos.ep = -1; }
  pos.keyA = a; pos.keyB = bb;
  pos.stm ^= 1;
  pos.half++;
}
export function unmakeNull(pos) {
  pos.ply--;
  const u = pos.undo, k = pos.ply * 6;
  pos.ep = u[k + 2]; pos.half = u[k + 3];
  pos.keyA = u[k + 4]; pos.keyB = u[k + 5];
  pos.stm ^= 1;
  pos.hist.pop();
}

/* ============================================================
 * 合法性
 * ============================================================ */
export function isLegal(pos, m) {
  const f = mFlag(m);
  if (f === F_OO || f === F_OOO) {
    // 易位要额外检查:起点、经过格、落点都不能被攻击(光查落点会漏掉"穿过去被将")
    const col = pos.stm, k = pos.ks[col], dir = f === F_OO ? 1 : -1;
    return !attacked(pos.b, k, col ^ 1)
      && !attacked(pos.b, k + dir, col ^ 1)
      && !attacked(pos.b, k + 2 * dir, col ^ 1);
  }
  make(pos, m);
  const ok = !attacked(pos.b, pos.ks[pos.stm ^ 1], pos.stm);
  unmake(pos, m);
  return ok;
}

/** 生成全部合法走法,压紧写回 out,返回个数 */
export function genLegal(pos, out) {
  const n = genMoves(pos, out);
  let w = 0;
  for (let i = 0; i < n; i++) { const m = out[i]; if (isLegal(pos, m)) out[w++] = m; }
  return w;
}

/** 是否还有合法走法(终局判定;找到第一个就返回,不生成全部) */
export function hasLegalMove(pos, out) {
  const n = genMoves(pos, out);
  for (let i = 0; i < n; i++) if (isLegal(pos, out[i])) return true;
  return false;
}

/* ---------- 和棋判定 ---------- */

/** 搜索路径/对局历史里出现过同局面(以半步计数器为上限往回找,隔一步一比对) */
export function isRepetition(pos) {
  const h = pos.hist, n = h.length, ka = pos.keyA;
  const stop = n - pos.half;
  for (let i = n - 2; i >= 0 && i >= stop; i -= 2) if (h[i] === ka) return true;
  return false;
}
/** 对局历史里第三次出现(真·三次重复) */
export function isThreefold(pos) {
  const h = pos.hist, n = h.length, ka = pos.keyA;
  let cnt = 0;
  const stop = n - pos.half;
  for (let i = n - 2; i >= 0 && i >= stop; i -= 2) if (h[i] === ka && ++cnt >= 2) return true;
  return false;
}
/** 子力不足和棋:无兵无重子,且双方都只有至多一个轻子 */
export function insufficientMaterial(pos) {
  const b = pos.b;
  let minor = [0, 0];
  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (!p) continue;
    const ty = p & 7;
    if (ty === KING) continue;
    if (ty === PAWN || ty === ROOK || ty === QUEEN) return false;
    minor[p >> 3]++;
  }
  return minor[WHITE] <= 1 && minor[BLACK] <= 1;
}

/* ---------- 走法序列重演 ---------- */

/** 按 (from<<6|to) 序列在局面上重演走法,把局面推到序列末尾。
 *  给 Worker 用:UI 只传真走法序列,不传棋盘对象(结构化克隆代价最小)。
 *  升变一律升后,与 UI 的"自动升后"一致。
 *  返回 false 表示序列里有走不出来的着法,此时局面状态不可信。 */
export function replayMoves(pos, seq, buf) {
  for (let i = 0; i < seq.length; i++) {
    const from = seq[i] >> 6, to = seq[i] & 63;
    const n = genMoves(pos, buf);
    let mv = 0;
    for (let j = 0; j < n; j++) {
      const c = buf[j];
      if (mFrom(c) !== from || mTo(c) !== to) continue;
      const pr = mPromo(c);
      if (pr && pr !== QUEEN) continue;      // 多个升变着法时取升后那个
      mv = c; break;
    }
    if (!mv || !isLegal(pos, mv)) return false;
    make(pos, mv);
  }
  return true;
}
