//  ============================================================
// 国际象棋棋规引擎(zig 通道)—— src/rules.js 的逐句移植。
//
// 移植纪律:与 JS 版**语义逐位一致**是本通道的存在前提 ——
//   · Zobrist 用同一个 mulberry32、同一组种子 ⇒ 哈希与 JS 完全相同,
//     重复局面判定 / 置换表跨实现对拍才有意义;
//   · 走法 int32 打包、标志位、升变编码原样保留 ⇒ worker/UI 零改动;
//   · undo 栈 / hist 环形化的地方(见注释)只影响"多长的对局能装下",
//     不改变任何可见行为(isRepetition 的回看窗口由 halfmove 计数封顶)。
//
// 内部表示(与 rules.js 相同):
//   棋盘 [64]i8 mailbox:棋子编码 (色<<3)|型,0 = 空;
//   sq = r*8+c,r=0 是 8 线(黑底线)、r=7 是 1 线(白底线);
//   走法 int32 打包(起/终/标志/被吃子),搜索全程零分配。
// ============================================================
const std = @import("std");

pub const WHITE: i8 = 0;
pub const BLACK: i8 = 1;

pub const PAWN: i8 = 1;
pub const KNIGHT: i8 = 2;
pub const BISHOP: i8 = 3;
pub const ROOK: i8 = 4;
pub const QUEEN: i8 = 5;
pub const KING: i8 = 6;

pub inline fn piece(c: i8, t: i8) i8 {
    return (c << 3) | t;
}
pub inline fn colorOf(p: i8) i8 {
    return p >> 3;
}
pub inline fn typeOf(p: i8) i8 {
    return p & 7;
}

//  ---------- 走法打包(与 rules.js 完全一致)----------
// bit 0-5 起格 / 6-11 终格 / 12-15 标志 / 16-19 被吃子(0=无)
// 标志:0 静着 · 1 兵双步 · 2 短易位 · 3 长易位 · 4 吃子 · 5 吃过路兵
//       6..9  升变为 N/B/R/Q(静着)
//       10..13 升变且吃子(升变子型号 = (标志&3)+2)
pub const F_QUIET: u5 = 0;
pub const F_DOUBLE: u5 = 1;
pub const F_OO: u5 = 2;
pub const F_OOO: u5 = 3;
pub const F_CAP: u5 = 4;
pub const F_EP: u5 = 5;

pub inline fn mFrom(m: i32) u6 {
    return @truncate(@as(u32, @bitCast(m)) & 63);
}
pub inline fn mTo(m: i32) u6 {
    return @truncate((@as(u32, @bitCast(m)) >> 6) & 63);
}
pub inline fn mFlag(m: i32) u5 {
    return @truncate((@as(u32, @bitCast(m)) >> 12) & 15);
}
pub inline fn mCap(m: i32) i8 {
    return @truncate((m >> 16) & 15);
}
pub inline fn mPromo(m: i32) i8 {
    const f = mFlag(m);
    return if (f >= 6) @as(i8, @intCast((f - 6) & 3)) + 2 else 0;
}
pub inline fn mkMove(from: i32, to: i32, f: i32, cap: i32) i32 {
    return from | (to << 6) | (f << 12) | (cap << 16);
}
pub inline fn mIsQuiet(m: i32) bool {
    const f = mFlag(m);
    return f == F_QUIET or f == F_DOUBLE;
}

pub const C_WK: i8 = 1;
pub const C_WQ: i8 = 2;
pub const C_BK: i8 = 4;
pub const C_BQ: i8 = 8;

const SQ_A1 = 56;
const SQ_H1 = 63;
const SQ_A8 = 0;
const SQ_H8 = 7;
const SQ_E1 = 60;
const SQ_E8 = 4;

//  ---------- 预计算攻击表(comptime 建表,几何与 JS 表完全一致)----------
const ND = [16]i8{ 1, 2, 2, 1, -1, 2, -2, 1, 1, -2, 2, -1, -1, -2, -2, -1 };
const KD = [16]i8{ 1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1 };
const DD = [8]i8{ 1, 1, 1, -1, -1, 1, -1, -1 };
const OD = [8]i8{ 1, 0, -1, 0, 0, 1, 0, -1 };

