//  ============================================================
// 搜索(zig 通道)—— src/ai.js 的逐句移植:
//   PVS 负极大 + 迭代加深 + 置换表 + 静态搜索,叠加空着剪枝 /
//   迟着裁减(LMR)/ 逆向 futility / 将军延伸 / aspiration 窗口
//   排序:TT 最佳着法 → MVV-LVA 吃子 → killer → history
//   评估:eval.zig(tempo 在搜索层施加,与 ai.js 相同)
//
// 与 JS 版的**唯一**语义偏差:wasm 没有墙钟,时间兜底(ms/deadline)
// 不移植 —— 节点预算是主约束,且本来就承诺"同预算可复现"。JS 的
// 迭代早停「节点过半且时间过半」是省墙钟的启发,在节点独大的通道里
// 只会白压深度,故也不移植:迭代一直开到节点预算把搜索掐停为止,等价于
// JS 传超大 ms 预算的行为 ⇒ Node 探针可做"同节点预算 ⇒ 同着法/同分/
// 同深度/同节点数"的逐位对拍。其余每一处(节点计数检查时机、置换表
// 替换策略、走法排序打分、剪枝阈值、aspiration 扩窗节奏)与 ai.js 一致。
// ============================================================
const std = @import("std");
const rules = @import("rules.zig");
const eval = @import("eval.zig");

const WHITE = rules.WHITE;
const PAWN = rules.PAWN;
const KNIGHT = rules.KNIGHT;
const BISHOP = rules.BISHOP;
const ROOK = rules.ROOK;
const QUEEN = rules.QUEEN;
const KING = rules.KING;
const piece = rules.piece;
const mFrom = rules.mFrom;
const mTo = rules.mTo;
const mFlag = rules.mFlag;
const mCap = rules.mCap;
const mIsQuiet = rules.mIsQuiet;
const F_CAP = rules.F_CAP;
const F_EP = rules.F_EP;
const make = rules.make;
const unmake = rules.unmake;
const makeNull = rules.makeNull;
const unmakeNull = rules.unmakeNull;
const genMoves = rules.genMoves;
const genLegal = rules.genLegal;
const isLegal = rules.isLegal;
const inCheck = rules.inCheck;
const isRepetition = rules.isRepetition;
const insufficientMaterial = rules.insufficientMaterial;

//  尺度契约:全部 cp 尺度魔数(与 ai.js SCALE 一致)
const RFP = 95; // 逆向 futility:每层深度的裕度
const FUTILITY = 110; // 静着 futility:每层深度的裕度
const ASP = 35; // aspiration 初始窗口半径

const MATE = 30000;
const MATE_B = 29500;
const INF = 31000;
pub const MAX_PLY = 62;

const SEE_VAL = [7]i32{ 0, 100, 320, 330, 500, 900, 20000 };

//  ============================================================
// 静态交换估值(SEE):只在静态搜索里用
// ============================================================
var SB = [_]i8{0} ** 64;
var GAIN = [_]i32{0} ** 32;
const ND8 = [16]i8{ 1, 2, 2, 1, -1, 2, -2, 1, 1, -2, 2, -1, -1, -2, -2, -1 };
const DD4 = [8]i8{ 1, 1, 1, -1, -1, 1, -1, -1 };
const OD4 = [8]i8{ 1, 0, -1, 0, 0, 1, 0, -1 };
const KD8 = [16]i8{ 1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1 };

