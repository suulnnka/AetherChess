/* ============================================================
 * 3D 国际象棋引擎测试
 *   运行:node test/engine-test.mjs
 *
 * 四道关:
 *   1. perft:6 个标准局面(含 4 个经典题)逐层节点数精确匹配 —— 这是
 *      "换了引擎内部但棋规一字未动"的唯一证据来源。
 *   2. 旧实现对拍:把改造前 index.js 里的走法生成逐字搬进来当 oracle,
 *      随机对局逐步比对"能走的格子集合"。逐层计数相同也可能是两个
 *      对称的 bug 互相抵消,对拍才能堵住。
 *   3. make/unmake 还原性:走/撤销后棋盘、哈希、易位权、ep、半步、走子权
 *      必须逐位回到原值;Zobrist 增量值必须等于全量重算值。
 *   4. 和棋规则:重复局面、50 步、子力不足。
 *
 * oracle 有两处刻意偏离(都是旧实现的缺陷,见下方注释),除此之外必须逐位一致。
 * ============================================================ */
import {
  WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  piece, colorOf, typeOf, CHARS, TYPES, NAME,
  mFrom, mTo, mFlag, mCap, mkMove,
  F_QUIET, F_DOUBLE, F_OO, F_OOO, F_CAP, F_EP,
  C_WK, C_WQ, C_BK, C_BQ,
  newPos, genMoves, genLegal, hasLegalMove, isLegal, make, unmake,
  inCheck, attacked, loadPosition, recomputeKeys,
  isRepetition, isThreefold, insufficientMaterial,
} from '../src/rules.js';
import { searchBest, evaluate } from '../src/ai.js';
const QUICK = process.argv.includes('--quick');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} 期望 ${b} 实得 ${a}`);
const section = (s) => console.log('\n== ' + s);

/* ============================================================
 * FEN → 64 格数组(sq = r*8+c,r=0 是 8 线)
 * ============================================================ */
export function fenCells(fen) {
  const cells = new Int8Array(64);
  const rank = fen.split(' ')[0].split('/');
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rank[r]) {
      if (ch >= '1' && ch <= '8') { c += +ch; continue; }
      const t = TYPES[ch.toLowerCase()];
      cells[r * 8 + c] = piece(ch === ch.toUpperCase() ? WHITE : BLACK, t);
      c++;
    }
  }
  return cells;
}
export function fenState(fen) {
  const p = fen.split(' ');
  const stm = p[1] === 'b' ? BLACK : WHITE;
  let castle = 0;
  if (p[2].includes('K')) castle |= C_WK;
  if (p[2].includes('Q')) castle |= C_WQ;
  if (p[2].includes('k')) castle |= C_BK;
  if (p[2].includes('q')) castle |= C_BQ;
  let ep = -1;
  if (p[3] && p[3] !== '-') ep = (8 - +p[3][1]) * 8 + ('abcdefgh'.indexOf(p[3][0]));
  return { stm, castle, ep };
}
function posFromFen(fen) {
  const s = fenState(fen);
  return loadPosition(newPos(), fenCells(fen), s.stm, s.castle, s.ep);
}

/* ============================================================
 * perft
 * ============================================================ */
/* 每层一个走法缓冲区:共用单个缓冲区会被递归里的下一层覆写,
 * 外层循环读到的是被改过的走法 —— perft 计数会离奇偏小。 */
const PBUF = [];
for (let i = 0; i < 12; i++) PBUF.push(new Int32Array(256));
function perft(pos, depth) {
  if (depth === 0) return 1;
  const buf = PBUF[depth];
  const n = genMoves(pos, buf);
  let c = 0;
  for (let i = 0; i < n; i++) {
    const m = buf[i];
    if (!isLegal(pos, m)) continue;
    if (depth === 1) { c++; continue; }
    make(pos, m);
    c += perft(pos, depth - 1);
    unmake(pos, m);
  }
  return c;
}

const PERFT = [
  ['初始局面', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    [20, 400, 8902, 197281, 4865609]],
  ['Kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    [48, 2039, 97862, 4085603]],
  ['局面3(兵残局)', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    [14, 191, 2812, 43238, 674624]],
  ['局面4(升变/易位)', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    [6, 264, 9467, 422333]],
  ['局面5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    [44, 1486, 62379, 2103487]],
  ['局面6', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
    [46, 2079, 89890]],
];

function runPerft() {
  section('perft(节点数必须逐层精确匹配标准值)');
  for (const [name, fen, expect] of PERFT) {
    const pos = posFromFen(fen);
    for (let d = 1; d <= expect.length; d++) {
      const t0 = Date.now();
      const got = perft(pos, d);
      eq(got, expect[d - 1], `${name} perft(${d})`);
      if (d === expect.length) console.log(`  ${name} 深度 1..${d} 全对(末层 ${Date.now() - t0}ms)`);
    }
  }
}

/* ============================================================
 * 旧实现对拍(oracle)
 * 代码搬自改造前的 js/apps/chess3d/index.js 的走法段。两处刻意偏离:
 *  ① 旧 attacked() 通过 pseudoMoves 判攻击,而 pseudoMoves 里含"王车易位",
 *     于是敌王在底线上时 g1/c1 之类格子会被假报为"被攻击"。这显然是缺陷,
 *     不复制 —— 判攻击时不给王生成易位着法。
 *  ② 旧 legalMoves() 只查易位后的王位,不查"被将中易位 / 穿过被攻击格"。
 *     新引擎按规则拒绝这两种易位,故 oracle 也补上检查,否则对拍必然假红。
 * 除这两处外,任何一步差异都视为真回归。
 * ============================================================ */
function orInit(fen) {
  const cells = fenCells(fen);
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = cells[r * 8 + c];
    if (p) b[r][c] = { t: CHARS[p & 7], c: (p >> 3) === WHITE ? 'w' : 'b' };
  }
  const s = fenState(fen);
  const moved = {};
  // 从棋盘反推"王/车是否已动":不在原位就算动过(FEN 无法区分"动过又回来",
  // 但 oracle 只用于从 FEN 起步的对拍,起步时刻这个反推是准确的)。
  for (const [key, r, c, t, col] of [['kw', 7, 4, 'k', 'w'], ['kb', 0, 4, 'k', 'b'],
    ['rwa', 7, 0, 'r', 'w'], ['rwh', 7, 7, 'r', 'w'], ['rba', 0, 0, 'r', 'b'], ['rbh', 0, 7, 'r', 'b']]) {
    const p = b[r][c];
    if (!p || p.t !== t || p.c !== col) moved[key] = true;
  }
  return { b, state: { moved, ep: s.ep >= 0 ? [(s.ep >> 3), s.ep & 7] : null }, stm: s.stm };
}
const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const other = (c) => (c === 'w' ? 'b' : 'w');
function orPseudo(b, r, c, state, allowCastle = true) {
  const p = b[r][c];
  if (!p) return [];
  const out = [];
  const push = (rr, cc) => { if (inB(rr, cc) && (!b[rr][cc] || b[rr][cc].c !== p.c)) out.push([rr, cc]); };
  const ray = (dr, dc) => {
    let rr = r + dr, cc = c + dc;
    while (inB(rr, cc)) {
      if (!b[rr][cc]) out.push([rr, cc]);
      else { if (b[rr][cc].c !== p.c) out.push([rr, cc]); break; }
      rr += dr; cc += dc;
    }
  };
  if (p.t === 'p') {
    const dir = p.c === 'w' ? -1 : 1;
    const start = p.c === 'w' ? 6 : 1;
    if (inB(r + dir, c) && !b[r + dir][c]) {
      out.push([r + dir, c]);
      if (r === start && !b[r + 2 * dir][c]) out.push([r + 2 * dir, c]);
    }
    for (const dc of [-1, 1]) {
      const rr = r + dir, cc = c + dc;
      if (inB(rr, cc) && b[rr][cc] && b[rr][cc].c !== p.c) out.push([rr, cc]);
      if (state.ep && state.ep[0] === rr && state.ep[1] === cc && !b[rr][cc]) out.push([rr, cc]);
    }
  } else if (p.t === 'n') {
    for (const [dr, dc] of [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]) push(r + dr, c + dc);
  } else if (p.t === 'b') { for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) ray(dr, dc); }
  else if (p.t === 'r') { for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) ray(dr, dc); }
  else if (p.t === 'q') { for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]]) ray(dr, dc); }
  else if (p.t === 'k') {
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) push(r + dr, c + dc);
    if (allowCastle) {
      const home = p.c === 'w' ? 7 : 0;
      if (r === home && c === 4 && !state.moved[`k${p.c}`]) {
        if (b[home][0]?.t === 'r' && b[home][0].c === p.c && !state.moved[`r${p.c}a`] && !b[home][1] && !b[home][2] && !b[home][3]) out.push([home, 2]);
        if (b[home][7]?.t === 'r' && b[home][7].c === p.c && !state.moved[`r${p.c}h`] && !b[home][5] && !b[home][6]) out.push([home, 6]);
      }
    }
  }
  return out;
}
const cloneB = (b) => b.map((row) => row.map((p) => (p ? { ...p } : null)));
function orApply(b, fr, fc, tr, tc, state) {
  const nb = cloneB(b);
  const p = nb[fr][fc];
  // 偏离③:旧版 applyMove 不模拟"吃过路兵时被吃的那只兵消失"。
  // 这只兵恰好挡在长距离射线上,旧版于是把某些"吃过路兵后自曝王"的着法误判为合法。
  // 真对局里旧版是在 doMove 里另做移除的,所以这是漏在合法性过滤器里的缺陷。
  if (p.t === 'p' && state && state.ep && state.ep[0] === tr && state.ep[1] === tc && !nb[tr][tc]) {
    nb[fr][tc] = null;
  }
  nb[fr][fc] = null;
  if (p.t === 'p' && (tr === 0 || tr === 7)) p.t = 'q';
  nb[tr][tc] = p;
  if (p.t === 'k' && Math.abs(tc - fc) === 2) {
    if (tc === 6) { nb[tr][5] = nb[tr][7]; nb[tr][7] = null; }
    else { nb[tr][3] = nb[tr][0]; nb[tr][0] = null; }
  }
  return nb;
}
function orAttacked(b, r, c, byColor) {
  for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
    const p = b[rr][cc];
    if (p && p.c === byColor) {
      const ms = orPseudo(b, rr, cc, { moved: {}, ep: null }, false);   // 偏离①:判攻击时不算王的易位
      if (ms.some(([mr, mc]) => mr === r && mc === c)) return true;
    }
  }
  return false;
}
function orKing(b, color) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = b[r][c];
    if (p && p.t === 'k' && p.c === color) return [r, c];
  }
  return null;
}
function orInCheck(b, color) {
  const k = orKing(b, color);
  return k ? orAttacked(b, k[0], k[1], other(color)) : false;
}
function orLegal(b, r, c, state) {
  const p = b[r][c];
  return orPseudo(b, r, c, state).filter(([tr, tc]) => {
    if (p.t === 'k' && Math.abs(tc - c) === 2 && r === (p.c === 'w' ? 7 : 0)) {
      // 偏离②:易位要额外保证起点/经过格/落点都没被攻击
      const dir = tc > c ? 1 : -1;
      const by = other(p.c);
      if (orAttacked(b, r, c, by) || orAttacked(b, r, c + dir, by) || orAttacked(b, r, c + 2 * dir, by)) return false;
    }
    return !orInCheck(orApply(b, r, c, tr, tc, state), p.c);
  });
}
/** 该局面"能走的格子集合"(from*64+to)。升变按一个终点算,因为旧实现只会升后。 */
function orMoveSet(o) {
  const set = new Set();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = o.b[r][c];
    if (!p || p.c !== (o.stm === WHITE ? 'w' : 'b')) continue;
    for (const [tr, tc] of orLegal(o.b, r, c, o.state)) set.add((r * 8 + c) * 64 + (tr * 8 + tc));
  }
  return set;
}
function newMoveSet(pos) {
  const out = new Int32Array(256);
  const n = genLegal(pos, out);
  const set = new Set();
  for (let i = 0; i < n; i++) set.add((mFrom(out[i]) * 64) + mTo(out[i]));
  return set;
}
function orApplyMove(o, from, to) {
  const fr = from >> 3, fc = from & 7, tr = to >> 3, tc = to & 7;
  const p = o.b[fr][fc];
  const isCastle = p.t === 'k' && Math.abs(tc - fc) === 2 && fr === (p.c === 'w' ? 7 : 0);
  const isEp = p.t === 'p' && o.state.ep && o.state.ep[0] === tr && o.state.ep[1] === tc && !o.b[tr][tc];
  const isDouble = p.t === 'p' && Math.abs(tr - fr) === 2;
  if (p.t === 'k') o.state.moved[`k${p.c}`] = true;
  if (p.t === 'r') { if (fc === 0) o.state.moved[`r${p.c}a`] = true; if (fc === 7) o.state.moved[`r${p.c}h`] = true; }
  // 车被吃也要清权(旧 UI 没做,但这里是 oracle 自身的状态推进,必须做对否则对拍会在后续局面假红)
  const cap0 = o.b[tr][tc];
  if (cap0 && cap0.t === 'r') {
    if (tr === 7 && tc === 0) o.state.moved.rwa = true;
    if (tr === 7 && tc === 7) o.state.moved.rwh = true;
    if (tr === 0 && tc === 0) o.state.moved.rba = true;
    if (tr === 0 && tc === 7) o.state.moved.rbh = true;
  }
  o.state.ep = isDouble ? [(fr + tr) / 2, fc] : null;
  o.b = orApply(o.b, fr, fc, tr, tc, o.state);
  o.stm ^= 1;
}

function runOracle() {
  section('旧实现对拍(随机对局里逐步比对合法着法集合)');
  // 确定性 PRNG,失败可复现
  let seed = 0x12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const fens = PERFT.map((x) => x[1]);
  let plies = 0, games = 0, bad = 0;
  for (let g = 0; g < 24; g++) {
    const fen = fens[g % fens.length];
    const pos = posFromFen(fen);
    const o = orInit(fen);
    games++;
    for (let ply = 0; ply < 40; ply++) {
      const ns = newMoveSet(pos);
      const os = orMoveSet(o);
      let diff = 0;
      for (const k of ns) if (!os.has(k)) diff++;
      for (const k of os) if (!ns.has(k)) diff++;
      if (diff) {
        bad++;
        if (bad <= 3) console.log(`  ✗ 局面 ${fen} 第 ${ply} 手:着法集合差 ${diff} 个`
          + ` 新-旧=${[...ns].filter((k) => !os.has(k)).slice(0, 4).map((k) => NAME(k >> 6) + NAME(k & 63))}`
          + ` 旧-新=${[...os].filter((k) => !ns.has(k)).slice(0, 4).map((k) => NAME(k >> 6) + NAME(k & 63))}`);
        break;
      }
      if (!ns.size) break;
      const pick = [...ns][Math.floor(rnd() * ns.size)];
      // 新引擎走一步(升变一律升后,与旧实现一致)
      const out = new Int32Array(256);
      const n = genLegal(pos, out);
      let chosen = -1;
      for (let i = 0; i < n; i++) {
        if ((mFrom(out[i]) * 64 + mTo(out[i])) === pick) {
          const pf = mFlag(out[i]);
          // 升变有 4 个着法,旧实现只会升后 ⇒ 只取升后的那个
          if (pf >= 6 && ((pf - 6) & 3) !== 3) continue;
          chosen = out[i]; break;
        }
      }
      if (chosen < 0) { bad++; console.log('  ✗ 找不到对应走法', pick); break; }
      orApplyMove(o, mFrom(chosen), mTo(chosen));
      make(pos, chosen);
      plies++;
    }
  }
  ok(bad === 0, `随机对拍有 ${bad} 处不一致`);
  console.log(`  对拍 ${games} 局 / ${plies} 手,着法集合逐手一致`);
}

/* ============================================================
 * make/unmake 还原性 + Zobrist 增量一致性
 * ============================================================ */
function snapshot(pos) {
  return [pos.b.join(','), pos.stm, pos.castle, pos.ep, pos.half, pos.keyA, pos.keyB, pos.ks[0], pos.ks[1]].join('|');
}
function runInvariants() {
  section('make/unmake 还原性 + Zobrist 增量一致性');
  let seed = 0xabcdef;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let checks = 0, restored = 0, hashOk = 0, attempted = 0;
  const buf = new Int32Array(256);
  for (const [, fen] of PERFT) {
    const pos = posFromFen(fen);
    const stack = [];
    const snaps = [snapshot(pos)];
    for (let i = 0; i < 120; i++) {
      const n = genLegal(pos, buf);
      if (!n) break;                       // 将死/逼和,这一局自然结束
      const m = buf[Math.floor(rnd() * n)];
      make(pos, m);
      attempted++;
      // 增量哈希 == 全量重算?
      const a = pos.keyA, b = pos.keyB;
      recomputeKeys(pos);
      checks++;
      if (a === pos.keyA && b === pos.keyB) hashOk++;
      else if (hashOk + 3 > checks) console.log(`  ✗ 哈希不一致 @${fen} 第${i}手`);
      stack.push(m);
      snaps.push(snapshot(pos));
    }
    // 逐层撤销,每撤一层都必须与进入该层前的快照完全一致
    for (let i = stack.length - 1; i >= 0; i--) {
      unmake(pos, stack[i]);
      restored++;
      if (snapshot(pos) !== snaps[i]) { console.log(`  ✗ 撤销后局面未还原 @${fen} 第${i}手`); break; }
    }
  }
  eq(hashOk, checks, `Zobrist 增量与全量重算一致(${checks} 次)`);
  eq(restored, attempted, `撤销层数 = 走的层数(${attempted})`);
  ok(attempted > 400, `走/撤层数 ${attempted} > 400`);
  console.log(`  走/撤 ${restored} 层全部逐位还原,哈希 ${checks} 次全部一致`);
}

/* ============================================================
 * 规则边角
 * ============================================================ */
function runEdges() {
  section('规则边角');
  const buf = new Int32Array(256);

  // 被将中不能易位(旧实现允许,新引擎拒绝)
  {
    const fen = 'r3k2r/8/8/8/8/8/4r3/R3K2R w KQkq - 0 1';
    const pos = posFromFen(fen);
    const n = genLegal(pos, buf);
    let castles = 0;
    for (let i = 0; i < n; i++) if (mFlag(buf[i]) === F_OO || mFlag(buf[i]) === F_OOO) castles++;
    eq(castles, 0, '被将被车将军时不能易位');
  }
  // 易位经过格被攻击不能长易位
  {
    const fen = 'r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1';   // 黑车在 f2 → d1 不冲突但 c1/d1 是否受攻?
    const pos = posFromFen(fen);
    const n = genLegal(pos, buf);
    let q = 0;
    for (let i = 0; i < n; i++) if (mFlag(buf[i]) === F_OOO) q++;
    eq(q, 1, '长易位经过格未被攻击时可以长易位');
  }
  {
    const fen = 'r3k2r/8/8/8/8/8/3r4/R3K2R w KQkq - 0 1';  // 黑车 d2 攻 d1
    const pos = posFromFen(fen);
    const n = genLegal(pos, buf);
    let q = 0, k = 0;
    for (let i = 0; i < n; i++) { if (mFlag(buf[i]) === F_OOO) q++; if (mFlag(buf[i]) === F_OO) k++; }
    eq(q, 0, 'd1 被攻击时长易位非法');
    eq(k, 1, '短易位不受影响');
  }
  // 升变:四个升变子都能生成,且升后吃子有独立标志
  {
    const pos = posFromFen('8/P6k/8/8/8/8/8/7K w - - 0 1');
    const n = genLegal(pos, buf);
    let promo = 0;
    for (let i = 0; i < n; i++) if (mFlag(buf[i]) === 6 || mFlag(buf[i]) === 7 || mFlag(buf[i]) === 8 || mFlag(buf[i]) === 9) promo++;
    eq(promo, 4, 'a7 兵有 4 个升变着法');
  }
  {
    const pos = posFromFen('1n6/P6k/8/8/8/8/8/7K w - - 0 1');
    const n = genLegal(pos, buf);
    let pc = 0;
    for (let i = 0; i < n; i++) if (mFlag(buf[i]) >= 10) pc++;
    eq(pc, 4, '升变且吃子有 4 个着法');
  }
  // 吃过路兵后哈希/局面还原
  {
    const pos = posFromFen('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
    const n = genLegal(pos, buf);
    let ep = 0, epm = -1;
    for (let i = 0; i < n; i++) if (mFlag(buf[i]) === F_EP) { ep++; epm = buf[i]; }
    eq(ep, 1, 'e5 兵可以吃过路兵 f6');
    if (epm >= 0) {
      const before = snapshot(pos);
      make(pos, epm);
      eq(pos.b[mTo(epm) + 8], 0, '吃过路兵后被吃黑兵从 f5 消失');
      unmake(pos, epm);
      eq(snapshot(pos), before, '吃过路兵撤销后完全还原');
    }
  }
  // 将死 / 逼和
  {
    const mate = posFromFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
    eq(hasLegalMove(mate, buf), false, '后 h4 杀:白方无合法着法');
    eq(inCheck(mate), true, '该局面白方被将军');
    const stale = posFromFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    eq(hasLegalMove(stale, buf), false, '逼和:黑方无着法但未被将军');
    eq(inCheck(stale), false, '逼和局面未被将军');
  }
  // 和棋规则
  {
    const pos = posFromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
    eq(insufficientMaterial(pos), true, '王对王 = 子力不足');
    const pos2 = posFromFen('4k3/8/8/8/8/8/8/4KB2 w - - 0 1');
    eq(insufficientMaterial(pos2), true, '王象对王 = 子力不足');
    const pos3 = posFromFen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
    eq(insufficientMaterial(pos3), false, '有兵 = 不是子力不足');
    // 重复:两步来回
    const start = posFromFen('4k3/8/8/8/8/8/8/4K2R w - - 0 1');
    const seq = ['e1e2', 'e8e7', 'e2e1', 'e7e8', 'e1e2', 'e8e7', 'e2e1', 'e7e8'];
    for (const s of seq) {
      const n = genLegal(start, buf);
      const f = ('abcdefgh'.indexOf(s[0])) + (8 - +s[1]) * 8;
      const t = ('abcdefgh'.indexOf(s[2])) + (8 - +s[3]) * 8;
      let m = -1;
      for (let i = 0; i < n; i++) if (mFrom(buf[i]) === f && mTo(buf[i]) === t) { m = buf[i]; break; }
      ok(m >= 0, `走法 ${s} 应合法`);
      if (m < 0) break;
      make(start, m);
    }
    eq(isRepetition(start), true, '来回两次后出现重复局面');
    eq(isThreefold(start), true, '第三次重复可判三次重复');
  }
}

/* ============================================================
 * 战术 / 棋力
 * ============================================================ */
const TBUF = new Int32Array(256);
const posFromFen2 = posFromFen;

/** 这步走完是不是把对手将死了 —— 自我验证,不依赖人手核对唯一解 */
function isMatingMove(pos, m) {
  make(pos, m);
  const r = inCheck(pos) && !hasLegalMove(pos, TBUF);
  unmake(pos, m);
  return r;
}
function think(fen, nodes, depth = 24) {
  const pos = posFromFen2(fen);
  const r = searchBest(pos, { nodes, ms: 30000, depth });
  return { pos, r, san: NAME(mFrom(r.move)) + NAME(mTo(r.move)) };
}

function runTactics() {
  section('战术');
  // 一步杀:走后自己验一下"对手无着法且被将",不预设唯一解
  {
    const { pos, r, san } = think('6k1/5ppp/8/8/8/8/8/R6K w - - 0 1', 20000);
    ok(r.score > 29000 && isMatingMove(pos, r.move), `底线一步杀(Ra8#),实走 ${san} 分 ${r.score}`);
  }
  {
    const { pos, r, san } = think('7k/R7/8/8/8/8/8/1R4K1 w - - 0 1', 20000);
    ok(r.score > 29000 && isMatingMove(pos, r.move), `双车梯子杀(Rb8#),实走 ${san} 分 ${r.score}`);
  }
  // 吃到白送的后。注意两边都要留够其他子力 —— 如果吃成"王对王"或"王单马对王",
  // 那是子力不足和棋,引擎正确地给 0 分,这时"白吃"反而是错的。
  {
    const { r, san } = think('4k3/8/8/3q4/4P3/8/8/R3K2R w KQ - 0 1', 20000);
    eq(san, 'e4d5', '白吃无保护的后');
    ok(r.score > 600, `该局面分应明显为正,实得 ${r.score}`);
  }
  // 被将必须解将:黑车贴脸将军但自己没保护,直接吃掉才是唯一好棋
  {
    const { pos, r, san } = think('4k3/8/8/8/8/8/4r3/4K3 w - - 0 1', 20000);
    eq(san, 'e1e2', '被将时该吃掉的无保护送子必须吃掉');
    make(pos, r.move);
    const stillCheck = inCheck(pos, WHITE);
    unmake(pos, r.move);
    ok(!stillCheck, '走完必须不再被将');
  }
  // 送后陷阱:不能贪吃被保护的 d5 兵
  {
    const fen = 'rnbqkbnr/pp2pppp/2p5/3p4/8/8/PPP1PPPP/RNBQKBNR w KQkq - 0 1';
    const { r, san } = think(fen, 40000);
    ok(san !== 'd1d5', `不能贪吃被 c6 兵保护的 d5 兵(实走 ${san})`);
    ok(r.score > -200, `局面分不应崩掉(实得 ${r.score})`);
  }
  // 被将时不能忽略将军:只有唯一解的局面必须走那一步
  {
    const { pos, r, san } = think('4k3/8/8/8/8/8/4r3/4K3 w - - 0 1', 20000);
    make(pos, r.move);
    const stillCheck = inCheck(pos);
    unmake(pos, r.move);
    ok(!stillCheck, `必须解将(实走 ${san})`);
  }
}