/// 每格被马/王攻击到的格子(扁平 + 每格起始偏移,容量 64*8)
pub const N_ATK: [512]i8 = blk: {
    var t = [_]i8{0} ** 512;
    var los = [_]i32{0} ** 65;
    buildHop(&t, &los, &ND);
    break :blk t;
};
pub const N_ATK_LO: [65]i32 = blk: {
    var t = [_]i8{0} ** 512;
    var los = [_]i32{0} ** 65;
    buildHop(&t, &los, &ND);
    break :blk los;
};
pub const K_ATK: [512]i8 = blk: {
    var t = [_]i8{0} ** 512;
    var los = [_]i32{0} ** 65;
    buildHop(&t, &los, &KD);
    break :blk t;
};
pub const K_ATK_LO: [65]i32 = blk: {
    var t = [_]i8{0} ** 512;
    var los = [_]i32{0} ** 65;
    buildHop(&t, &los, &KD);
    break :blk los;
};

fn buildHop(targets: *[512]i8, los: *[65]i32, hit: *const [16]i8) void {
    @setEvalBranchQuota(100000);
    var n: usize = 0;
    var s: usize = 0;
    while (s < 64) : (s += 1) {
        los[s] = @intCast(n);
        const r: i32 = @intCast(s >> 3);
        const c: i32 = @intCast(s & 7);
        var i: usize = 0;
        while (i < 16) : (i += 2) {
            const rr = r + hit[i];
            const cc = c + hit[i + 1];
            if (rr >= 0 and rr < 8 and cc >= 0 and cc < 8) {
                targets[n] = @intCast(rr * 8 + cc);
                n += 1;
            }
        }
    }
    los[64] = @intCast(n);
}

/// 每格沿 4 条斜线/正线的射线格子序列(离源格由近及远)。
/// DIAG_SEG/ORTHO_SEG 按「格 × 方向」分段:SEG[s*4+d] .. SEG[s*4+d+1]。
pub const DIAG_RAY: [832]i8 = blk: {
    var t = [_]i8{0} ** 832;
    var segs = [_]i32{0} ** 320;
    buildRay(&t, &segs, &DD);
    break :blk t;
};
pub const DIAG_SEG: [320]i32 = blk: {
    var t = [_]i8{0} ** 832;
    var segs = [_]i32{0} ** 320;
    buildRay(&t, &segs, &DD);
    break :blk segs;
};
pub const ORTHO_RAY: [896]i8 = blk: {
    var t = [_]i8{0} ** 896;
    var segs = [_]i32{0} ** 320;
    buildRay(&t, &segs, &OD);
    break :blk t;
};
pub const ORTHO_SEG: [320]i32 = blk: {
    var t = [_]i8{0} ** 896;
    var segs = [_]i32{0} ** 320;
    buildRay(&t, &segs, &OD);
    break :blk segs;
};

fn buildRay(targets: anytype, segs: *[320]i32, hit: *const [8]i8) void {
    @setEvalBranchQuota(100000);
    var n: usize = 0;
    var s: usize = 0;
    while (s < 64) : (s += 1) {
        const r: i32 = @intCast(s >> 3);
        const c: i32 = @intCast(s & 7);
        var d: usize = 0;
        while (d < 4) : (d += 1) {
            segs[s * 4 + d] = @intCast(n);
            var rr = r + hit[d * 2];
            var cc = c + hit[d * 2 + 1];
            while (rr >= 0 and rr < 8 and cc >= 0 and cc < 8) {
                targets[n] = @intCast(rr * 8 + cc);
                n += 1;
                rr += hit[d * 2];
                cc += hit[d * 2 + 1];
            }
        }
        segs[s * 4 + 4] = @intCast(n);
    }
}

//  ============================================================
// Zobrist —— mulberry32 与种子和 rules.js 完全同源 ⇒ 哈希逐位一致
// 索引区间:棋子 (编码<<6)|格 → 0..1023;1024 走子权;1025..1040 易位权;
// 1041..1048 吃过路兵目标格所在的线(列)。
// ============================================================
/// JS 侧 mulberry32 的位级等价实现(u32 环绕运算;每步与 Math.imul/|0 的
/// 补码行为逐位相同),种子相同 ⇒ 生成的 Zobrist 表与 rules.js 完全一致。
const Mulberry32 = struct {
    s: u32,
    fn next(m: *Mulberry32) u32 {
        m.s +%= 0x6D2B79F5;
        var t: u32 = m.s ^ (m.s >> 15);
        t *%= 1 | m.s;
        const t2: u32 = t ^ (t >> 7);
        t = (t +% (t2 *% (61 | t))) ^ t;
        return t ^ (t >> 14);
    }
};