/// 在临时棋盘 SB 上找 sq 的最小价值攻击者,返回格号或 -1
fn leastAttacker(sq: usize, by: i8) i32 {
    const r: i32 = @intCast(sq >> 3);
    const c: i32 = @intCast(sq & 7);
    const pw = piece(by, PAWN);
    const kn = piece(by, KNIGHT);
    const pr = r + (if (by == WHITE) @as(i32, 1) else -1);
    if (pr >= 0 and pr < 8) {
        const base: usize = @intCast(pr * 8);
        if (c > 0 and SB[base + @as(usize, @intCast(c - 1))] == pw) return @intCast(base + @as(usize, @intCast(c - 1)));
        if (c < 7 and SB[base + @as(usize, @intCast(c + 1))] == pw) return @intCast(base + @as(usize, @intCast(c + 1)));
    }
    var i: usize = 0;
    while (i < 16) : (i += 2) {
        const rr = r + ND8[i];
        const cc = c + ND8[i + 1];
        if (rr >= 0 and rr < 8 and cc >= 0 and cc < 8 and SB[@intCast(rr * 8 + cc)] == kn) return rr * 8 + cc;
    }
    // 滑动子:每个方向只看第一个子(前一个被吃掉后,后面的会自然成为新的第一个)
    const bi = piece(by, BISHOP);
    const ro = piece(by, ROOK);
    const qu = piece(by, QUEEN);
    const kg = piece(by, KING);
    var bc: i32 = -1;
    var rc: i32 = -1;
    var qc: i32 = -1;
    i = 0;
    while (i < 8) : (i += 2) {
        const dr = DD4[i];
        const dc = DD4[i + 1];
        var rr = r + dr;
        var cc = c + dc;
        while (rr >= 0 and rr < 8 and cc >= 0 and cc < 8) {
            const v = SB[@intCast(rr * 8 + cc)];
            if (v != 0) {
                if (v == bi) bc = rr * 8 + cc else if (v == qu) qc = rr * 8 + cc;
                break;
            }
            rr += dr;
            cc += dc;
        }
    }
    i = 0;
    while (i < 8) : (i += 2) {
        const dr = OD4[i];
        const dc = OD4[i + 1];
        var rr = r + dr;
        var cc = c + dc;
        while (rr >= 0 and rr < 8 and cc >= 0 and cc < 8) {
            const v = SB[@intCast(rr * 8 + cc)];
            if (v != 0) {
                if (v == ro) rc = rr * 8 + cc else if (v == qu) qc = rr * 8 + cc;
                break;
            }
            rr += dr;
            cc += dc;
        }
    }
    // 按价值递增返回:象 330 < 车 500 < 后 900 < 王(王只在最后)
    if (bc >= 0) return bc;
    if (rc >= 0) return rc;
    if (qc >= 0) return qc;
    i = 0;
    while (i < 16) : (i += 2) {
        const rr = r + KD8[i];
        const cc = c + KD8[i + 1];
        if (rr >= 0 and rr < 8 and cc >= 0 and cc < 8 and SB[@intCast(rr * 8 + cc)] == kg) return rr * 8 + cc;
    }
    return -1;
}

/// 该着法的静态交换净收益(厘兵)。升变/吃过路兵返回正值表示"不要剪"。
pub fn see(pos: *const rules.Position, m: i32) i32 {
    const f = mFlag(m);
    if (f == F_EP) return 1;
    if (f >= 6 and f < 10) return 1;
    const b = &pos.b;
    const from = mFrom(m);
    const to = mTo(m);
    @memcpy(&SB, b);
    var onTo: i32 = b[from] & 7;
    if (f >= 10) onTo = QUEEN; // 升变吃子:升变子按后算,保守
    GAIN[0] = if ((b[to] & 7) != 0) SEE_VAL[@intCast(b[to] & 7)] else 0;
    SB[from] = 0;
    var side = pos.stm ^ 1;
    var d: usize = 0;
    while (true) {
        const a = leastAttacker(to, side);
        if (a < 0) break;
        d += 1;
        if (d > 28) break;
        GAIN[d] = SEE_VAL[@intCast(onTo)] - GAIN[d - 1];
        onTo = SB[@intCast(a)] & 7;
        SB[@intCast(a)] = 0;
        side ^= 1;
    }
    while (d > 0) {
        GAIN[d - 1] = -@max(-GAIN[d - 1], GAIN[d]);
        d -= 1;
    }
    return GAIN[0];
}

//  ============================================================
// 搜索状态(模块级复用,与 ai.js 同:零分配)
// ============================================================
var BUF = std.mem.zeroes([MAX_PLY + 4][256]i32);
var SCORE = std.mem.zeroes([MAX_PLY + 4][256]i32);
var KILLER = [_]i32{0} ** (MAX_PLY * 2);
var HIST = [_]i32{0} ** (16 * 64);

