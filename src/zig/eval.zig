//  ============================================================
// 评估(zig 通道)—— src/eval.js 全量路径(evalTerms + evaluateFull)的
// 逐句移植。JS 侧的另一条"增量评估"路径(evAttach/evS)在对弈中从未启用
// (见 ai.js 头部注释:JS 棋盘上它反而更慢),故不移植 —— 对弈语义 = 全量路径。
//
// 纪律:**特征累加顺序、f64 运算次序、取整方式与 eval.js 完全一致**,
// 这是 Node 探针能做"评估逐位对拍"的前提(参数是拟合产物,任何一处
// 求和顺序漂移都会让对拍失败)。Zig 不做 fast-math,f64 是 IEEE754 逐位
// 可复现的。
//
// 参数布局(491 个,索引即特征下标)见 eval.js 头注释;数值在 params.zig。
// ============================================================
const rules = @import("rules.zig");
const params = @import("params.zig");

const WHITE = rules.WHITE;
const PAWN = rules.PAWN;
const KNIGHT = rules.KNIGHT;
const BISHOP = rules.BISHOP;
const ROOK = rules.ROOK;
const QUEEN = rules.QUEEN;
const KING = rules.KING;

pub const N_EVAL_PARAMS = params.N;

// 参数表:params.zig 里 i32 无损存储(拟合值全为整数码兵)。特征值与累加
// 也全为整数 —— 量级:单项 |参数×特征| ≤ ~33k,|mg| ≤ ~6.3M,相位插值
// ≤ ~3 亿 < 2^31,余量 7 倍;JS 参照的 f64 点积对这些整数恰好精确,
// 除以 24 后向零截断与 @divTrunc 逐位相等 ⇒ 与 eval.js 仍逐位一致。
pub inline fn pi(base: usize) i32 {
    return params.P_I32[base];
}

pub const VAL_MG = 0;
pub const VAL_EG = 5;
pub const PST_MG_PAWN = 10;
pub const PST_MG_KNIGHT = 74;
pub const PST_MG_BISHOP = 106;
pub const PST_MG_ROOK = 138;
pub const PST_MG_QUEEN = 170;
pub const PST_MG_KING = 202;
pub const PST_EG_PAWN = 266;
pub const PST_EG_KNIGHT = 298;
pub const PST_EG_BISHOP = 330;
pub const PST_EG_ROOK = 362;
pub const PST_EG_QUEEN = 394;
pub const PST_EG_KING = 426;
pub const DOUBLED_MG = 458;
pub const DOUBLED_EG = 459;
pub const ISOLATED_MG = 460;
pub const ISOLATED_EG = 461;
pub const SHIELD_MG = 462;
pub const PAIR_MG = 463;
pub const PAIR_EG = 464;
pub const MOB_MG = 465;
pub const MOB_EG = 469; // 各 4:马 象 车 后
pub const PASSED_MG = 473;
pub const PASSED_EG = 479; // 各 6:相对横线 2..7
pub const KATK = 485; // 485..488 攻击者权重,489 总缩放
pub const TEMPO = 490;

const PHASE_W = [7]i32{ 0, 0, 1, 1, 2, 4, 0 }; // 兵/王相位权重 0:相位只由轻/重子决定
pub const PHASE_MAX = 24;

const ND8 = [16]i8{ 1, 2, 2, 1, -1, 2, -2, 1, 1, -2, 2, -1, -1, -2, -2, -1 };
const DD4 = [8]i8{ 1, 1, 1, -1, -1, 1, -1, -1 };
const OD4 = [8]i8{ 1, 0, -1, 0, 0, 1, 0, -1 };

/// 王盾:该色王所在行往己方底线方向的相邻两行位掩码(行号 r 的兵算"盾")
const SHIELD = blk: {
    var t = [2][8]i32{ [_]i32{0} ** 8, [_]i32{0} ** 8 };
    var r: i32 = 0;
    while (r < 8) : (r += 1) {
        var m: i32 = 0;
        if (r - 1 >= 0) m |= @as(i32, 1) << @intCast(r - 1);
        if (r - 2 >= 0) m |= @as(i32, 1) << @intCast(r - 2);
        t[0][@intCast(r)] = m;
        m = 0;
        if (r + 1 < 8) m |= @as(i32, 1) << @intCast(r + 1);
        if (r + 2 < 8) m |= @as(i32, 1) << @intCast(r + 2);
        t[1][@intCast(r)] = m;
    }
    break :blk t;
};