const Z_LEN = 1049;
pub const ZA: [Z_LEN]i32 = blk: {
    @setEvalBranchQuota(100000);
    var prng = Mulberry32{ .s = 0x1a2b3c4d };
    var t = [_]i32{0} ** Z_LEN;
    var i: usize = 0;
    while (i < Z_LEN) : (i += 1) t[i] = @bitCast(prng.next());
    break :blk t;
};
pub const ZB: [Z_LEN]i32 = blk: {
    @setEvalBranchQuota(100000);
    var prng = Mulberry32{ .s = 0x7f4a8c19 };
    var t = [_]i32{0} ** Z_LEN;
    var i: usize = 0;
    while (i < Z_LEN) : (i += 1) t[i] = @bitCast(prng.next());
    break :blk t;
};

//  ============================================================
// 局面。JS 版 hist 是无限数组;这里用环形缓冲 —— isRepetition/
// isThreefold 的回看窗口由 halfmove 计数封顶(≤100 半步),环形容量
// 2048 远大于窗口,可见行为与无限数组完全一致。undo 栈同理:
// 对局 ply + 搜索 62 层,1024 深度对 50 步规则下的任何真实对局都够。
// ============================================================
pub const HIST_CAP = 2048;
pub const UNDO_CAP = 1024;

pub const Position = struct {
    b: [64]i8 = [_]i8{0} ** 64,
    stm: i8 = WHITE,
    castle: i8 = 15,
    ep: i8 = -1,
    half: i32 = 0,
    keyA: i32 = 0,
    keyB: i32 = 0,
    ks: [2]i8 = .{ SQ_E1, SQ_E8 },
    hist: [HIST_CAP]i32 = [_]i32{0} ** HIST_CAP, // 环形:走这步之前的哈希
    histLen: usize = 0, // 总写入数(超过容量的旧值按环形被覆盖,但窗口内永远可见)
    histMask: usize = HIST_CAP - 1,
    ply: i32 = 0,
    undo: [6 * UNDO_CAP]i32 = [_]i32{0} ** (6 * UNDO_CAP),

    /// hist[i](i 从新到旧,0 = 最近一次走子前)
    inline fn histAt(pos: *const Position, i: usize) i32 {
        return pos.hist[i & pos.histMask];
    }
};

/// 初始局面(与 newPos() 一致)
pub fn newPos() Position {
    var pos = Position{};
    const back = [8]i8{ ROOK, KNIGHT, BISHOP, QUEEN, KING, BISHOP, KNIGHT, ROOK };
    var c: usize = 0;
    while (c < 8) : (c += 1) {
        pos.b[c] = piece(BLACK, back[c]);
        pos.b[8 + c] = piece(BLACK, PAWN);
        pos.b[48 + c] = piece(WHITE, PAWN);
        pos.b[56 + c] = piece(WHITE, back[c]);
    }
    pos.ks[0] = SQ_E1;
    pos.ks[1] = SQ_E8;
    _ = recomputeKeys(&pos);
    return pos;
}

/// 全量重算哈希(初始化与测试用;搜索路径上只用增量)
pub fn recomputeKeys(pos: *Position) i32 {
    var a: i32 = 0;
    var bb: i32 = 0;
    var s: usize = 0;
    while (s < 64) : (s += 1) {
        const p = pos.b[s];
        if (p != 0) {
            const i = (@as(usize, @intCast(@as(u32, @intCast(p)))) << 6) | s;
            a ^= ZA[i];
            bb ^= ZB[i];
        }
    }
    if (pos.stm != 0) {
        a ^= ZA[1024];
        bb ^= ZB[1024];
    }
    a ^= ZA[1025 + @as(usize, @intCast(pos.castle))];
    bb ^= ZB[1025 + @as(usize, @intCast(pos.castle))];
    if (pos.ep >= 0) {
        const f: usize = @intCast(pos.ep & 7);
        a ^= ZA[1041 + f];
        bb ^= ZB[1041 + f];
    }
    pos.keyA = a;
    pos.keyB = bb;
    return a;
}

