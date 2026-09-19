// 二进制开局谱库(zig 通道)。blob 由 tools/gen-book.mjs 从 src/book.js
// (单一事实源:ECO 谱树 + 族名表)生成,布局见该脚本头注释:
//   名字区(u16 count + 每族 u16 len + UTF-8)→ u32 nodeCount → u8 rootKids
//   → 前序节点,每个 6 字节(from, to, w16, fam(255=无名), nKids)。
//
// 设计要点:
//   · **零拷贝零分配**:直接在 blob 字节上按偏移游走,头部名字偏移表首次
//     使用时建一次(静态数组)。blob 本体 @embedFile 进 wasm 数据段。
//   · 前序布局下"找兄弟"要跳子树:skipTree 用递归,深度 = 谱树深度
//     (实测 ≤ 36),栈开销可忽略;整树游走一次的完整性由 selftest 校验。
//   · 语义与 JS 版 book.js 对齐:walk 按线序列(from,to)逐层匹配;
//     pick 按「子树谱线数」加权随机(随机源由调用方播种,对应 JS 的
//     Math.random);名字取**被选中的着法所在节点**的 fam —— 即"这步棋
//     进入了哪个开局族",与 bookResponse 的 name 口径一致。
const std = @import("std");
const rules = @import("rules.zig");

pub const blob = @embedFile("book.bin");

pub const FAM_NONE: u16 = 0xFFFF;

var famOff: [255]u32 = undefined; // 每族名的数据字节偏移(名字区解析一次)
var famLen: [255]u16 = undefined;
var nodesBase: usize = 0;
var rootKidsV: u8 = 0;
var famCountV: u16 = 0;
var inited = false;

inline fn rd16(off: usize) u16 {
    return @as(u16, blob[off]) | (@as(u16, blob[off + 1]) << 8);
}
inline fn rd32(off: usize) u32 {
    return @as(u32, blob[off]) | (@as(u32, blob[off + 1]) << 8) | (@as(u32, blob[off + 2]) << 16) | (@as(u32, blob[off + 3]) << 24);
}

fn init() void {
    if (inited) return;
    var off: usize = 2;
    const n = rd16(0);
    for (0..n) |i| {
        const len = rd16(off);
        famOff[i] = @intCast(off + 2);
        famLen[i] = len;
        off += 2 + len;
    }
    // off 此刻指向 nodeCount(u32),其后是 rootKids,再后是首个节点
    nodesBase = off + 5;
    rootKidsV = blob[off + 4];
    famCountV = n;
    inited = true;
}

pub fn famCount() u16 {
    init();
    return famCountV;
}
pub fn nodeCount() u32 {
    init();
    return rd32(nodesBase - 5);
}
pub fn rootKids() u8 {
    init();
    return rootKidsV;
}

/// 族下标 → 族名(fam ≥ famCount 或 255 → null,对应 JS 的"无名谱着")
pub fn famName(fam: u16) ?[]const u8 {
    init();
    if (fam == 255 or fam >= famCountV) return null;
    const i: usize = fam;
    return blob[famOff[i]..][0..famLen[i]];
}

pub const Node = struct {
    from: u8,
    to: u8,
    w: u16,
    fam: u8, // 255 = 无名
    nKids: u8,
};

pub fn nodeAt(off: usize) Node {
    return .{
        .from = blob[off],
        .to = blob[off + 1],
        .w = rd16(off + 2),
        .fam = blob[off + 4],
        .nKids = blob[off + 5],
    };
}

/// 跳过一个节点(头在 off)的整棵子树,返回子树结束后的偏移
fn skipTree(off: usize, nKids: u8) usize {
    var o = off;
    for (0..nKids) |_| {
        const n = nodeAt(o);
        o = skipTree(o + 6, n.nKids);
    }
    return o;
}

/// 一个节点的孩子区(孩子节点头连续排列,兄弟间靠 skipTree 推进)
pub const Kids = struct {
    start: usize,
    count: u8,
    pub fn empty(self: Kids) bool {
        return self.count == 0;
    }
};

/// 按线序列 (from<<6|to) 从根走到谱内节点,返回其孩子区;
/// 序列任一步不在谱内 → null(JS bookResponse 的"无谱可循")。
pub fn walk(seq: []const i32) ?Kids {
    init();
    var kids = Kids{ .start = nodesBase, .count = rootKidsV };
    for (seq) |line| {
        const u: u32 = @bitCast(line);
        const from: u8 = @truncate(u >> 6);
        const to: u8 = @truncate(u & 63);
        var off = kids.start;
        var found: ?usize = null;
        for (0..kids.count) |_| {
            const n = nodeAt(off);
            if (n.from == from and n.to == to) {
                found = off;
                break;
            }
            off = skipTree(off + 6, n.nKids);
        }
        const f = found orelse return null;
        const n = nodeAt(f);
        kids = .{ .start = f + 6, .count = n.nKids };
    }
    return kids;
}

pub const Cand = struct {
    line: u32, // (from<<6)|to
    w: u16,
    fam: u16, // FAM_NONE = 无名
};

/// 枚举孩子区全部候选(顺序 = blob 内兄弟顺序 = JS Object.entries 顺序)
pub fn candidates(kids: Kids, out: []Cand) usize {
    var off = kids.start;
    for (0..kids.count) |i| {
        const n = nodeAt(off);
        out[i] = .{
            .line = (@as(u32, n.from) << 6) | n.to,
            .w = n.w,
            .fam = if (n.fam == 255) FAM_NONE else n.fam,
        };
        off = skipTree(off + 6, n.nKids);
    }
    return kids.count;
}

pub const Pick = struct {
    from: u8,
    to: u8,
    fam: u16, // FAM_NONE = 无名
};

/// 按「子树谱线数」加权随机抽一个孩子(种子由调用方播种;
/// JS 版是 Math.random 连续做 t -= w,这里是 u32 取模再同法相减,分布等价)
pub fn pick(kids: Kids, seed: u32) ?Pick {
    var sum: u32 = 0;
    var off = kids.start;
    for (0..kids.count) |_| {
        const n = nodeAt(off);
        sum += n.w;
        off = skipTree(off + 6, n.nKids);
    }
    if (sum == 0 or kids.count == 0) return null;
    var prng = rules.Mulberry32{ .s = seed };
    var t: i64 = @intCast(prng.next() % sum);
    off = kids.start;
    for (0..kids.count) |_| {
        const n = nodeAt(off);
        t -= n.w;
        if (t < 0) return .{ .from = n.from, .to = n.to, .fam = if (n.fam == 255) FAM_NONE else n.fam };
        off = skipTree(off + 6, n.nKids);
    }
    // 取模边界兜底(理论到不了):取最后一个孩子
    off = kids.start;
    for (0..kids.count - 1) |_| {
        const n = nodeAt(off);
        off = skipTree(off + 6, n.nKids);
    }
    const last = nodeAt(off);
    return .{ .from = last.from, .to = last.to, .fam = if (last.fam == 255) FAM_NONE else last.fam };
}

/// 结构完整性:根孩子的子树首尾相接拼起来必须恰好耗尽 blob
/// (前序布局串得对不对、生成器与解析器对 6 字节节点的理解一致,一次验完)
pub fn verifyIntegrity() bool {
    init();
    var off = nodesBase;
    for (0..rootKidsV) |_| {
        const n = nodeAt(off);
        off = skipTree(off + 6, n.nKids);
    }
    // 允许尾部 padding(当前生成器不加,留余量)
    return off == blob.len;
}
