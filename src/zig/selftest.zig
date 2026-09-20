// 原生自测 / 基准。**不参与 wasm** —— 让"棋规对不对、战术解不解得出、
// 每秒能搜多少节点"这三件事在命令行上问清楚。跨语言对拍(评估/搜索
// 与 JS 版逐位一致)在 Node 侧:tools/probe-wasm.mjs。
//
// Zig 0.16 要点(与 AetherOthello 的 selftest 一致):
//   · 入口 pub fn main(init: std.process.Init),参数从 init.minimal.args 拿;
//   · 计时 std.Io.Timestamp.now(io, .awake)。
//
// 子命令:
//   selftest              全部自测(perft/不变量/边角/战术/残局)+ 基准
//   selftest bench [节点] 只跑基准
const std = @import("std");
const rules = @import("rules.zig");
const eval = @import("eval.zig");
const search = @import("search.zig");
const book = @import("book.zig");

var gio: std.Io = undefined;
var failed: bool = false;

fn say(comptime fmt: []const u8, args: anytype) void {
    std.debug.print(fmt ++ "\n", args);
}

fn check(ok: bool, comptime what: []const u8, args: anytype) void {
    std.debug.print("  {s} ", .{if (ok) "✓" else "✗"});
    std.debug.print(what ++ "\n", args);
    if (!ok) failed = true;
}

fn nowNs() u64 {
    return @intCast(std.Io.Timestamp.now(gio, .awake).nanoseconds);
}

//  ---------- 基础工具 ----------
const FILES = "abcdefgh";

fn sqName(sq: usize) [2]u8 {
    return .{ FILES[sq & 7], @intCast('0' + (8 - (sq >> 3))) };
}

fn san(m: i32) [4]u8 {
    const f = sqName(rules.mFrom(m));
    const t = sqName(rules.mTo(m));
    return .{ f[0], f[1], t[0], t[1] };
}

/// FEN → 线格号 e2e4 → (52, 36)
fn lineSquares(s: []const u8) struct { from: usize, to: usize } {
    return .{
        .from = sqOf(s[0..2]),
        .to = sqOf(s[2..4]),
    };
}
fn sqOf(s: []const u8) usize {
    const file: usize = s[0] - 'a';
    const rank: usize = 8 - (s[1] - '0');
    return rank * 8 + file;
}

fn thinkOf(p: *rules.Position, nodes: u64) search.Result {
    return search.searchBest(p, .{ .nodes = nodes, .depth = 24 });
}

/// 这步走完是不是把对手将死了 —— 自我验证,不依赖人手核对唯一解
fn isMatingMove(p: *rules.Position, m: i32) bool {
    var buf: [256]i32 = undefined;
    rules.make(p, m);
    const r = rules.inCheck(p) and !rules.hasLegalMove(p, &buf);
    rules.unmake(p, m);
    return r;
}