//  ============================================================
// 攻击判定
// ============================================================
pub fn attacked(b: *const [64]i8, sq: usize, by: i8) bool {
    // 兵:白兵在白方视角"上一行"(r+1)
    const pr: i32 = @as(i32, @intCast(sq >> 3)) + (if (by == WHITE) @as(i32, 1) else -1);
    if (pr >= 0 and pr < 8) {
        const pawn = piece(by, PAWN);
        const base: usize = @intCast(pr * 8);
        const c: usize = sq & 7;
        if (c > 0 and b[base + c - 1] == pawn) return true;
        if (c < 7 and b[base + c + 1] == pawn) return true;
    }
    const kn = piece(by, KNIGHT);
    var i: usize = @intCast(N_ATK_LO[sq]);
    const ne: usize = @intCast(N_ATK_LO[sq + 1]);
    while (i < ne) : (i += 1) if (b[@intCast(N_ATK[i])] == kn) return true;
    const kg = piece(by, KING);
    i = @intCast(K_ATK_LO[sq]);
    const ke: usize = @intCast(K_ATK_LO[sq + 1]);
    while (i < ke) : (i += 1) if (b[@intCast(K_ATK[i])] == kg) return true;

    const bi = piece(by, BISHOP);
    const qu = piece(by, QUEEN);
    const ro = piece(by, ROOK);
    const d0 = sq * 4;
    var dir: usize = 0;
    while (dir < 4) : (dir += 1) {
        var j: usize = @intCast(DIAG_SEG[d0 + dir]);
        const je: usize = @intCast(DIAG_SEG[d0 + dir + 1]);
        while (j < je) : (j += 1) {
            const v = b[@intCast(DIAG_RAY[j])];
            if (v != 0) {
                if (v == bi or v == qu) return true;
                break;
            }
        }
    }
    dir = 0;
    while (dir < 4) : (dir += 1) {
        var j: usize = @intCast(ORTHO_SEG[d0 + dir]);
        const je: usize = @intCast(ORTHO_SEG[d0 + dir + 1]);
        while (j < je) : (j += 1) {
            const v = b[@intCast(ORTHO_RAY[j])];
            if (v != 0) {
                if (v == ro or v == qu) return true;
                break;
            }
        }
    }
    return false;
}

/// 走子方是否被将军
pub fn inCheck(pos: *const Position) bool {
    return inCheckOf(pos, pos.stm);
}
pub fn inCheckOf(pos: *const Position, color: i8) bool {
    return attacked(&pos.b, @intCast(pos.ks[@intCast(color)]), color ^ 1);
}

//  ============================================================
// 走法生成(伪合法;合法性由 isLegal / genLegal 过滤)
// ============================================================
pub fn genMoves(pos: *Position, out: []i32) usize {
    const b = &pos.b;
    const stm = pos.stm;
    var n: usize = 0;
    var sq: usize = 0;
    while (sq < 64) : (sq += 1) {
        const pc = b[sq];
        if (pc == 0 or (pc >> 3) != stm) continue;
        const ty = pc & 7;
        const r: i32 = @intCast(sq >> 3);
        const c: i32 = @intCast(sq & 7);

        if (ty == PAWN) {
            const up: i32 = if (stm == WHITE) -8 else 8;
            const startR: i32 = if (stm == WHITE) 6 else 1;
            const lastR: i32 = if (stm == WHITE) 0 else 7;
            const t: i32 = @as(i32, @intCast(sq)) + up;
            if (t >= 0 and t < 64 and b[@intCast(t)] == 0) {
                if ((t >> 3) == lastR) {
                    var q: i32 = 0;
                    while (q < 4) : (q += 1) {
                        out[n] = mkMove(@intCast(sq), @intCast(t), 6 + q, 0);
                        n += 1;
                    }
                } else {
                    out[n] = mkMove(@intCast(sq), @intCast(t), F_QUIET, 0);
                    n += 1;
                    if (r == startR and b[@intCast(t + up)] == 0) {
                        out[n] = mkMove(@intCast(sq), @intCast(t + up), F_DOUBLE, 0);
                        n += 1;
                    }
                }
            }
            var dc: i32 = -1;
            while (dc <= 1) : (dc += 2) {
                const cc = c + dc;
                if (cc < 0 or cc > 7) continue; // 列越界检查同时也是"不绕行"的保证
                const t2 = t + dc;
                if (t2 < 0 or t2 > 63) continue;
                const tp = b[@intCast(t2)];
                if (tp != 0) {
                    if ((tp >> 3) == stm) continue;
                    if ((t2 >> 3) == lastR) {
                        var q: i32 = 0;
                        while (q < 4) : (q += 1) {
                            out[n] = mkMove(@intCast(sq), @intCast(t2), 10 + q, tp);
                            n += 1;
                        }
                    } else {
                        out[n] = mkMove(@intCast(sq), @intCast(t2), F_CAP, tp);
                        n += 1;
                    }
                } else if (t2 == pos.ep) {
                    out[n] = mkMove(@intCast(sq), @intCast(t2), F_EP, piece(stm ^ 1, PAWN));
                    n += 1;
                }
            }
        } else if (ty == KNIGHT or ty == KING) {
            const dirs = if (ty == KNIGHT) &ND else &KD;
            var i: usize = 0;
            while (i < 16) : (i += 2) {
                const rr = r + dirs[i];
                const cc = c + dirs[i + 1];
                if (rr < 0 or rr > 7 or cc < 0 or cc > 7) continue;
                const t: usize = @intCast(rr * 8 + cc);
                const tp = b[t];
                if (tp != 0 and (tp >> 3) == stm) continue;
                out[n] = if (tp != 0)
                    mkMove(@intCast(sq), @intCast(t), F_CAP, tp)
                else
                    mkMove(@intCast(sq), @intCast(t), F_QUIET, 0);
                n += 1;
            }
            if (ty == KING) {
                const hb: i32 = if (stm == WHITE) 56 else 0;
                if (sq == @as(usize, @intCast(hb + 4))) {
                    const kR: i8 = if (stm == WHITE) C_WK else C_BK;
                    const qR: i8 = if (stm == WHITE) C_WQ else C_BQ;
                    if ((pos.castle & kR) != 0 and b[@intCast(hb + 7)] == piece(stm, ROOK) and b[@intCast(hb + 5)] == 0 and b[@intCast(hb + 6)] == 0) {
                        out[n] = mkMove(@intCast(sq), @intCast(hb + 6), F_OO, 0);
                        n += 1;
                    }
                    if ((pos.castle & qR) != 0 and b[@intCast(hb)] == piece(stm, ROOK) and b[@intCast(hb + 1)] == 0 and b[@intCast(hb + 2)] == 0 and b[@intCast(hb + 3)] == 0) {
                        out[n] = mkMove(@intCast(sq), @intCast(hb + 2), F_OOO, 0);
                        n += 1;
                    }
                }
            }
        } else {
            // 象 / 车 / 后:按方向射线
            if (ty == BISHOP or ty == QUEEN) {
                var i: usize = 0;
                while (i < 8) : (i += 2) n = rayWalk(b, sq, DD[i], DD[i + 1], stm, out, n);
            }
            if (ty == ROOK or ty == QUEEN) {
                var i: usize = 0;
                while (i < 8) : (i += 2) n = rayWalk(b, sq, OD[i], OD[i + 1], stm, out, n);
            }
        }
    }
    return n;
}

