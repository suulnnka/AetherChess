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

inline fn hsq32(t: i32) i32 {
    return (t >> 3) * 4 + @min(t & 7, 7 - (t & 7));
}

fn evalTerms(pos: *const rules.Position) void {
    const b = &pos.b;
    nT = 0;
    nU = 0;
    @memset(&wPawnM, 0);
    @memset(&bPawnM, 0);
    @memset(&wPawnF, 0);
    @memset(&bPawnF, 0);
    @memset(&wAtkRow, 0);
    @memset(&bAtkRow, 0);
    var wCnt = [_]i32{0} ** 7;
    var bCnt = [_]i32{0} ** 7;
    var phase: i32 = 0;
    var wb: i32 = 0;
    var bb: i32 = 0;
    var np: usize = 0;
    var npn: usize = 0;

    var s: usize = 0;
    while (s < 64) : (s += 1) {
        const p = b[s];
        if (p == 0) continue;
        const col = p >> 3;
        const ty = p & 7;
        const t: i32 = if (col == WHITE) @intCast(s) else @as(i32, @intCast(s)) ^ 56;
        const sg: i32 = if (col == WHITE) 1 else -1;
        if (col == WHITE) wCnt[@intCast(ty)] += 1 else bCnt[@intCast(ty)] += 1;
        phase += PHASE_W[@intCast(ty)];
        if (ty == PAWN) {
            const f: usize = s & 7;
            const r: i32 = @intCast(s >> 3);
            if (col == WHITE) {
                wPawnF[f] += 1;
                wPawnM[f] |= @as(i32, 1) << @intCast(r);
                if (r - 1 >= 0) {
                    const bits = (if (f > 0) @as(i32, 1) << @intCast(f - 1) else 0) |
                        (if (f < 7) @as(i32, 1) << @intCast(f + 1) else 0);
                    wAtkRow[@intCast(r - 1)] |= bits;
                }
            } else {
                bPawnF[f] += 1;
                bPawnM[f] |= @as(i32, 1) << @intCast(r);
                if (r + 1 < 8) {
                    const bits = (if (f > 0) @as(i32, 1) << @intCast(f - 1) else 0) |
                        (if (f < 7) @as(i32, 1) << @intCast(f + 1) else 0);
                    bAtkRow[@intCast(r + 1)] |= bits;
                }
            }
            PN_SQ[npn] = @intCast(s);
            PN_COL[npn] = col;
            npn += 1;
            T_IDX[nT] = PST_MG_PAWN + t;
            T_VAL[nT] = sg;
            nT += 1;
            U_IDX[nU] = PST_EG_PAWN + hsq32(t);
            U_VAL[nU] = sg;
            nU += 1;
        } else if (ty == KNIGHT or ty == BISHOP or ty == ROOK or ty == QUEEN) {
            PC_SQ[np] = @intCast(s);
            PC_TY[np] = ty;
            PC_COL[np] = col;
            np += 1;
            const mgBase: i32 = switch (ty) {
                KNIGHT => PST_MG_KNIGHT,
                BISHOP => PST_MG_BISHOP,
                ROOK => PST_MG_ROOK,
                else => PST_MG_QUEEN,
            };
            const egBase: i32 = PST_EG_KNIGHT + @as(i32, ty - KNIGHT) * 32;
            T_IDX[nT] = mgBase + hsq32(t);
            T_VAL[nT] = sg;
            nT += 1;
            U_IDX[nU] = egBase + hsq32(t);
            U_VAL[nU] = sg;
            nU += 1;
            if (ty == BISHOP) {
                if (col == WHITE) wb += 1 else bb += 1;
            }
        } else { // KING
            T_IDX[nT] = PST_MG_KING + t;
            T_VAL[nT] = sg;
            nT += 1;
            U_IDX[nU] = PST_EG_KING + hsq32(t);
            U_VAL[nU] = sg;
            nU += 1;
        }
    }

    // 子力(P..Q,王无子力项)
    var mty: i8 = PAWN;
    while (mty <= QUEEN) : (mty += 1) {
        const d = wCnt[@intCast(mty)] - bCnt[@intCast(mty)];
        if (d != 0) {
            T_IDX[nT] = VAL_MG + (mty - PAWN);
            T_VAL[nT] = d;
            nT += 1;
            U_IDX[nU] = VAL_EG + (mty - PAWN);
            U_VAL[nU] = d;
            nU += 1;
        }
    }

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
        T_IDX[nT] = DOUBLED_MG;
        T_VAL[nT] = bDoub - wDoub;
        nT += 1;
        U_IDX[nU] = DOUBLED_EG;
        U_VAL[nU] = bDoub - wDoub;
        nU += 1;
    }
    if (wIso != bIso) {
        T_IDX[nT] = ISOLATED_MG;
        T_VAL[nT] = bIso - wIso;
        nT += 1;
        U_IDX[nU] = ISOLATED_EG;
        U_VAL[nU] = bIso - wIso;
        nU += 1;
    }

    // 王盾(只在还有中局成分时计入;残局王要出去干活)
    if (phase > 8) {
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
            T_IDX[nT] = SHIELD_MG;
            T_VAL[nT] = bMiss - wMiss;
            nT += 1;
        }
    }

    // 双象
    const pair: i32 = (if (wb >= 2) @as(i32, 1) else 0) - (if (bb >= 2) @as(i32, 1) else 0);
    if (pair != 0) {
        T_IDX[nT] = PAIR_MG;
        T_VAL[nT] = pair;
        nT += 1;
        U_IDX[nU] = PAIR_EG;
        U_VAL[nU] = pair;
        nU += 1;
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
        T_IDX[nT] = PASSED_MG + rank - 2;
        T_VAL[nT] = sg;
        nT += 1;
        U_IDX[nU] = PASSED_EG + rank - 2;
        U_VAL[nU] = sg;
        nU += 1;
    }

    // 机动性 + 王区威胁 融合扫描(单次射线遍历同时做两件事)
    var wAtk = [_]i32{0} ** 4; // 按 攻击方子的类型:马 象 车 后
    var bAtk = [_]i32{0} ** 4;
    if (np > 0) {
        // 两个王的危险区可能重叠(王相距两格),用位标志共存:bit0 = 白王区,bit1 = 黑王区
        @memset(&zoneMark, 0);
        var zc: usize = 0;
        while (zc < 2) : (zc += 1) {
            const ks: usize = @intCast(pos.ks[zc]);
            const kr: i32 = @intCast(ks >> 3);
            const kc: i32 = @intCast(ks & 7);
            const bit: i32 = if (zc == 0) 1 else 2;
            var dr: i32 = -1;
            while (dr <= 1) : (dr += 1) {
                var dc: i32 = -1;
                while (dc <= 1) : (dc += 1) {
                    const r = kr + dr;
                    const c = kc + dc;
                    if (r < 0 or r > 7 or c < 0 or c > 7) continue;
                    zoneMark[@intCast(r * 8 + c)] |= bit;
                }
            }
        }
        i = 0;
        while (i < np) : (i += 1) {
            const s2: usize = @intCast(PC_SQ[i]);
            const ty = PC_TY[i];
            const col = PC_COL[i];
            const r0: i32 = @intCast(s2 >> 3);
            const c0: i32 = @intCast(s2 & 7);
            const atk = if (col == WHITE) &bAtkRow else &wAtkRow;
            const zone: i32 = if (col == WHITE) 2 else 1; // 白子攻黑王区,黑子攻白王区
            var n: i32 = 0;
            var hits = false;
            if (ty == KNIGHT) {
                var k: usize = 0;
                while (k < 16) : (k += 2) {
                    const r = r0 + ND8[k];
                    const c = c0 + ND8[k + 1];
                    if (r < 0 or r > 7 or c < 0 or c > 7) continue;
                    const q: usize = @intCast(r * 8 + c);
                    if (zoneMark[q] & zone != 0) hits = true; // 马的攻击目标不过滤占用(与原版一致)
                    const v = b[q];
                    if (v != 0 and (v >> 3) == col) continue;
                    if (((atk[@intCast(r)] >> @intCast(c)) & 1) == 0) n += 1;
                }
            } else {
                // ⚠ 特征定义的历史缺陷(bug 兼容,见 eval.js fusedPiece 的注释与
                // docs/chess-eval-training-report.md 附录 E):evalTerms 的滑子扫描
                // 以 k<16 索引 8 元素的 DD4/OD4,正交方向全部落空 ⇒ 车的机动性
                // 恒 0、后只数斜线,王区命中同理。全部训练与 A/B 都在这套特征
                // 定义上完成,权重与之绑定 —— 这里必须**原样复刻**:只走 4 条
                // 斜线(象/后),车不产生机动性与王区命中。修复需重生成数据
                // 重拟合后才能放开。
                const diag = ty == BISHOP or ty == QUEEN;
                if (diag) {
                    var k: usize = 0;
                    while (k < 8) : (k += 2) {
                        const dr = DD4[k];
                        const dc = DD4[k + 1];
                        var r = r0 + dr;
                        var c = c0 + dc;
                        while (r >= 0 and r < 8 and c >= 0 and c < 8) {
                            const q: usize = @intCast(r * 8 + c);
                            if (zoneMark[q] & zone != 0) hits = true; // 途经或阻挡格在王区 ⇒ 命中
                            const v = b[q];
                            if (v == 0) {
                                if (((atk[@intCast(r)] >> @intCast(c)) & 1) == 0) n += 1;
                            } else {
                                if ((v >> 3) != col and ((atk[@intCast(r)] >> @intCast(c)) & 1) == 0) n += 1;
                                break;
                            }
                            r += dr;
                            c += dc;
                        }
                    }
                }
            }
            const sg: i32 = if (col == WHITE) 1 else -1;
            if (n != 0) {
                T_IDX[nT] = MOB_MG + (ty - KNIGHT);
                T_VAL[nT] = sg * n;
                nT += 1;
                U_IDX[nU] = MOB_EG + (ty - KNIGHT);
                U_VAL[nU] = sg * n;
                nU += 1;
            }
            if (hits) {
                if (col == WHITE) wAtk[@intCast(ty - KNIGHT)] += 1 else bAtk[@intCast(ty - KNIGHT)] += 1;
            }
        }
        @memset(&zoneMark, 0);
        var k: usize = 0;
        while (k < 4) : (k += 1) {
            if (wAtk[k] != bAtk[k]) {
                T_IDX[nT] = KATK + @as(i32, @intCast(k));
                T_VAL[nT] = wAtk[k] - bAtk[k];
                nT += 1;
            }
        }
        const wTot = @min(wAtk[0] + wAtk[1] + wAtk[2] + wAtk[3], 8);
        const bTot = @min(bAtk[0] + bAtk[1] + bAtk[2] + bAtk[3], 8);
        if (wTot != bTot) {
            T_IDX[nT] = KATK + 4;
            T_VAL[nT] = wTot - bTot;
            nT += 1;
        }
    }

    curPhase = phase;
}

/// 局面分,返回「走子方视角」的厘兵值(与 evaluate() 全量路径逐位一致)。
/// 全整数运算:点积与相位插值都在 i32 里(量级证明见 pi 注释),JS 参照的
/// f64 运算对这些整数恰好精确 ⇒ 结果仍逐位一致。
pub fn evaluate(pos: *const rules.Position) i32 {
    evalTerms(pos);
    var mg: i32 = 0;
    var i: usize = 0;
    while (i < nT) : (i += 1) mg += pi(@intCast(T_IDX[i])) * T_VAL[i];
    var sc: i32 = undefined;
    if (curPhase == PHASE_MAX) {
        sc = mg;
    } else {
        var eg: i32 = 0;
        i = 0;
        while (i < nU) : (i += 1) eg += pi(@intCast(U_IDX[i])) * U_VAL[i];
        sc = if (curPhase == 0) eg else @divTrunc(mg * curPhase + eg * @as(i32, PHASE_MAX - curPhase), PHASE_MAX);
    }
    return if (pos.stm == WHITE) sc else -sc;
}