//  ---------- perft(与 test/engine-test.mjs 同一套标准值)----------
const PERFT = [_]struct { name: []const u8, fen: []const u8, expect: []const u64 }{
    .{ .name = "初始局面", .fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", .expect = &.{ 20, 400, 8902, 197281, 4865609 } },
    .{ .name = "Kiwipete", .fen = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", .expect = &.{ 48, 2039, 97862, 4085603 } },
    .{ .name = "局面3(兵残局)", .fen = "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", .expect = &.{ 14, 191, 2812, 43238, 674624 } },
    .{ .name = "局面4(升变/易位)", .fen = "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", .expect = &.{ 6, 264, 9467, 422333 } },
    .{ .name = "局面5", .fen = "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", .expect = &.{ 44, 1486, 62379, 2103487 } },
    .{ .name = "局面6", .fen = "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", .expect = &.{ 46, 2079, 89890 } },
};

var pbufs = std.mem.zeroes([8][256]i32);

fn perft(p: *rules.Position, depth: i32) u64 {
    if (depth == 0) return 1;
    const buf = &pbufs[@intCast(depth)];
    const n = rules.genMoves(p, buf);
    var c: u64 = 0;
    for (buf[0..n]) |m| {
        if (!rules.isLegal(p, m)) continue;
        if (depth == 1) {
            c += 1;
            continue;
        }
        rules.make(p, m);
        c += perft(p, depth - 1);
        rules.unmake(p, m);
    }
    return c;
}

fn runPerft() void {
    say("\n== perft(节点数必须逐层精确匹配标准值)", .{});
    for (PERFT) |tc| {
        var pos = rules.loadFen(tc.fen);
        const t0 = nowNs();
        for (tc.expect, 0..) |want, di| {
            const d: i32 = @intCast(di + 1);
            const got = perft(&pos, d);
            check(got == want, "{s} perft({d}):{d}(期望 {d})", .{ tc.name, d, got, want });
        }
        say("  {s} 深度 1..{d} 全对(末层 {d} ms)", .{ tc.name, tc.expect.len, (nowNs() - t0) / 1_000_000 });
    }
}

//  ---------- make/unmake 还原性 + Zobrist 增量一致性 ----------
var rngState: u32 = 0xabcdef;

fn rnd() f64 {
    rngState = (rngState *% 1103515245 +% 12345) & 0x7fffffff;
    return @as(f64, @floatFromInt(rngState)) / @as(f64, @floatFromInt(@as(u32, 0x7fffffff)));
}

fn sameState(a: *const rules.Position, b: *const rules.Position) bool {
    if (a.stm != b.stm or a.castle != b.castle or a.ep != b.ep or a.half != b.half) return false;
    if (a.keyA != b.keyA or a.keyB != b.keyB) return false;
    if (a.ks[0] != b.ks[0] or a.ks[1] != b.ks[1] or a.ply != b.ply) return false;
    if (a.histLen != b.histLen) return false;
    return std.mem.eql(i8, &a.b, &b.b);
}

fn runInvariants() void {
    say("\n== make/unmake 还原性 + Zobrist 增量一致性", .{});
    var buf: [256]i32 = undefined;
    var checks: u32 = 0;
    var hashOk: u32 = 0;
    var attempted: u32 = 0;
    var restored: u32 = 0;
    for (PERFT) |tc| {
        var pos = rules.loadFen(tc.fen);
        var stack: [128]i32 = undefined;
        var snaps: [129]rules.Position = undefined;
        snaps[0] = pos;
        var depth: usize = 0;
        var i: usize = 0;
        while (i < 120) : (i += 1) {
            const n = rules.genLegal(&pos, &buf);
            if (n == 0) break; // 将死/逼和,这一局自然结束
            const m = buf[@intFromFloat(rnd() * @as(f64, @floatFromInt(n)))];
            rules.make(&pos, m);
            attempted += 1;
            // 增量哈希 == 全量重算?
            const a = pos.keyA;
            const bb = pos.keyB;
            _ = rules.recomputeKeys(&pos);
            checks += 1;
            if (a == pos.keyA and bb == pos.keyB) hashOk += 1;
            stack[depth] = m;
            depth += 1;
            snaps[depth] = pos;
        }
        // 逐层撤销,每撤一层都必须与进入该层前的快照完全一致
        while (depth > 0) {
            depth -= 1;
            rules.unmake(&pos, stack[depth]);
            restored += 1;
            if (!sameState(&pos, &snaps[depth])) {
                check(false, "撤销后局面未还原({s} 第 {d} 手)", .{ tc.name, depth });
                break;
            }
        }
    }
    check(hashOk == checks, "Zobrist 增量与全量重算一致({d}/{d})", .{ hashOk, checks });
    check(restored == attempted, "撤销层数 = 走的层数({d}/{d})", .{ restored, attempted });
    check(attempted > 400, "走/撤层数 {d} > 400", .{attempted});
}

//  ---------- 规则边角 ----------
fn runEdges() void {
    say("\n== 规则边角", .{});
    var buf: [256]i32 = undefined;
    {
        var pos = rules.loadFen("r3k2r/8/8/8/8/8/4r3/R3K2R w KQkq - 0 1");
        const n = rules.genLegal(&pos, &buf);
        var castles: i32 = 0;
        for (buf[0..n]) |m| {
            const f = rules.mFlag(m);
            if (f == rules.F_OO or f == rules.F_OOO) castles += 1;
        }
        check(castles == 0, "被将被车将军时不能易位(实得 {d})", .{castles});
    }
    {
        var pos = rules.loadFen("8/P6k/8/8/8/8/8/7K w - - 0 1");
        const n = rules.genLegal(&pos, &buf);
        var promo: i32 = 0;
        for (buf[0..n]) |m| {
            const f = rules.mFlag(m);
            if (f >= 6 and f < 10) promo += 1;
        }
        check(promo == 4, "a7 兵有 4 个升变着法(实得 {d})", .{promo});
    }
    {
        var pos = rules.loadFen("1n6/P6k/8/8/8/8/8/7K w - - 0 1");
        const n = rules.genLegal(&pos, &buf);
        var pc: i32 = 0;
        for (buf[0..n]) |m| if (rules.mFlag(m) >= 10) {
            pc += 1;
        };
        check(pc == 4, "升变且吃子有 4 个着法(实得 {d})", .{pc});
    }
    {
        var pos = rules.loadFen("rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3");
        const n = rules.genLegal(&pos, &buf);
        var ep: i32 = 0;
        var epm: i32 = -1;
        for (buf[0..n]) |m| {
            if (rules.mFlag(m) == rules.F_EP) {
                ep += 1;
                epm = m;
            }
        }
        check(ep == 1, "e5 兵可以吃过路兵 f6(实得 {d})", .{ep});
        if (epm >= 0) {
            const before = pos;
            rules.make(&pos, epm);
            const gone = pos.b[rules.mTo(epm) + 8] == 0;
            rules.unmake(&pos, epm);
            check(gone and sameState(&pos, &before), "吃过路兵后被吃黑兵消失且撤销还原", .{});
        }
    }
    {
        var mate = rules.loadFen("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3");
        check(!rules.hasLegalMove(&mate, &buf) and rules.inCheck(&mate), "后 h4 杀:白方无合法着法且被将军", .{});
        var stale = rules.loadFen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
        check(!rules.hasLegalMove(&stale, &buf) and !rules.inCheck(&stale), "逼和:黑方无着法且未被将军", .{});
    }
    {
        var pos = rules.loadFen("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
        check(rules.insufficientMaterial(&pos), "王对王 = 子力不足", .{});
        var pos2 = rules.loadFen("4k3/8/8/8/8/8/8/4KB2 w - - 0 1");
        check(rules.insufficientMaterial(&pos2), "王象对王 = 子力不足", .{});
        var pos3 = rules.loadFen("4k3/8/8/8/8/8/4P3/4K3 w - - 0 1");
        check(!rules.insufficientMaterial(&pos3), "有兵 = 不是子力不足", .{});
    }
    {
        var start = rules.loadFen("4k3/8/8/8/8/8/8/4K2R w - - 0 1");
        const seq = [_][]const u8{ "e1e2", "e8e7", "e2e1", "e7e8", "e1e2", "e8e7", "e2e1", "e7e8" };
        var allOk = true;
        for (seq) |s| {
            const n = rules.genLegal(&start, &buf);
            const l = lineSquares(s);
            var m: i32 = -1;
            for (buf[0..n]) |c| {
                if (rules.mFrom(c) == l.from and rules.mTo(c) == l.to) {
                    m = c;
                    break;
                }
            }
            if (m < 0) {
                allOk = false;
                break;
            }
            rules.make(&start, m);
        }
        check(allOk and rules.isRepetition(&start) and rules.isThreefold(&start), "来回两次后:重复局面 + 三次重复", .{});
    }
}

//  ---------- 战术 ----------
fn runTactics() void {
    say("\n== 战术", .{});
    {
        var pos = rules.loadFen("6k1/5ppp/8/8/8/8/8/R6K w - - 0 1");
        const r = thinkOf(&pos, 20000);
        const s = san(r.move);
        check(r.score > 29000 and isMatingMove(&pos, r.move), "底线一步杀 {s},分 {d}", .{ s, r.score });
    }
    {
        var pos = rules.loadFen("7k/R7/8/8/8/8/8/1R4K1 w - - 0 1");
        const r = thinkOf(&pos, 20000);
        const s = san(r.move);
        check(r.score > 29000 and isMatingMove(&pos, r.move), "双车梯子杀 {s},分 {d}", .{ s, r.score });
    }
    {
        var pos = rules.loadFen("4k3/8/8/3q4/4P3/8/8/R3K2R w KQ - 0 1");
        const r = thinkOf(&pos, 20000);
        const s = san(r.move);
        check(std.mem.eql(u8, &s, "e4d5") and r.score > 600, "白吃无保护的后 {s},分 {d}", .{ s, r.score });
    }
    {
        var pos = rules.loadFen("4k3/8/8/8/8/8/4r3/4K3 w - - 0 1");
        const r = thinkOf(&pos, 20000);
        const s = san(r.move);
        rules.make(&pos, r.move);
        const still = rules.inCheckOf(&pos, rules.WHITE);
        rules.unmake(&pos, r.move);
        check(!still, "被将时必须吃掉无保护送子(实走 {s})", .{s});
    }
}

//  ---------- 残局必须真的能杀 ----------
fn playToMate(fen: []const u8, maxPlies: usize, nodes: u64) struct { plies: usize, mate: bool, stale: bool } {
    var pos = rules.loadFen(fen);
    var buf: [256]i32 = undefined;
    var plies: usize = 0;
    var mate = false;
    var stale = false;
    while (plies < maxPlies) {
        if (!rules.hasLegalMove(&pos, &buf)) {
            mate = rules.inCheck(&pos);
            stale = !mate;
            break;
        }
        const r = search.searchBest(&pos, .{ .nodes = nodes, .depth = 24 });
        rules.make(&pos, r.move);
        plies += 1;
    }
    if (!rules.hasLegalMove(&pos, &buf)) {
        mate = rules.inCheck(&pos);
        if (!mate) stale = true;
    }
    return .{ .plies = plies, .mate = mate, .stale = stale };
}

fn runEndgame() void {
    say("\n== 残局将杀能力", .{});
    {
        const g = playToMate("4k3/8/8/8/8/8/8/4K2Q w - - 0 1", 60, 60000);
        check(g.mate and !g.stale, "后对王 60 手内将杀(用了 {d} 手,逼和={})", .{ g.plies, g.stale });
    }
    {
        const g = playToMate("4k3/8/8/8/8/8/8/4K2R w - - 0 1", 90, 8000);
        check(g.mate and !g.stale, "车对王 90 手内将杀(用了 {d} 手,逼和={})", .{ g.plies, g.stale });
    }
}

//  ---------- 开局谱库(二进制 blob)----------
fn runBook() void {
    say("\n== 开局谱库(二进制 blob,结构完整性)", .{});
    check(book.verifyIntegrity(), "前序布局首尾相接恰好耗尽 blob", .{});
    check(book.famCount() > 100 and book.nodeCount() > 5000, "体量:族 {d} / 节点 {d}", .{ book.famCount(), book.nodeCount() });
    check(book.famName(255, .en) == null and book.famName(0, .zh) != null and book.famName(book.famCount(), .en) == null, "族名边界:255/越界为空,0 号有名字", .{});
    check(book.famName(0, .en) != null and book.famName(0, .zh) != null and !std.mem.eql(u8, book.famName(0, .en).?, book.famName(0, .zh).?), "族名双语:英/中两条都非空且不同", .{});
    const e2e4: i32 = (52 << 6) | 36;
    const root = book.walk(&[_]i32{}).?;
    check(root.count == book.rootKids() and root.count >= 15, "根候选 {d} 个", .{root.count});
    var cands: [256]book.Cand = undefined;
    const nRoot = book.candidates(root, &cands);
    var hasE4 = false;
    for (cands[0..nRoot]) |c| {
        if (c.line == e2e4) hasE4 = true;
    }
    check(hasE4, "根候选含 e2e4", .{});
    const after = book.walk(&[_]i32{e2e4}).?;
    check(!after.empty(), "e2e4 之后谱内仍有候选", .{});
    check(book.walk(&[_]i32{(52 << 6) | 37}) == null, "谱外线判无谱", .{});
    var pickOk = true;
    for (1..16) |sd| {
        const p = book.pick(root, @intCast(sd)) orelse {
            pickOk = false;
            break;
        };
        const line = (@as(u32, p.from) << 6) | p.to;
        var inSet = false;
        for (cands[0..nRoot]) |c| {
            if (c.line == line) inSet = true;
        }
        if (!inSet) pickOk = false;
    }
    check(pickOk, "档位加权抽取:多次落点都在候选集内", .{});
}

//  ---------- 基准 ----------
fn runBench(budget: u64) void {
    say("\n== 搜索基准({d} 节点预算/局面,6 个 perft 题面)", .{budget});
    var totalNodes: u64 = 0;
    const t0 = nowNs();
    for (PERFT) |tc| {
        var pos = rules.loadFen(tc.fen);
        const r = search.searchBest(&pos, .{ .nodes = budget, .depth = 24 });
        totalNodes += r.nodes;
    }
    const ms = (nowNs() - t0) / 1_000_000;
    const nps = if (ms > 0) totalNodes * 1000 / ms else 0;
    say("  6 局面共 {d} 节点 / {d} ms ⇒ NPS ≈ {d}(JS 版同机参考 ≈ 275k,见 levels.js 标定)", .{ totalNodes, ms, nps });
    check(nps > 275_000, "wasm/原生 NPS 应高于 JS 基线(实得 {d})", .{nps});
}

pub fn main(init: std.process.Init) !void {
    gio = init.io;
    const arena = init.arena.allocator();
    const argv = try init.minimal.args.toSlice(arena);
    const cmd = if (argv.len > 1) argv[1] else "all";

    if (std.mem.eql(u8, cmd, "bench")) {
        const n: u64 = if (argv.len > 2) try std.fmt.parseInt(u64, argv[2], 10) else 300_000;
        runBench(n);
        return;
    }

    say("AetherChess zig 通道自测", .{});
    runPerft();
    runInvariants();
    runEdges();
    runTactics();
    runEndgame();
    runBook();
    runBench(300_000);
    if (failed) {
        say("\n✗ 自测未通过", .{});
        std.process.exit(1);
    }
    say("\n✓ 自测通过", .{});
}