/// 单方向射线:把沿途空格写成静着,遇到子则(敌子)吃子后停
fn rayWalk(b: *const [64]i8, sq: usize, dr: i8, dc: i8, stm: i8, out: []i32, n_in: usize) usize {
    var n = n_in;
    var rr: i32 = @as(i32, @intCast(sq >> 3)) + dr;
    var cc: i32 = @as(i32, @intCast(sq & 7)) + dc;
    while (rr >= 0 and rr < 8 and cc >= 0 and cc < 8) {
        const t: usize = @intCast(rr * 8 + cc);
        const tp = b[t];
        if (tp == 0) {
            out[n] = mkMove(@intCast(sq), @intCast(t), F_QUIET, 0);
            n += 1;
        } else {
            if ((tp >> 3) != stm) {
                out[n] = mkMove(@intCast(sq), @intCast(t), F_CAP, tp);
                n += 1;
            }
            break;
        }
        rr += dr;
        cc += dc;
    }
    return n;
}

//  ============================================================
// make / unmake
// ============================================================
pub fn make(pos: *Position, m: i32) void {
    const b = &pos.b;
    const from: usize = mFrom(m);
    const to: usize = mTo(m);
    const f = mFlag(m);
    const cap = mCap(m);
    const k: usize = @intCast(pos.ply * 6);
    const u = &pos.undo;
    u[k] = cap;
    u[k + 1] = pos.castle;
    u[k + 2] = pos.ep;
    u[k + 3] = pos.half;
    u[k + 4] = pos.keyA;
    u[k + 5] = pos.keyB;
    pos.ply += 1;
    pos.hist[pos.histLen & pos.histMask] = pos.keyA;
    pos.histLen += 1;

    const pc = b[from];
    const col = pc >> 3;
    const ty = pc & 7;
    var a = pos.keyA;
    var bb = pos.keyB;

    if (f == F_EP) {
        // 被吃的兵不在落点上,而在落点"后面一格"
        const cs: usize = @intCast(@as(i32, @intCast(to)) + (if (col == WHITE) @as(i32, 8) else -8));
        const cp = b[cs];
        b[cs] = 0;
        const i = (@as(usize, @intCast(@as(u32, @intCast(cp)))) << 6) | cs;
        a ^= ZA[i];
        bb ^= ZB[i];
    } else if (cap != 0) {
        const i = (@as(usize, @intCast(@as(u32, @intCast(cap)))) << 6) | to;
        a ^= ZA[i];
        bb ^= ZB[i];
    }
    // 移走源子。升变时源子是兵,落子换成升变子,所以 from 上 XOR 的始终是原兵
    var i = (@as(usize, @intCast(@as(u32, @intCast(pc)))) << 6) | from;
    a ^= ZA[i];
    bb ^= ZB[i];
    b[from] = 0;

    // 升变的落子型号 = ((标志-6)&3)+2:6..9 与 10..13 两段都映射到 N/B/R/Q
    const np: i8 = if (f >= 6) piece(col, @as(i8, @intCast((@as(i32, f) - 6) & 3)) + 2) else pc;
    b[to] = np;
    i = (@as(usize, @intCast(@as(u32, @intCast(np)))) << 6) | to;
    a ^= ZA[i];
    bb ^= ZB[i];

    if (f == F_OO or f == F_OOO) {
        const rf: usize = if (f == F_OO) to + 1 else to - 2;
        const rt: usize = if (f == F_OO) to - 1 else to + 1;
        const rk = b[rf];
        b[rf] = 0;
        b[rt] = rk;
        i = (@as(usize, @intCast(@as(u32, @intCast(rk)))) << 6) | rf;
        a ^= ZA[i];
        bb ^= ZB[i];
        i = (@as(usize, @intCast(@as(u32, @intCast(rk)))) << 6) | rt;
        a ^= ZA[i];
        bb ^= ZB[i];
    }

    // 易位权:王动了清两侧;车离开了原位或车被吃也清
    const oldC = pos.castle;
    if (ty == KING) {
        pos.castle &= if (col == WHITE) ~(C_WK | C_WQ) else ~(C_BK | C_BQ);
    } else if (ty == ROOK) {
        if (from == SQ_A1) {
            pos.castle &= ~C_WQ;
        } else if (from == SQ_H1) {
            pos.castle &= ~C_WK;
        } else if (from == SQ_A8) {
            pos.castle &= ~C_BQ;
        } else if (from == SQ_H8) {
            pos.castle &= ~C_BK;
        }
    }
    if (to == SQ_A1) {
        pos.castle &= ~C_WQ;
    } else if (to == SQ_H1) {
        pos.castle &= ~C_WK;
    } else if (to == SQ_A8) {
        pos.castle &= ~C_BQ;
    } else if (to == SQ_H8) {
        pos.castle &= ~C_BK;
    }
    if (oldC != pos.castle) {
        a ^= ZA[1025 + @as(usize, @intCast(oldC))] ^ ZA[1025 + @as(usize, @intCast(pos.castle))];
        bb ^= ZB[1025 + @as(usize, @intCast(oldC))] ^ ZB[1025 + @as(usize, @intCast(pos.castle))];
    }

    const oldEp = pos.ep;
    pos.ep = if (f == F_DOUBLE) @intCast((@as(i32, @intCast(from)) + @as(i32, @intCast(to))) >> 1) else -1;
    if (oldEp >= 0) {
        const j = 1041 + @as(usize, @intCast(oldEp & 7));
        a ^= ZA[j];
        bb ^= ZB[j];
    }
    if (pos.ep >= 0) {
        const j = 1041 + @as(usize, @intCast(pos.ep & 7));
        a ^= ZA[j];
        bb ^= ZB[j];
    }

    if (ty == KING) pos.ks[@intCast(col)] = @intCast(to);
    if (ty == PAWN or cap != 0) pos.half = 0 else pos.half += 1;

    pos.stm ^= 1;
    a ^= ZA[1024];
    bb ^= ZB[1024];
    pos.keyA = a;
    pos.keyB = bb;
}