//  稀疏特征项(模块级缓冲复用,与 eval.js 同)
var T_IDX = [_]i32{0} ** 192; // MG 槽
var T_VAL = [_]i32{0} ** 192;
var U_IDX = [_]i32{0} ** 192; // EG 槽
var U_VAL = [_]i32{0} ** 192;
var nT: usize = 0;
var nU: usize = 0;
pub var curPhase: i32 = 0;

var wPawnM = [_]i32{0} ** 8; // 每列:该色兵所在行的位掩码
var bPawnM = [_]i32{0} ** 8;
var wPawnF = [_]i32{0} ** 8;
var bPawnF = [_]i32{0} ** 8;
var wAtkRow = [_]i32{0} ** 8; // 每行:被该色兵攻击的列位掩码
var bAtkRow = [_]i32{0} ** 8;
var PC_SQ = [_]i32{0} ** 32;
var PC_TY = [_]i32{0} ** 32;
var PC_COL = [_]i32{0} ** 32;
var PN_SQ = [_]i32{0} ** 32;
var PN_COL = [_]i32{0} ** 32;
var zoneMark = [_]i32{0} ** 64;

// [融合变体] 发射点直接累加(MG/EG 槽),稀疏数组与点积循环删除;
// 整数和与顺序无关 ⇒ 与发射+点积两段式逐位一致
var mgAcc: i32 = 0;
var egAcc: i32 = 0;

