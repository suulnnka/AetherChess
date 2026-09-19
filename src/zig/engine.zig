// wasm 导出层:C ABI,**零导入零分配**(freestanding),对齐 AetherOthello 的
// engine.zig 约定:所有导出只返回数字或静态缓冲指针,不抛异常。
//
// 与黑白棋 wasm 的一个重要差异:**规则也下沉在 wasm 里**。黑白棋当时的
// worker 注释写过"等 zig 工具链可用,规则可以下沉为 engineState 导出"——
// 国际象棋的合法着法/将军/终局判定比黑白棋复杂得多,与其在 JS 胶水里再养
// 一份规则(必然漂移),不如一步到位:state 查询直接吃 wasm 的导出。
//
// 数据进出(无 malloc):
//   · 输入走法序列:JS 把 (from<<6|to) 数组写进 engineMovesBuf() 指向的
//     i32 缓冲,再 engineLoad(n) 重演;
//   · 输出(棋盘 64 字节 / 合法着法线格式):engineBoardPtr()/engineLegalPtr()
//     指向静态缓冲,JS 用 wasm 内存视图直接读。
//
// 局面生命周期:engineLoad 每次**从初始局面重演**(与 JS worker 每次
// newPos()+replayMoves 相同);置换表跨调用保留(Zobrist 键校验兜底,
// 换局 engineNew/engineInit 清表)。
const std = @import("std");
const rules = @import("rules.zig");
const search = @import("search.zig");
const eval = @import("eval.zig");

var pos: rules.Position = undefined;
var inited = false;

fn ensureInit() void {
    if (!inited) {
        pos = rules.newPos();
        inited = true;
    }
}

var inBuf = [_]i32{0} ** 512; // 输入走法序列(真实对局 ≤ ~400 半步)
var work = [_]i32{0} ** 256; // 走法生成 / 重演 / 绑定共用工作区
var legalOut = [_]i32{0} ** 256; // 线格式 (from<<6|to),升变只留升后
var last: search.Result = .{};
var legalCount: i32 = 0;
var overOut: i32 = 0;
var resultOut: i32 = 0; // 0 无 1 mate 2 stale 3 material 4 threefold
var winnerOut: i32 = -1;
var checkOut: i32 = 0;
var lastPerft: u64 = 0;

/// 就绪探针:0 = 好(引擎无外部数据档,恒 0;签名保留给探针与未来扩展)
export fn engineInit() i32 {
    ensureInit();
    pos = rules.newPos();
    search.clearTT();
    return 0;
}

/// 换局:局面归零 + 清置换表(app 侧新对局/悔棋本会换 Worker,长驻时用)
export fn engineNew() i32 {
    ensureInit();
    pos = rules.newPos();
    search.clearTT();
    return 0;
}

/// 输入缓冲地址(JS 写入走法序列后调 engineLoad)
export fn engineMovesBuf() i32 {
    ensureInit();
    return @intCast(@intFromPtr(&inBuf));
}

/// 从初始局面重演 n 步((from<<6|to) 序列,升变一律升后)。
/// 1 = 成功,当前局面即为序列末;0 = 序列含非法着法(局面不可信)。
export fn engineLoad(n: i32) i32 {
    ensureInit();
    pos = rules.newPos();
    const cnt: usize = @intCast(@max(n, 0));
    if (cnt > inBuf.len) return 0;
    return if (rules.replayMoves(&pos, inBuf[0..cnt], &work)) 1 else 0;
}