/* ---------- 残局必须真的能杀(不能只会走子、最后逼和) ---------- */
function playToMate(fen, maxPlies, nodes) {
  const pos = posFromFen2(fen);
  let plies = 0, mate = false, stale = false;
  while (plies < maxPlies) {
    if (!hasLegalMove(pos, TBUF)) { mate = inCheck(pos); stale = !mate; break; }
    const r = searchBest(pos, { nodes, ms: 4000, depth: 24 });
    make(pos, r.move);
    plies++;
  }
  if (!hasLegalMove(pos, TBUF)) { mate = inCheck(pos); if (!mate) stale = true; }
  return { plies, mate, stale };
}

function runEndgame() {
  section('残局将杀能力');
  {
    const g = playToMate('4k3/8/8/8/8/8/8/4K2Q w - - 0 1', 60, 6000);
    ok(g.mate && !g.stale, `后对王必须在 60 手内将杀(用了 ${g.plies} 手,逼和=${g.stale})`);
  }
  {
    const g = playToMate('4k3/8/8/8/8/8/8/4K2R w - - 0 1', 90, 8000);
    ok(g.mate && !g.stale, `车对王必须在 90 手内将杀(用了 ${g.plies} 手,逼和=${g.stale})`);
  }
}

/* ---------- 对旧 AI 的胜率(阶段三验收:"明显占优") ---------- */
const OLD_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
/** 逐字复刻改造前 index.js 里的一层贪心(含 Math.random()*3 扰动) */
function oldAi(pos) {
  const n = genLegal(pos, TBUF);
  let best = -1, bestS = -Infinity;
  for (let i = 0; i < n; i++) {
    const m = TBUF[i];
    const cap = mCap(m);
    let s = cap ? OLD_VAL[CHARS[cap & 7]] * 10 : 0;
    s += Math.random() * 3;
    if (cap && (cap & 7) === KING) s += 500;
    make(pos, m);
    if (!attacked(pos.b, mTo(m), pos.stm)) s += 2;    // 走后没被反吃 → 旧 AI 的额外奖励
    unmake(pos, m);
    if (s > bestS) { bestS = s; best = m; }
  }
  return best;
}