// ---- 位棋盘实验:机动性/王区换 u64 ----
// 马步掩码(全部目标,不过滤占用 —— 与原版 hits 口径一致)
const KNIGHT_BB: [64]u64 = blk: {
    var t: [64]u64 = [_]u64{0} ** 64;
    var sq: usize = 0;
    while (sq < 64) : (sq += 1) {
        var i: usize = @intCast(rules.N_ATK_LO[sq]);
        const e: usize = @intCast(rules.N_ATK_LO[sq + 1]);
        while (i < e) : (i += 1) t[sq] |= @as(u64, 1) << @as(u6, @intCast(rules.N_ATK[i]));
    }
    break :blk t;
};
// RAY_D[dir][sq]:沿 4 条斜线的位掩码(不含源格,由近及远同 rules 射线表);
// RAY_D_POS:射线是否向高位递增(选 ctz/clz 找最近阻挡格)
const RAY_D: [4][64]u64 = blk: {
    var t: [4][64]u64 = [_][64]u64{[_]u64{0} ** 64} ** 4;
    var sq: usize = 0;
    while (sq < 64) : (sq += 1) {
        var d: usize = 0;
        while (d < 4) : (d += 1) {
            var i: usize = @intCast(rules.DIAG_SEG[sq * 4 + d]);
            const e: usize = @intCast(rules.DIAG_SEG[sq * 4 + d + 1]);
            while (i < e) : (i += 1) t[d][sq] |= @as(u64, 1) << @as(u6, @intCast(rules.DIAG_RAY[i]));
        }
    }
    break :blk t;
};
const RAY_D_POS: [4][64]bool = blk: {
    var t: [4][64]bool = [_][64]bool{[_]bool{false} ** 64} ** 4;
    var sq: usize = 0;
    while (sq < 64) : (sq += 1) {
        var d: usize = 0;
        while (d < 4) : (d += 1) {
            const lo: usize = @intCast(rules.DIAG_SEG[sq * 4 + d]);
            if (rules.DIAG_SEG[sq * 4 + d + 1] > rules.DIAG_SEG[sq * 4 + d])
                t[d][sq] = rules.DIAG_RAY[lo] > @as(i8, @intCast(sq));
        }
    }
    break :blk t;
};
// ---- [增量 v2·第一档] 逐子可分解项的增量维护 ----
// STAT[pc<<6|sq] = 白方视角 (子力+PST),MG/EG 各一张;与位扫描版逐子累加逐位一致
const STAT_MG: [1024]i32 = blk: {
    @setEvalBranchQuota(1000000);
    var t: [1024]i32 = [_]i32{0} ** 1024;
    var pc: usize = 1;
    while (pc < 16) : (pc += 1) {
        const ty = pc & 7;
        if (ty == 0 or ty == 7) continue;
        const col = pc >> 3;
        const sg: i32 = if (col == 0) 1 else -1;
        const mgBase: usize = if (ty == 1) PST_MG_PAWN
            else if (ty == 2) PST_MG_KNIGHT
            else if (ty == 3) PST_MG_BISHOP
            else if (ty == 4) PST_MG_ROOK
            else if (ty == 5) PST_MG_QUEEN
            else PST_MG_KING;
        var sq: usize = 0;
        while (sq < 64) : (sq += 1) {
            const t2: i32 = if (col == 0) @intCast(sq) else @as(i32, @intCast(sq)) ^ 56;
            if (ty == 6) {
                t[(pc << 6) | sq] = sg * pi(PST_MG_KING + @as(usize, @intCast(t2)));
            } else if (ty == 1) {
                t[(pc << 6) | sq] = sg * (pi(VAL_MG) + pi(PST_MG_PAWN + @as(usize, @intCast(t2))));
            } else {
                const hm: i32 = hsq32(t2);
                const egB: usize = if (ty == 2) PST_EG_KNIGHT else if (ty == 3) PST_EG_BISHOP else if (ty == 4) PST_EG_ROOK else PST_EG_QUEEN;
                _ = egB;
                t[(pc << 6) | sq] = sg * (pi(VAL_MG + (ty - 1)) + pi(mgBase + @as(usize, @intCast(if (ty == 1) t2 else hm))));
            }
        }
    }
    break :blk t;
};
const STAT_EG: [1024]i32 = blk: {
    @setEvalBranchQuota(1000000);
    var t: [1024]i32 = [_]i32{0} ** 1024;
    var pc: usize = 1;
    while (pc < 16) : (pc += 1) {
        const ty = pc & 7;
        if (ty == 0 or ty == 7) continue;
        const col = pc >> 3;
        const sg: i32 = if (col == 0) 1 else -1;
        var sq: usize = 0;
        while (sq < 64) : (sq += 1) {
            const t2: i32 = if (col == 0) @intCast(sq) else @as(i32, @intCast(sq)) ^ 56;
            const hm: i32 = hsq32(t2);
            if (ty == 6) {
                t[(pc << 6) | sq] = sg * pi(PST_EG_KING + @as(usize, @intCast(hm)));
            } else if (ty == 1) {
                t[(pc << 6) | sq] = sg * (pi(VAL_EG) + pi(PST_EG_PAWN + @as(usize, @intCast(hm))));
            } else {
                t[(pc << 6) | sq] = sg * (pi(VAL_EG + (ty - 1)) + pi(PST_EG_KNIGHT + @as(usize, @intCast((ty - 2) * 32 + hm))));
            }
        }
    }
    break :blk t;
};
pub var incMG: i32 = 0;
pub var incEG: i32 = 0;
pub var incPhase: i32 = 0;
pub var incWB: i32 = 0;
pub var incBB: i32 = 0;
const INC_CAP = 600;
var snapMG: [INC_CAP]i32 = undefined;
var snapEG: [INC_CAP]i32 = undefined;
var snapPH: [INC_CAP]i32 = undefined;
var snapWB: [INC_CAP]i32 = undefined;
var snapBB: [INC_CAP]i32 = undefined;
var snapTop: usize = 0;
var snapPly: [INC_CAP]i32 = undefined;

