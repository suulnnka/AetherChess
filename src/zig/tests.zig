//  单元测试(zig build test):把关键参考值(perft/评估/状态)钉死在常量上 ——
//  值最初从初代 JS 参照实现提取(该实现已移除),漂了说明引擎行为变了。
// 完整的 perft/战术/残局自测在 selftest(zig build selftest)。
const std = @import("std");
const rules = @import("rules.zig");
const eval = @import("eval.zig");

test "起始局面 Zobrist 与 JS 逐位一致(表同源)" {
    var pos = rules.newPos();
    try std.testing.expectEqual(@as(i32, -1584417943), pos.keyA);
    try std.testing.expectEqual(@as(i32, -425065691), pos.keyB);
    // 走 e2e4 之后的增量哈希(JS 现场值)
    var buf: [256]i32 = undefined;
    const n = rules.genMoves(&pos, &buf);
    for (buf[0..n]) |m| {
        if (rules.mFrom(m) == 52 and rules.mTo(m) == 36) {
            rules.make(&pos, m);
            break;
        }
    }
    try std.testing.expectEqual(@as(i32, 795815569), pos.keyA);
}

test "起始局面 perft(1..3)" {
    var pos = rules.newPos();
    var bufs = std.mem.zeroes([4][256]i32);
    try std.testing.expectEqual(@as(u64, 20), perft(&pos, 1, &bufs));
    try std.testing.expectEqual(@as(u64, 400), perft(&pos, 2, &bufs));
    try std.testing.expectEqual(@as(u64, 8902), perft(&pos, 3, &bufs));
}

test "起始局面评估 === 0(与 JS 逐位一致)" {
    var pos = rules.newPos();
    try std.testing.expectEqual(@as(i32, 0), eval.evaluate(&pos));
}

fn perft(p: *rules.Position, depth: i32, bufs: *[4][256]i32) u64 {
    if (depth == 0) return 1;
    const buf = &bufs[@intCast(depth)];
    const n = rules.genMoves(p, buf);
    var c: u64 = 0;
    for (buf[0..n]) |m| {
        if (!rules.isLegal(p, m)) continue;
        if (depth == 1) {
            c += 1;
            continue;
        }
        rules.make(p, m);
        c += perft(p, depth - 1, bufs);
        rules.unmake(p, m);
    }
    return c;
}