pub fn unmake(pos: *Position, m: i32) void {
    pos.ply -= 1;
    pos.histLen -= 1;
    const k: usize = @intCast(pos.ply * 6);
    const u = &pos.undo;
    const cap = u[k];
    const castle = u[k + 1];
    const ep = u[k + 2];
    const half = u[k + 3];
    const from: usize = mFrom(m);
    const to: usize = mTo(m);
    const f = mFlag(m);
    const b = &pos.b;

    const np = b[to];
    const col = np >> 3;
    const ty = np & 7;
    b[to] = 0;
    b[from] = if (f >= 6) piece(col, PAWN) else np;
    if (f == F_EP) {
        b[@intCast(@as(i32, @intCast(to)) + (if (col == WHITE) @as(i32, 8) else -8))] = piece(col ^ 1, PAWN);
    } else if (cap != 0) {
        b[to] = @intCast(cap);
    }

    if (f == F_OO) {
        b[to + 1] = b[to - 1];
        b[to - 1] = 0;
    } else if (f == F_OOO) {
        b[to - 2] = b[to + 1];
        b[to + 1] = 0;
    }

    if (ty == KING) pos.ks[@intCast(col)] = @intCast(from);

    pos.castle = @intCast(castle);
    pos.ep = @intCast(ep);
    pos.half = half;
    pos.keyA = u[k + 4];
    pos.keyB = u[k + 5];
    pos.stm ^= 1;
}