/// 全量重建(recomputeKeys 路径调用)
pub fn incRebuild(pos: *const rules.Position) void {
    var mg2: i32 = 0;
    var eg2: i32 = 0;
    var ph: i32 = 0;
    var wb2: i32 = 0;
    var bb2: i32 = 0;
    var pc: usize = 1;
    while (pc < 16) : (pc += 1) {
        const ty = pc & 7;
        if (ty == 0 or ty == 7) continue;
        var set = pos.pcBB[pc];
        while (set != 0) {
            const sq = @ctz(set);
            set &= set - 1;
            mg2 += STAT_MG[(pc << 6) | sq];
            eg2 += STAT_EG[(pc << 6) | sq];
            ph += PHASE_W[ty];
            if (ty == BISHOP) {
                if (pc >> 3 == 0) wb2 += 1 else bb2 += 1;
            }
        }
    }
    incMG = mg2;
    incEG = eg2;
    incPhase = ph;
    incWB = wb2;
    incBB = bb2;
    snapTop = 0;
}

/// make 尾调用:按本步事件差分(与 rules.make 的 BB XOR 同一组事件)
pub fn incAfterMake(pos: *const rules.Position, m: i32) void {
    if (snapTop >= INC_CAP) {
        incRebuild(pos);
        return;
    }
    snapPly[snapTop] = pos.ply;
    snapMG[snapTop] = incMG;
    snapEG[snapTop] = incEG;
    snapPH[snapTop] = incPhase;
    snapWB[snapTop] = incWB;
    snapBB[snapTop] = incBB;
    snapTop += 1;
    const from: usize = rules.mFrom(m);
    const to: usize = rules.mTo(m);
    const f = rules.mFlag(m);
    const cap = rules.mCap(m);
    const pcPost = pos.b[to];
    const col = pcPost >> 3;
    const tyPre: i32 = if (f >= 6) PAWN else pcPost & 7;
    const pcPre = (col << 3) | tyPre;
    incMG += STAT_MG[(@as(usize, @intCast(pcPost)) << 6) | to] - STAT_MG[(@as(usize, @intCast(pcPre)) << 6) | from];
    incEG += STAT_EG[(@as(usize, @intCast(pcPost)) << 6) | to] - STAT_EG[(@as(usize, @intCast(pcPre)) << 6) | from];
    incPhase += PHASE_W[@intCast(pcPost & 7)] - PHASE_W[@intCast(tyPre)];
    if (tyPre == BISHOP) {
        if (col == WHITE) incWB -= 1 else incBB -= 1;
    }
    if ((pcPost & 7) == BISHOP) {
        if (col == WHITE) incWB += 1 else incBB += 1;
    }
    if (cap != 0) {
        const cs2: usize = if (f == 5)
            @intCast(@as(i32, @intCast(to)) + (if (col == WHITE) @as(i32, 8) else @as(i32, -8)))
        else
            to;
        incMG -= STAT_MG[(@as(usize, @intCast(cap)) << 6) | cs2];
        incEG -= STAT_EG[(@as(usize, @intCast(cap)) << 6) | cs2];
        incPhase -= PHASE_W[@intCast(cap & 7)];
        if ((cap & 7) == BISHOP) {
            if ((cap >> 3) == WHITE) incWB -= 1 else incBB -= 1;
        }
    }
    if (f == 2 or f == 3) {
        const rf: usize = if (f == 2) to + 1 else to - 2;
        const rt: usize = if (f == 2) to - 1 else to + 1;
        const rk = pos.b[rt];
        incMG += STAT_MG[(@as(usize, @intCast(rk)) << 6) | rt] - STAT_MG[(@as(usize, @intCast(rk)) << 6) | rf];
        incEG += STAT_EG[(@as(usize, @intCast(rk)) << 6) | rt] - STAT_EG[(@as(usize, @intCast(rk)) << 6) | rf];
    }
}

/// unmake 头调用:弹快照(ply 校验,失配自愈重建)
pub fn incBeforeUnmake(pos: *const rules.Position) void {
    if (snapTop > 0 and snapPly[snapTop - 1] == pos.ply) {
        snapTop -= 1;
        incMG = snapMG[snapTop];
        incEG = snapEG[snapTop];
        incPhase = snapPH[snapTop];
        incWB = snapWB[snapTop];
        incBB = snapBB[snapTop];
    } else {
        incRebuild(pos);
    }
}
pub fn incPushNull(pos: *const rules.Position) void {
    if (snapTop >= INC_CAP) {
        return;
    }
    snapPly[snapTop] = pos.ply;
    snapMG[snapTop] = incMG;
    snapEG[snapTop] = incEG;
    snapPH[snapTop] = incPhase;
    snapWB[snapTop] = incWB;
    snapBB[snapTop] = incBB;
    snapTop += 1;
}

