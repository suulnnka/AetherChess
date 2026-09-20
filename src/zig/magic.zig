// ============================================================
// 运行时生成的 magic 攻击表(实验):表住线性内存,文件零字节;
// 首次调用 genMoves 时惰性初始化(搜乘数约几十毫秒)。
// ============================================================
const rules = @import("rules.zig");

fn splitmix64(state: *u64) u64 {
    state.* +%= 0x9E3779B97F4A7C15;
    var z = state.*;
    z = (z ^ (z >> 30)) *% 0xBF58476D1CE4E5B9;
    z = (z ^ (z >> 27)) *% 0x94D049BB133111EB;
    return z ^ (z >> 31);
}

// 射线掩码(不含源格)与相关占位掩码(去掉各方向最后一格)
const DIRS_DIAG = [4][2]i8{ .{ 1, 1 }, .{ 1, -1 }, .{ -1, 1 }, .{ -1, -1 } };
const DIRS_ORTH = [4][2]i8{ .{ 1, 0 }, .{ -1, 0 }, .{ 0, 1 }, .{ 0, -1 } };

fn rayMaskOf(dirs: [4][2]i8, sq: usize) u64 {
    var m: u64 = 0;
    for (dirs) |d| {
        var r: i32 = @as(i32, @intCast(sq >> 3)) + d[0];
        var c: i32 = @as(i32, @intCast(sq & 7)) + d[1];
        while (r >= 0 and r < 8 and c >= 0 and c < 8) {
            m |= @as(u64, 1) << @as(u6, @intCast(r * 8 + c));
            r += d[0];
            c += d[1];
        }
    }
    return m;
}

fn relevantOf(dirs: [4][2]i8, sq: usize) u64 {
    var m: u64 = 0;
    for (dirs) |d| {
        var r: i32 = @as(i32, @intCast(sq >> 3)) + d[0];
        var c: i32 = @as(i32, @intCast(sq & 7)) + d[1];
        while (true) {
            const nr = r + d[0];
            const nc = c + d[1];
            if (nr < 0 or nr > 7 or nc < 0 or nc > 7) break; // 边缘格不算占位
            m |= @as(u64, 1) << @as(u6, @intCast(r * 8 + c));
            r = nr;
            c = nc;
        }
    }
    return m;
}

const RAYS_D: [64]u64 = blk: {
    @setEvalBranchQuota(1000000);
    var t: [64]u64 = [_]u64{0} ** 64;
    var s: usize = 0;
    while (s < 64) : (s += 1) t[s] = rayMaskOf(DIRS_DIAG, s);
    break :blk t;
};
const RAYS_O: [64]u64 = blk: {
    @setEvalBranchQuota(1000000);
    var t: [64]u64 = [_]u64{0} ** 64;
    var s: usize = 0;
    while (s < 64) : (s += 1) t[s] = rayMaskOf(DIRS_ORTH, s);
    break :blk t;
};
const REL_D: [64]u64 = blk: {
    @setEvalBranchQuota(1000000);
    var t: [64]u64 = [_]u64{0} ** 64;
    var s: usize = 0;
    while (s < 64) : (s += 1) t[s] = relevantOf(DIRS_DIAG, s);
    break :blk t;
};
const REL_O: [64]u64 = blk: {
    @setEvalBranchQuota(1000000);
    var t: [64]u64 = [_]u64{0} ** 64;
    var s: usize = 0;
    while (s < 64) : (s += 1) t[s] = relevantOf(DIRS_ORTH, s);
    break :blk t;
};
pub const KNIGHT_BB: [64]u64 = blk: {
    @setEvalBranchQuota(1000000);
    var t: [64]u64 = [_]u64{0} ** 64;
    var s: usize = 0;
    while (s < 64) : (s += 1) {
        var i: usize = @intCast(rules.N_ATK_LO[s]);
        const e: usize = @intCast(rules.N_ATK_LO[s + 1]);
        while (i < e) : (i += 1) t[s] |= @as(u64, 1) << @as(u6, @intCast(rules.N_ATK[i]));
    }
    break :blk t;
};
pub const KING_BB: [64]u64 = blk: {
    @setEvalBranchQuota(1000000);
    var t: [64]u64 = [_]u64{0} ** 64;
    var s: usize = 0;
    while (s < 64) : (s += 1) {
        const r: i32 = @intCast(s >> 3);
        const c: i32 = @intCast(s & 7);
        var dr: i32 = -1;
        while (dr <= 1) : (dr += 1) {
            var dc: i32 = -1;
            while (dc <= 1) : (dc += 1) {
                if (dr == 0 and dc == 0) continue;
                const r2 = r + dr;
                const c2 = c + dc;
                if (r2 < 0 or r2 > 7 or c2 < 0 or c2 > 7) continue;
                t[s] |= @as(u64, 1) << @as(u6, @intCast(r2 * 8 + c2));
            }
        }
    }
    break :blk t;
};