/// 空着(不走子,只把走子权交出去)。仅空着剪枝用,外面不要调用。
pub fn makeNull(pos: *Position) void {
    const k: usize = @intCast(pos.ply * 6);
    const u = &pos.undo;
    u[k] = 0;
    u[k + 1] = pos.castle;
    u[k + 2] = pos.ep;
    u[k + 3] = pos.half;
    u[k + 4] = pos.keyA;
    u[k + 5] = pos.keyB;
    pos.ply += 1;
    pos.hist[pos.histLen & pos.histMask] = pos.keyA;
    pos.histLen += 1;
    var a = pos.keyA ^ ZA[1024];
    var bb = pos.keyB ^ ZB[1024];
    if (pos.ep >= 0) {
        const j = 1041 + @as(usize, @intCast(pos.ep & 7));
        a ^= ZA[j];
        bb ^= ZB[j];
        pos.ep = -1;
    }
    pos.keyA = a;
    pos.keyB = bb;
    pos.stm ^= 1;
    pos.half += 1;
}

pub fn unmakeNull(pos: *Position) void {
    pos.ply -= 1;
    pos.histLen -= 1;
    const k: usize = @intCast(pos.ply * 6);
    const u = &pos.undo;
    pos.ep = @intCast(u[k + 2]);
    pos.half = u[k + 3];
    pos.keyA = u[k + 4];
    pos.keyB = u[k + 5];
    pos.stm ^= 1;
}

//  ============================================================
// 合法性
// ============================================================
pub fn isLegal(pos: *Position, m: i32) bool {
    const f = mFlag(m);
    if (f == F_OO or f == F_OOO) {
        // 易位要额外检查:起点、经过格、落点都不能被攻击
        const col = pos.stm;
        const k: usize = @intCast(pos.ks[@intCast(col)]);
        const dir: i32 = if (f == F_OO) 1 else -1;
        return !attacked(&pos.b, k, col ^ 1) and !attacked(&pos.b, @intCast(@as(i32, @intCast(k)) + dir), col ^ 1) and !attacked(&pos.b, @intCast(@as(i32, @intCast(k)) + 2 * dir), col ^ 1);
    }
    make(pos, m);
    const ok = !attacked(&pos.b, @intCast(pos.ks[@intCast(pos.stm ^ 1)]), pos.stm);
    unmake(pos, m);
    return ok;
}

/// 生成全部合法走法,压紧写回 out,返回个数
pub fn genLegal(pos: *Position, out: []i32) usize {
    const n = genMoves(pos, out);
    var w: usize = 0;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const m = out[i];
        if (isLegal(pos, m)) {
            out[w] = m;
            w += 1;
        }
    }
    return w;
}

/// 是否还有合法走法(终局判定;找到第一个就返回,不生成全部)
pub fn hasLegalMove(pos: *Position, out: []i32) bool {
    const n = genMoves(pos, out);
    var i: usize = 0;
    while (i < n) : (i += 1) if (isLegal(pos, out[i])) return true;
    return false;
}

//  ---------- 和棋判定 ----------

/// 搜索路径/对局历史里出现过同局面(以半步计数器为上限往回找,隔一步一比对)
pub fn isRepetition(pos: *const Position) bool {
    const n = pos.histLen;
    const ka = pos.keyA;
    if (n == 0) return false;
    const stop = if (n > @as(usize, @intCast(@max(pos.half, 0)))) n - @as(usize, @intCast(@max(pos.half, 0))) else 0;
    if (n < 2) return false;
    var i: i64 = @as(i64, @intCast(n)) - 2;
    while (i >= @as(i64, @intCast(stop))) : (i -= 2) {
        if (pos.histAt(@intCast(i)) == ka) return true;
    }
    return false;
}