const TT_BITS = 19;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
pub var TT = [_]i32{0} ** (TT_SIZE * 6); // keyA / keyB / move / score / depth / flag|age
var ttAge: i32 = 1;

pub var nodes: u64 = 0;
var nodeLimit: u64 = 0;
var stopped: bool = false;
var bestRoot: i32 = 0;

inline fn tempo() i32 {
    return eval.pi(eval.TEMPO);
}
inline fn ttFlag(ti: usize) i32 {
    return TT[ti + 5] & 3;
}
inline fn ttAgeOf(ti: usize) i32 {
    return TT[ti + 5] >> 2;
}

/// 该方还有马/象/车/后吗(空着剪枝的前提:只剩王兵时不能用,会被 zugzwang 骗)
fn hasNonPawn(pos: *const rules.Position, stm: i8) bool {
    var s: usize = 0;
    while (s < 64) : (s += 1) {
        const p = pos.b[s];
        if (p == 0 or (p >> 3) != stm) continue;
        const ty = p & 7;
        if (ty != PAWN and ty != KING) return true;
    }
    return false;
}

inline fn checkStop() bool {
    nodes += 1;
    if (nodes & 2047 == 0 and nodes >= nodeLimit) {
        stopped = true;
        return true;
    }
    return false;
}

//  ---------- 静态搜索:只展开吃子与升变,被将时展开全部着法 ----------
fn qsearch(pos: *rules.Position, alpha_in: i32, beta: i32, ply: usize) i32 {
    if (stopped) return 0;
    if (checkStop()) return 0;

    var alpha = alpha_in;
    if (ply >= MAX_PLY) return eval.evaluate(pos);

    const inC = inCheck(pos);
    var best: i32 = undefined;
    if (inC) {
        best = -INF;
    } else {
        const stand = eval.evaluate(pos) + tempo();
        if (stand >= beta) return stand;
        if (stand > alpha) alpha = stand;
        best = stand;
    }
    if (pos.half >= 100 or isRepetition(pos)) return if (best == -INF) 0 else best;

    const buf = &BUF[ply];
    const sc = &SCORE[ply];
    const n = genMoves(pos, buf);
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const m = buf[i];
        const fl = mFlag(m);
        if (fl == F_CAP or fl >= 10) {
            sc[i] = (1 << 20) + SEE_VAL[@intCast(mCap(m) & 7)] * 16 - SEE_VAL[@intCast(pos.b[mFrom(m)] & 7)] +
                (if (fl >= 10) @as(i32, 1 << 18) else 0);
        } else if (fl == F_EP) {
            sc[i] = (1 << 20) + 1400;
        } else if (fl >= 6) {
            sc[i] = 1 << 21; // 静着升变必须搜
        } else {
            sc[i] = if (inC) 0 else -1; // 被将时静着(避将)也要搜
        }
    }

    var tried: i32 = 0;
    i = 0;
    while (i < n) : (i += 1) {
        // 选最大分剩余着法(交换到 i 位)
        var bi: i32 = -1;
        var bs: i32 = -1;
        var j: usize = i;
        while (j < n) : (j += 1) {
            if (sc[j] > bs) {
                bs = sc[j];
                bi = @intCast(j);
            }
        }
        if (bs < 0) break;
        const m = buf[@intCast(bi)];
        buf[@intCast(bi)] = buf[i];
        buf[i] = m;
        sc[@intCast(bi)] = sc[i];
        sc[i] = bs;

        const fl = mFlag(m);
        const isCap = fl == F_CAP or fl >= 10;
        if (isCap and !inC) {
            if (see(pos, m) < 0) continue; // 亏本吃子,不进搜索
            if (best > -INF and best + SEE_VAL[@intCast(mCap(m) & 7)] + 200 <= alpha) continue; // Δ 剪枝
        }
        if (!isLegal(pos, m)) continue;
        make(pos, m);
        const s = -qsearch(pos, -beta, -alpha, ply + 1);
        unmake(pos, m);
        if (stopped) return 0;
        tried += 1;
        if (s > best) {
            best = s;
            if (s > alpha) {
                alpha = s;
                if (alpha >= beta) return s;
            }
        }
    }
    if (inC and tried == 0) return -MATE + @as(i32, @intCast(ply)); // 被将且无着法 = 被将死
    return best;
}