// 棋子集直接用 pos.pcBB / pos.occ(引擎增量维护)

inline fn hsq32(t: i32) i32 {
    return (t >> 3) * 4 + @min(t & 7, 7 - (t & 7));
}

fn evalTerms(pos: *const rules.Position) void {
    nT = 0;
    nU = 0;
    mgAcc = incMG;
    egAcc = incEG;
    @memset(&wPawnM, 0);
    @memset(&bPawnM, 0);
    @memset(&wPawnF, 0);
    @memset(&bPawnF, 0);
    @memset(&wAtkRow, 0);
    @memset(&bAtkRow, 0);
    var np: usize = 0;
    var npn: usize = 0;

    // 位扫描遍历(pcBB,引擎增量维护;只碰有子的格,整数和与顺序无关)
    {
        var col: usize = 0;
        while (col < 2) : (col += 1) {
            var ty: usize = 1;
            while (ty <= 6) : (ty += 1) {
                var set = pos.pcBB[(col << 3) | ty];
                while (set != 0) {
                    const sq2: usize = @ctz(set);
                    set &= set - 1;
                    if (ty == PAWN) {
                        const f2: usize = sq2 & 7;
                        const r2: i32 = @intCast(sq2 >> 3);
                        if (col == 0) {
                            wPawnF[f2] += 1;
                            wPawnM[f2] |= @as(i32, 1) << @intCast(r2);
                        } else {
                            bPawnF[f2] += 1;
                            bPawnM[f2] |= @as(i32, 1) << @intCast(r2);
                        }
                        PN_SQ[npn] = @intCast(sq2);
                        PN_COL[npn] = @intCast(col);
                        npn += 1;
                    } else if (ty != KING) {
                        PC_SQ[np] = @intCast(sq2);
                        PC_TY[np] = @intCast(ty);
                        PC_COL[np] = @intCast(col);
                        np += 1;
                    }
                }
            }
        }
    }

    // 子力:已并入增量维护(STAT 含 VAL),材料差值段删除

    // 兵结构:叠兵 / 孤立兵(特征方向 = 敌方缺陷 − 己方缺陷,权重为正即罚分幅值)
    var wDoub: i32 = 0;
    var bDoub: i32 = 0;
    var wIso: i32 = 0;
    var bIso: i32 = 0;
    var f: usize = 0;
    while (f < 8) : (f += 1) {
        const wf = wPawnF[f];
        const bf = bPawnF[f];
        if (wf > 1) wDoub += wf - 1;
        if (bf > 1) bDoub += bf - 1;
        const wl: i32 = if (f == 0) 0 else wPawnF[f - 1];
        const wr: i32 = if (f == 7) 0 else wPawnF[f + 1];
        if (wf != 0 and wl == 0 and wr == 0) wIso += wf;
        const bl: i32 = if (f == 0) 0 else bPawnF[f - 1];
        const br: i32 = if (f == 7) 0 else bPawnF[f + 1];
        if (bf != 0 and bl == 0 and br == 0) bIso += bf;
    }
    if (wDoub != bDoub) {
        mgAcc += pi(@intCast(DOUBLED_MG)) * (bDoub - wDoub);
        egAcc += pi(@intCast(DOUBLED_EG)) * (bDoub - wDoub);
    }
    if (wIso != bIso) {
        mgAcc += pi(@intCast(ISOLATED_MG)) * (bIso - wIso);
        egAcc += pi(@intCast(ISOLATED_EG)) * (bIso - wIso);
    }

    // 王盾(只在还有中局成分时计入;残局王要出去干活)
    if (incPhase > 8) {
        var wMiss: i32 = 0;
        var bMiss: i32 = 0;
        var col: usize = 0;
        while (col < 2) : (col += 1) {
            const ks: usize = @intCast(pos.ks[col]);
            const kr: usize = ks >> 3;
            const kc: i32 = @intCast(ks & 7);
            const sm = SHIELD[col][kr];
            if (sm == 0) continue;
            const mask = if (col == 0) &wPawnM else &bPawnM;
            var miss: i32 = 0;
            var df: i32 = -1;
            while (df <= 1) : (df += 1) {
                const fi = kc + df;
                if (fi < 0 or fi > 7) continue;
                if ((mask[@intCast(fi)] & sm) == 0) miss += 1;
            }
            if (col == 0) wMiss = miss else bMiss = miss;
        }
        if (wMiss != bMiss) {
            mgAcc += pi(@intCast(SHIELD_MG)) * (bMiss - wMiss);
        }
    }

    // 双象
    const pair: i32 = (if (incWB >= 2) @as(i32, 1) else 0) - (if (incBB >= 2) @as(i32, 1) else 0);
    if (pair != 0) {
        mgAcc += pi(@intCast(PAIR_MG)) * (pair);
        egAcc += pi(@intCast(PAIR_EG)) * (pair);
    }

    // 通路兵:前方三列(含本列)无敌兵 ⇒ 按相对横线计(白兵横线 = 8−r,黑兵 = r+1)
    var i: usize = 0;
    while (i < npn) : (i += 1) {
        const s2: usize = @intCast(PN_SQ[i]);
        const col = PN_COL[i];
        const r: i32 = @intCast(s2 >> 3);
        const c: i32 = @intCast(s2 & 7);
        var passed = true;
        if (col == WHITE) {
            const ahead = (@as(i32, 1) << @intCast(r)) - 1; // 行 0..r−1
            var f2: i32 = c - 1;
            while (f2 <= c + 1) : (f2 += 1) {
                if (!passed) break;
                if (f2 < 0 or f2 > 7) continue;
                if (bPawnM[@intCast(f2)] & ahead != 0) passed = false;
            }
        } else {
            const ahead = ~((@as(i32, 1) << @intCast(r + 1)) - 1); // 行 r+1..7
            var f2: i32 = c - 1;
            while (f2 <= c + 1) : (f2 += 1) {
                if (!passed) break;
                if (f2 < 0 or f2 > 7) continue;
                if (wPawnM[@intCast(f2)] & ahead != 0) passed = false;
            }
        }
        if (!passed) continue;
        const rank: i32 = if (col == WHITE) 8 - r else r + 1;
        if (rank < 2 or rank > 7) continue; // 1/8 横线不可达
        const sg: i32 = if (col == WHITE) 1 else -1;
        mgAcc += pi(@intCast(PASSED_MG + rank - 2)) * (sg);
        egAcc += pi(@intCast(PASSED_EG + rank - 2)) * (sg);
    }

    // 机动性 + 王区威胁(位棋盘版:攻击集一次算出,计数走 popcount;
    // 口径与射线版逐位一致 —— 马目标不过滤占用算 hits、滑子射线到第一阻挡格
    // 含阻挡格、车恒 0、后只斜线)
    var wAtk = [_]i32{0} ** 4;
    var bAtk = [_]i32{0} ** 4;
    if (np > 0) {
        const FILE_A: u64 = 0x0101010101010101;
        const FILE_H: u64 = 0x8080808080808080;
        // 敌兵攻击集:白兵向低行(row-1)咬,sq-9/sq-7;黑兵反之
        const wPawnAtkBB = ((pos.pcBB[1] & ~FILE_A) >> 9) | ((pos.pcBB[1] & ~FILE_H) >> 7);
        const bPawnAtkBB = ((pos.pcBB[9] & ~FILE_A) << 7) | ((pos.pcBB[9] & ~FILE_H) << 9);
        // 两王危险区(含王格,与原 zoneMark 同集)
        var zoneW: u64 = 0;
        var zoneB: u64 = 0;
        {
            var zc: usize = 0;
            while (zc < 2) : (zc += 1) {
                const ks: usize = @intCast(pos.ks[zc]);
                const kr: i32 = @intCast(ks >> 3);
                const kc: i32 = @intCast(ks & 7);
                var dr: i32 = -1;
                while (dr <= 1) : (dr += 1) {
                    var dc: i32 = -1;
                    while (dc <= 1) : (dc += 1) {
                        const r2 = kr + dr;
                        const c2 = kc + dc;
                        if (r2 < 0 or r2 > 7 or c2 < 0 or c2 > 7) continue;
                        const bit = @as(u64, 1) << @as(u6, @intCast(r2 * 8 + c2));
                        if (zc == 0) zoneW |= bit else zoneB |= bit;
                    }
                }
            }
        }
        const occ = pos.occ[0] | pos.occ[1];
        var piece_i: usize = 0;
        while (piece_i < np) : (piece_i += 1) {
            const sq2: usize = @intCast(PC_SQ[piece_i]);
            const ty = PC_TY[piece_i];
            const col = PC_COL[piece_i];
            const own = if (col == WHITE) pos.occ[0] else pos.occ[1];
            const pawnAtk = if (col == WHITE) bPawnAtkBB else wPawnAtkBB;
            const zone = if (col == WHITE) zoneB else zoneW;
            var n: i32 = 0;
            var hits = false;
            var atkBB: u64 = 0;
            if (ty == KNIGHT) {
                atkBB = KNIGHT_BB[sq2];
                hits = (atkBB & zone) != 0;
                n = @intCast(@popCount(atkBB & ~own & ~pawnAtk));
            } else if (ty == BISHOP or ty == QUEEN) {
                var d2: usize = 0;
                while (d2 < 4) : (d2 += 1) {
                    const ray = RAY_D[d2][sq2];
                    const blockers = ray & occ;
                    if (blockers == 0) {
                        atkBB |= ray;
                    } else {
                        const first: usize = if (RAY_D_POS[d2][sq2])
                            @as(usize, @ctz(blockers))
                        else
                            @as(usize, 63) - @as(usize, @clz(blockers));
                        atkBB |= ray ^ RAY_D[d2][first];
                    }
                }
                hits = (atkBB & zone) != 0;
                n = @intCast(@popCount(atkBB & ~own & ~pawnAtk));
            }
            const sg: i32 = if (col == WHITE) 1 else -1;
            if (n != 0) {
                mgAcc += pi(@intCast(MOB_MG + (ty - KNIGHT))) * (sg * n);
                egAcc += pi(@intCast(MOB_EG + (ty - KNIGHT))) * (sg * n);
            }
            if (hits) {
                if (col == WHITE) wAtk[@intCast(ty - KNIGHT)] += 1 else bAtk[@intCast(ty - KNIGHT)] += 1;
            }
        }
        var k: usize = 0;
        while (k < 4) : (k += 1) {
            if (wAtk[k] != bAtk[k]) {
                mgAcc += pi(@intCast(KATK + @as(i32, @intCast(k)))) * (wAtk[k] - bAtk[k]);
            }
        }
        const wTot = @min(wAtk[0] + wAtk[1] + wAtk[2] + wAtk[3], 8);
        const bTot = @min(bAtk[0] + bAtk[1] + bAtk[2] + bAtk[3], 8);
        if (wTot != bTot) {
            mgAcc += pi(@intCast(KATK + 4)) * (wTot - bTot);
        }
    }
    curPhase = incPhase;
}

/// 局面分,返回「走子方视角」的厘兵值(与 evaluate() 全量路径逐位一致)。
/// 全整数运算:点积与相位插值都在 i32 里(量级证明见 pi 注释),JS 参照的
/// f64 运算对这些整数恰好精确 ⇒ 结果仍逐位一致。
pub fn evaluate(pos: *const rules.Position) i32 {
    evalTerms(pos);
    var sc: i32 = undefined;
    if (curPhase == PHASE_MAX) {
        sc = mgAcc;
    } else {
        sc = if (curPhase == 0) egAcc else @divTrunc(mgAcc * curPhase + egAcc * @as(i32, PHASE_MAX - curPhase), PHASE_MAX);
    }
    return if (pos.stm == WHITE) sc else -sc;
}