/// 计算 state 回包所需的全部规则事实(棋盘/行棋方/合法着法/将军/终局),
/// 结果通过各 getter 读出。恒 1(局面已由 engineLoad 校验)。
export fn engineState() i32 {
    ensureInit();
    const n = rules.genLegal(&pos, &work);
    var w: usize = 0;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const m = work[i];
        const pr = rules.mPromo(m);
        if (pr != 0 and pr != rules.QUEEN) continue; // 升变只留升后(与 UI 约定一致)
        legalOut[w] = (@as(i32, rules.mFrom(m)) << 6) | rules.mTo(m);
        w += 1;
    }
    legalCount = @intCast(w);
    checkOut = if (rules.inCheck(&pos)) 1 else 0;
    overOut = 0;
    resultOut = 0;
    winnerOut = -1;
    if (w == 0) {
        overOut = 1;
        if (checkOut == 1) {
            resultOut = 1; // 将死:行棋方负
            winnerOut = 1 - pos.stm;
        } else {
            resultOut = 2; // 逼和
        }
    } else if (rules.insufficientMaterial(&pos)) {
        overOut = 1;
        resultOut = 3; // 子力不足,无法将死
    } else if (rules.isThreefold(&pos)) {
        overOut = 1;
        resultOut = 4; // 三次重复局面
    }
    return 1;
}

export fn engineBoardPtr() i32 {
    ensureInit();
    return @intCast(@intFromPtr(&pos.b));
}
export fn engineStm() i32 {
    ensureInit();
    return pos.stm;
}
export fn engineLegalPtr() i32 {
    ensureInit();
    return @intCast(@intFromPtr(&legalOut));
}
export fn engineLegalCount() i32 {
    ensureInit();
    return legalCount;
}
export fn engineCheck() i32 {
    ensureInit();
    return checkOut;
}
export fn engineOver() i32 {
    ensureInit();
    return overOut;
}
export fn engineResult() i32 {
    ensureInit();
    return resultOut;
}
export fn engineWinner() i32 {
    ensureInit();
    return winnerOut;
}

/// 已装载局面(初始或重演后)的静态评估,行棋方视角厘兵(探针对拍用)
export fn engineEvalCp() i32 {
    ensureInit();
    return eval.evaluate(&pos);
}

/// 搜索当前局面。返回完整着法编码(0 = 无着法);细节经 engineScore/
/// engineDepth/engineNodesLo/Hi 读。nodeLimit 0 = 默认 40000。
export fn engineThink(depthMax: i32, nodeLimit: i32, jitter: i32, seed: i32) i32 {
    ensureInit();
    last = search.searchBest(&pos, .{
        .nodes = @intCast(@max(nodeLimit, 0)),
        .depth = depthMax,
        .jitter = jitter,
        .seed = @bitCast(seed),
    });
    return last.move;
}

export fn engineScore() i32 {
    return last.score;
}
export fn engineDepth() i32 {
    return last.depth;
}
/// 节点计数 u64 拆两半(JS 侧 lo + hi*2^32 拼回)
export fn engineNodesLo() i32 {
    return @bitCast(@as(u32, @truncate(last.nodes)));
}
export fn engineNodesHi() i32 {
    return @bitCast(@as(u32, @truncate(last.nodes >> 32)));
}

/// 在已装载局面上,把 (from,to) 绑定到合法着法的完整编码(升变取升后,
/// 与 replayMoves 同一规则)。开局库的谱着绑定用;0 = 无匹配(谱外)。
export fn engineBind(from: i32, to: i32) i32 {
    ensureInit();
    const n = rules.genMoves(&pos, &work);
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const c = work[i];
        if (rules.mFrom(c) != from or rules.mTo(c) != to) continue;
        const pr = rules.mPromo(c);
        if (pr != 0 and pr != rules.QUEEN) continue;
        if (rules.isLegal(&pos, c)) return c;
    }
    return 0;
}

//  ---------- perft(探针用:与 JS test/engine-test.mjs 同一标准值对拍)----------
var perftBuf = std.mem.zeroes([13][256]i32);

fn perft(p: *rules.Position, depth: i32) u64 {
    if (depth == 0) return 1;
    const buf = &perftBuf[@intCast(depth)];
    const n = rules.genMoves(p, buf);
    var c: u64 = 0;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const m = buf[i];
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

/// 已装载局面跑到 depth 的 perft;结果 u64,enginePerftHi 拿高 32 位
export fn enginePerft(depth: i32) i32 {
    ensureInit();
    lastPerft = perft(&pos, depth);
    return @bitCast(@as(u32, @truncate(lastPerft)));
}
export fn enginePerftHi() i32 {
    return @bitCast(@as(u32, @truncate(lastPerft >> 32)));
}