//  ---------- 主搜索 ----------
fn search(pos: *rules.Position, depth_in: i32, alpha_in: i32, beta: i32, ply: usize, canNull: bool) i32 {
    if (stopped) return 0;
    if (checkStop()) return 0;

    var depth = depth_in;
    var alpha = alpha_in;

    if (ply > 0) {
        if (pos.half >= 100 or isRepetition(pos) or insufficientMaterial(pos)) return 0;
        if (ply >= MAX_PLY) return eval.evaluate(pos);
    }

    const inC = inCheck(pos);
    if (inC and ply < 40) depth += 1; // 将军延伸:总量由 ply 上限兜住
    if (depth <= 0) return qsearch(pos, alpha, beta, ply);

    const ti: usize = @intCast((pos.keyA & TT_MASK) * 6);
    var ttMove: i32 = 0;
    if (ply > 0 and TT[ti] == pos.keyA and TT[ti + 1] == pos.keyB) {
        ttMove = TT[ti + 2];
        if (TT[ti + 4] >= depth) {
            var s = TT[ti + 3];
            if (s > MATE_B) s -= @intCast(ply) else if (s < -MATE_B) s += @intCast(ply);
            const fl = ttFlag(ti);
            if (fl == 0) return s;
            if (fl == 1 and s >= beta) return s;
            if (fl == 2 and s <= alpha) return s;
        }
    }

    const pvNode = beta - alpha > 1;
    const staticEval: i32 = if (inC) -INF else eval.evaluate(pos) + tempo();

    // 逆向 futility:静态分已经高出 β 一大截,直接当下界返回(杀分区间除外)
    if (!pvNode and !inC and depth <= 3 and @abs(beta) < MATE_B and staticEval - RFP * depth >= beta) {
        return staticEval;
    }

    // 空着剪枝:轮到自己走却"不走都够好",说明局面已经赢了,搜个更浅的确认即可
    if (!pvNode and !inC and canNull and depth >= 3 and @abs(beta) < MATE_B and staticEval >= beta and hasNonPawn(pos, pos.stm)) {
        makeNull(pos);
        const s = -search(pos, depth - 1 - (if (depth > 6) @as(i32, 3) else 2), -beta, -beta + 1, ply + 1, false);
        unmakeNull(pos);
        if (stopped) return 0;
        if (s >= beta) return beta;
    }

    const buf = &BUF[ply];
    const sc = &SCORE[ply];
    const n = genMoves(pos, buf);
    const k0 = KILLER[ply * 2];
    const k1 = KILLER[ply * 2 + 1];
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const m = buf[i];
        if (m == ttMove) {
            sc[i] = 1 << 24;
            continue;
        }
        const fl = mFlag(m);
        if (fl == F_CAP or fl >= 10) {
            sc[i] = (1 << 20) + SEE_VAL[@intCast(mCap(m) & 7)] * 16 - SEE_VAL[@intCast(pos.b[mFrom(m)] & 7)];
        } else if (fl == F_EP) {
            sc[i] = (1 << 20) + 1200;
        } else if (fl >= 6) {
            sc[i] = 1 << 21;
        } else if (m == k0) {
            sc[i] = 1 << 19;
        } else if (m == k1) {
            sc[i] = (1 << 19) - 1;
        } else {
            sc[i] = HIST[(@as(usize, @intCast(pos.b[mFrom(m)] & 15)) << 6) | mTo(m)];
        }
    }

    var best: i32 = 0;
    var bestScore: i32 = -INF;
    var tried: i32 = 0;
    var flag: i32 = 2; // 2 = UPPER(还没提升过 α)
    i = 0;
    while (i < n) : (i += 1) {
        var bi: usize = i;
        var bs: i32 = -1;
        var j: usize = i + 1;
        while (j < n) : (j += 1) {
            if (sc[j] > bs) {
                bs = sc[j];
                bi = j;
            }
        }
        if (bs > sc[i]) {
            const tm = buf[i];
            buf[i] = buf[bi];
            buf[bi] = tm;
            const ts = sc[i];
            sc[i] = sc[bi];
            sc[bi] = ts;
        }

        const m = buf[i];
        const quiet = mIsQuiet(m);
        if (!isLegal(pos, m)) continue;

        // 静着剪枝:只在非主变、未被将、且已经搜过着法时启用,并避开杀分区间
        if (quiet and !pvNode and !inC and tried > 0 and @abs(alpha) < MATE_B) {
            if (depth <= 2 and staticEval + FUTILITY * depth <= alpha) continue; // futility
            if (depth <= 3 and tried >= 4 + depth * depth) continue; // 迟着剪枝
        }

        make(pos, m);
        var score: i32 = undefined;
        if (tried == 0) {
            score = -search(pos, depth - 1, -beta, -alpha, ply + 1, true);
        } else {
            var r: i32 = 0;
            if (quiet and depth >= 3 and tried >= 3 and !inC) {
                r = 1 + (if (tried > 5 + depth * 2) @as(i32, 1) else 0); // LMR
                if (pvNode) r -= 1;
                if (r < 0) r = 0;
            }
            score = -search(pos, depth - 1 - r, -alpha - 1, -alpha, ply + 1, true);
            if (!stopped and r > 0 and score > alpha) score = -search(pos, depth - 1, -alpha - 1, -alpha, ply + 1, true);
            if (!stopped and score > alpha and score < beta) score = -search(pos, depth - 1, -beta, -alpha, ply + 1, false);
        }
        unmake(pos, m);
        if (stopped) return 0;
        tried += 1;

        if (score > bestScore) {
            bestScore = score;
            best = m;
            if (score > alpha) {
                alpha = score;
                flag = 0; // EXACT
                if (ply == 0) bestRoot = m;
            }
        }
        if (alpha >= beta) {
            flag = 1; // LOWER
            if (quiet) {
                if (KILLER[ply * 2] != m) {
                    KILLER[ply * 2 + 1] = KILLER[ply * 2];
                    KILLER[ply * 2] = m;
                }
                const hi = (@as(usize, @intCast(pos.b[mFrom(m)] & 15)) << 6) | mTo(m);
                HIST[hi] += depth * depth;
                if (HIST[hi] > (1 << 18)) {
                    var z: usize = 0;
                    while (z < HIST.len) : (z += 1) HIST[z] >>= 1;
                }
            }
            break;
        }
    }
    if (tried == 0) return if (inC) -(MATE - @as(i32, @intCast(ply))) else 0; // 将死 / 逼和

    const st: i32 = if (bestScore > MATE_B) bestScore + @as(i32, @intCast(ply)) else if (bestScore < -MATE_B) bestScore - @as(i32, @intCast(ply)) else bestScore;
    const sameKey = TT[ti] == pos.keyA and TT[ti + 1] == pos.keyB;
    if (!sameKey or ttAgeOf(ti) != ttAge or depth >= TT[ti + 4]) {
        TT[ti] = pos.keyA;
        TT[ti + 1] = pos.keyB;
        TT[ti + 2] = best;
        TT[ti + 3] = st;
        TT[ti + 4] = depth;
        TT[ti + 5] = flag | (ttAge << 2);
    }
    return bestScore;
}