// 运行时状态(线性内存,不占文件)
const ROOK_N = blk: {
    @setEvalBranchQuota(1000000);
    var n: usize = 0;
    var s: usize = 0;
    while (s < 64) : (s += 1) n += @as(usize, 1) << @popCount(REL_O[s]);
    break :blk n;
};
const BISH_N = blk: {
    @setEvalBranchQuota(1000000);
    var n: usize = 0;
    var s: usize = 0;
    while (s < 64) : (s += 1) n += @as(usize, 1) << @popCount(REL_D[s]);
    break :blk n;
};
var rookTable: [ROOK_N]u64 = undefined;
var bishTable: [BISH_N]u64 = undefined;
var rookOff: [64]usize = undefined;
var bishOff: [64]usize = undefined;
var rookMagic: [64]u64 = undefined;
var bishMagic: [64]u64 = undefined;
var rookShift: [64]u6 = undefined;
var bishShift: [64]u6 = undefined;
var ready = false;
var rngState: u64 = 0x1234567890ABCDEF;

fn sparseRand() u64 {
    const a = splitmix64(&rngState);
    const b2 = splitmix64(&rngState);
    const c = splitmix64(&rngState);
    return a & b2 & c;
}

fn attacksOn(dirs: [4][2]i8, sq: usize, occ: u64) u64 {
    var atk: u64 = 0;
    for (dirs) |d| {
        var r: i32 = @as(i32, @intCast(sq >> 3)) + d[0];
        var c: i32 = @as(i32, @intCast(sq & 7)) + d[1];
        while (r >= 0 and r < 8 and c >= 0 and c < 8) {
            const q: u6 = @intCast(r * 8 + c);
            atk |= @as(u64, 1) << q;
            if ((occ >> q) & 1 != 0) break;
            r += d[0];
            c += d[1];
        }
    }
    return atk;
}

pub fn init() void {
    if (ready) return;
    ready = true;
    var roff: usize = 0;
    var boff: usize = 0;
    var sq: usize = 0;
    while (sq < 64) : (sq += 1) {
        rookOff[sq] = roff;
        bishOff[sq] = boff;
        rookShift[sq] = @intCast(64 - @as(u32, @intCast(@popCount(REL_O[sq]))));
        bishShift[sq] = @intCast(64 - @as(u32, @intCast(@popCount(REL_D[sq]))));
        rookMagic[sq] = findMagic(DIRS_ORTH, REL_O[sq], sq, &rookTable, roff);
        bishMagic[sq] = findMagic(DIRS_DIAG, REL_D[sq], sq, &bishTable, boff);
        roff += @as(usize, @intCast(1)) << @intCast(@popCount(REL_O[sq]));
        boff += @as(usize, @intCast(1)) << @intCast(@popCount(REL_D[sq]));
    }
}

/// 真正的搜乘数(带冲突检测的重试循环)
fn findMagic(dirs: [4][2]i8, rel: u64, sq: usize, table: []u64, offset: usize) u64 {
    const bits: u32 = @intCast(@popCount(rel));
    const shift: u6 = @intCast(64 - @as(u32, bits));
    const nsub: usize = @as(usize, 1) << @intCast(bits);
    var subs: [4096]u64 = undefined;
    var atks: [4096]u64 = undefined;
    {
        var sub = rel;
        var i: usize = 0;
        while (true) {
            subs[i] = sub;
            atks[i] = attacksOn(dirs, sq, sub);
            i += 1;
            if (sub == 0) break;
            sub = (sub - 1) & rel;
        }
    }
    while (true) {
        const m = sparseRand();
        if (@popCount((m *% rel) & 0xFF00000000000000) < 6) continue;
        // 冲突检测:每个子集查表必须命中自己的攻击
        var used: [4096]u64 = undefined;
        var seen: [4096]bool = undefined;
        @memset(seen[0..nsub], false);
        var ok = true;
        var j: usize = 0;
        while (j < nsub) : (j += 1) {
            const idx: usize = @intCast((subs[j] *% m) >> @as(u6, @intCast(shift)));
            if (seen[idx]) {
                if (used[idx] != atks[j]) {
                    ok = false;
                    break;
                }
            } else {
                seen[idx] = true;
                used[idx] = atks[j];
                table[offset + idx] = atks[j];
            }
        }
        if (ok) return m;
    }
}

pub inline fn ensure() void {
    if (!ready) init();
}

pub inline fn rookAtk(sq: usize, occ: u64) u64 {
    const idx: usize = @intCast(((occ & REL_O[sq]) *% rookMagic[sq]) >> rookShift[sq]);
    return rookTable[rookOff[sq] + idx];
}
pub inline fn bishAtk(sq: usize, occ: u64) u64 {
    const idx: usize = @intCast(((occ & REL_D[sq]) *% bishMagic[sq]) >> bishShift[sq]);
    return bishTable[bishOff[sq] + idx];
}