/// 对局历史里第三次出现(真·三次重复)
pub fn isThreefold(pos: *const Position) bool {
    const n = pos.histLen;
    const ka = pos.keyA;
    if (n < 2) return false;
    const stop = if (n > @as(usize, @intCast(@max(pos.half, 0)))) n - @as(usize, @intCast(@max(pos.half, 0))) else 0;
    var cnt: i32 = 0;
    var i: i64 = @as(i64, @intCast(n)) - 2;
    while (i >= @as(i64, @intCast(stop))) : (i -= 2) {
        if (pos.histAt(@intCast(i)) == ka) {
            cnt += 1;
            if (cnt >= 2) return true;
        }
    }
    return false;
}

/// 子力不足和棋:无兵无重子,且双方都只有至多一个轻子
pub fn insufficientMaterial(pos: *const Position) bool {
    var minor = [2]i32{ 0, 0 };
    var s: usize = 0;
    while (s < 64) : (s += 1) {
        const p = pos.b[s];
        if (p == 0) continue;
        const ty = p & 7;
        if (ty == KING) continue;
        if (ty == PAWN or ty == ROOK or ty == QUEEN) return false;
        minor[@intCast(p >> 3)] += 1;
    }
    return minor[0] <= 1 and minor[1] <= 1;
}

//  ---------- 走法序列重演 ----------

/// 按 (from<<6|to) 序列重演走法(升变一律升后,与 UI 的"自动升后"一致)。
/// 返回 false 表示序列里有走不出来的着法,此时局面状态不可信。
pub fn replayMoves(pos: *Position, seq: []const i32, buf: []i32) bool {
    for (seq) |line| {
        const from: usize = @intCast(@as(u32, @bitCast(line)) >> 6 & 63);
        const to: usize = @intCast(@as(u32, @bitCast(line)) & 63);
        const n = genMoves(pos, buf);
        var mv: i32 = 0;
        var j: usize = 0;
        while (j < n) : (j += 1) {
            const cnd = buf[j];
            if (mFrom(cnd) != from or mTo(cnd) != to) continue;
            const pr = mPromo(cnd);
            if (pr != 0 and pr != QUEEN) continue; // 多个升变着法时取升后那个
            mv = cnd;
            break;
        }
        if (mv == 0 or !isLegal(pos, mv)) return false;
        make(pos, mv);
    }
    return true;
}

//  ---------- FEN 装载(仅原生 selftest 用;wasm 侧死代码会被剥掉)----------

/// FEN → 局面(selftest 的 6 个 perft 题面用;不实现全部 FEN 语法,够用即可)
pub fn loadFen(fen: []const u8) Position {
    var pos = Position{};
    var it = std.mem.tokenizeScalar(u8, fen, ' ');
    const board = it.next().?;
    var r: usize = 0;
    var c: usize = 0;
    for (board) |ch| {
        if (ch == '/') {
            r += 1;
            c = 0;
            continue;
        }
        if (ch >= '1' and ch <= '8') {
            c += ch - '0';
            continue;
        }
        const lower = std.ascii.toLower(ch);
        const ty: i8 = switch (lower) {
            'p' => PAWN,
            'n' => KNIGHT,
            'b' => BISHOP,
            'r' => ROOK,
            'q' => QUEEN,
            'k' => KING,
            else => unreachable,
        };
        pos.b[r * 8 + c] = piece(if (ch == lower) BLACK else WHITE, ty);
        c += 1;
    }
    const stmTok = it.next().?;
    pos.stm = if (stmTok[0] == 'b') BLACK else WHITE;
    const cast = it.next().?;
    var castle: i8 = 0;
    for (cast) |ch| {
        castle |= switch (ch) {
            'K' => C_WK,
            'Q' => C_WQ,
            'k' => C_BK,
            'q' => C_BQ,
            else => 0,
        };
    }
    pos.castle = castle;
    const eps = it.next() orelse "-";
    pos.ep = -1;
    if (eps.len >= 2 and eps[0] != '-') {
        const file: i32 = @intCast(eps[0] - 'a');
        const rank: i32 = 8 - (eps[1] - '0');
        pos.ep = @intCast(rank * 8 + file);
    }
    pos.half = 0;
    pos.ply = 0;
    pos.histLen = 0;
    var s: usize = 0;
    while (s < 64) : (s += 1) {
        const p = pos.b[s];
        if (p != 0 and (p & 7) == KING) pos.ks[@intCast(p >> 3)] = @intCast(s);
    }
    _ = recomputeKeys(&pos);
    return pos;
}