//  ============================================================
// 对外入口
// ============================================================
pub const Result = struct {
    move: i32 = 0,
    score: i32 = 0, // 白方视角厘兵
    depth: i32 = 0,
    nodes: u64 = 0,
};

pub const Config = struct {
    nodes: u64 = 40000,
    depth: i32 = 24,
    jitter: i32 = 0, // 低难度档:在"最优 ±jitter"里(带种子)随机挑
    seed: u32 = 0,
};

/// jitter 弱档的带种子随机(与 Math.random 的角色相同,弱档只求可控的弱)
const Mb32 = struct {
    s: u32,
    fn next(m: *Mb32) u32 {
        m.s +%= 0x6D2B79F5;
        var t: u32 = m.s ^ (m.s >> 15);
        t *%= 1 | m.s;
        const t2: u32 = t ^ (t >> 7);
        t = (t +% (t2 *% (61 | t))) ^ t;
        return t ^ (t >> 14);
    }
};

pub fn searchBest(pos: *rules.Position, cfg: Config) Result {
    nodes = 0;
    stopped = false;
    bestRoot = 0;
    nodeLimit = if (cfg.nodes == 0) 40000 else cfg.nodes;
    ttAge = (ttAge + 1) & 0x3fffff;
    @memset(&KILLER, 0);
    @memset(&HIST, 0);

    const rootBuf = &BUF[MAX_PLY + 2];
    const nRoot = genLegal(pos, rootBuf);
    if (nRoot == 0) return .{};
    // 只有一个着法:没什么可算的,直接给(省掉整段搜索,也避免 UI 白等)
    if (nRoot == 1) return .{ .move = rootBuf[0] };
    const flip: i32 = if (pos.stm == WHITE) 1 else -1;

    //  低难度档:固定浅深度逐个给根着法打分,再在"最优 ±jitter"里随机挑一个。
    // 比给评分加随机噪声正统:同一局面不会一会儿选 A 一会儿选 B,弱得可控。
    if (cfg.jitter != 0) {
        const depth: i32 = @max(1, if (cfg.depth == 0) 2 else cfg.depth);
        var prng = Mb32{ .s = cfg.seed };
        var candMove = [_]i32{0} ** 256;
        var candScore = [_]i32{0} ** 256;
        var nCand: usize = 0;
        var i: usize = 0;
        while (i < nRoot and !stopped) : (i += 1) {
            make(pos, rootBuf[i]);
            const s = -search(pos, depth - 1, -INF, INF, 1, false);
            unmake(pos, rootBuf[i]);
            if (!stopped) {
                candMove[nCand] = rootBuf[i];
                candScore[nCand] = s;
                nCand += 1;
            }
        }
        if (nCand == 0) return .{ .move = rootBuf[0], .nodes = nodes };
        var topS: i32 = -INF;
        i = 0;
        while (i < nCand) : (i += 1) {
            if (candScore[i] > topS) topS = candScore[i];
        }
        var pool = [_]usize{0} ** 256;
        var nPool: usize = 0;
        i = 0;
        while (i < nCand) : (i += 1) {
            if (candScore[i] >= topS - cfg.jitter) {
                pool[nPool] = i;
                nPool += 1;
            }
        }
        const pick = pool[prng.next() % nPool];
        return .{ .move = candMove[pick], .score = candScore[pick] * flip, .depth = depth, .nodes = nodes };
    }

    var prev: i32 = 0;
    var doneDepth: i32 = 0;
    var best: i32 = 0;
    var score: i32 = 0;
    const maxDepth = @min(if (cfg.depth == 0) 24 else cfg.depth, MAX_PLY - 4);
    var d: i32 = 1;
    while (d <= maxDepth) : (d += 1) {
        var delta: i32 = ASP;
        var a: i32 = if (d >= 4) prev - delta else -INF;
        var b: i32 = if (d >= 4) prev + delta else INF;
        while (true) {
            score = search(pos, d, a, b, 0, true);
            if (stopped) break;
            if (score <= a) {
                a = @max(-INF, a - delta);
                delta += delta >> 1;
            } else if (score >= b) {
                b = @min(INF, b + delta);
                delta += delta >> 1;
            } else break;
            if (delta > 3000) {
                a = -INF;
                b = INF;
            }
        }
        if (stopped) break;
        prev = score;
        doneDepth = d;
        best = bestRoot;
        if (score > MATE_B - 200 or score < -MATE_B + 200) break; // 已见到杀,不必再深
        // 无早停:迭代开到节点预算把搜索掐停为止(JS 的时间子句在节点独大的通道里无意义)
    }
    if (best == 0) best = rootBuf[0];
    return .{ .move = best, .score = prev * flip, .depth = doneDepth, .nodes = nodes };
}

/// 换局时清置换表(app 侧新对局会换新 Worker,这里给探针/长驻 Worker 用)
pub fn clearTT() void {
    @memset(&TT, 0);
    ttAge = 1;
}