function runDuel() {
  section('新引擎对旧「一层贪心」的胜率');
  const games = QUICK ? 6 : 12;
  const plies = QUICK ? 70 : 90;
  const nodes = 2500;                 // 只求分出高下,不追求棋力峰值
  let newWin = 0, oldWin = 0, draw = 0;
  const buf = new Int32Array(256);
  for (let g = 0; g < games; g++) {
    const pos = posFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    const newIsWhite = g % 2 === 0;
    /* 终局判定:轮到谁走谁没着法 —— 被将则"轮到走的那一方"输。
     * 所以 res 表示的是"白方赢(+1)/黑方赢(-1)/和(0)",
     * 再拿 newIsWhite 去映射到"新引擎赢没赢",不能直接当新引擎的战果用。 */
    let res = 0;
    for (let p = 0; p < plies; p++) {
      const isWhite = pos.stm === WHITE;
      if (!hasLegalMove(pos, buf)) { res = inCheck(pos) ? (isWhite ? -1 : 1) : 0; break; }
      const m = (isWhite === newIsWhite)
        ? searchBest(pos, { nodes, ms: 2000, depth: 24 }).move
        : oldAi(pos);
      make(pos, m);
      if (pos.half >= 100) break;
    }
    if (res === 0) draw++;
    else if ((res === 1) === newIsWhite) newWin++;
    else oldWin++;
  }
  const scoreRate = (newWin + draw * 0.5) / games;
  ok(scoreRate >= 0.65, `胜率须明显高于 50%,实得 ${(scoreRate * 100).toFixed(1)}%`
    + `(${newWin} 胜 / ${draw} 和 / ${oldWin} 负)`);
  console.log(`  新引擎 ${newWin} 胜 / ${draw} 和 / ${oldWin} 负 = 得分率 ${(scoreRate * 100).toFixed(1)}%`);
}

/* ============================================================
 * 主流程
 * ============================================================ */
const t0 = Date.now();
runPerft();
runOracle();
runInvariants();
runEdges();
runTactics();
runEndgame();
runDuel();
console.log(`\n${fail === 0 ? '全部通过' : '有失败项'} — ${pass} 项通过 / ${fail} 项失败,${Date.now() - t0}ms`);
process.exit(fail === 0 ? 0 : 1);
