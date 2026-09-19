const std = @import("std");

/// AetherChess 的 Zig 通道(布局对齐 vendor/AetherOthello/build.zig):
///   原生:selftest(perft/不变量/战术/残局/基准)
///   wasm:engine(浏览器 worker 加载,导出 C ABI;规则/评估/搜索全在 wasm 里)
pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    // 不用 standardOptimizeOption:默认落回 Debug 会让基准数字全废,原生工具一律 ReleaseFast。

    // ── 原生自测 + 基准 ────────────────────────────────────────────
    // 注意:自定义 step 必须依赖 install,否则 `zig build selftest` 只编译运行、
    // 不刷新 zig-out/bin(AetherOthello 踩过的坑)。
    const selftest = b.addExecutable(.{
        .name = "selftest",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/selftest.zig"),
            .target = target,
            .optimize = .ReleaseFast,
        }),
    });
    const inst_selftest = b.addInstallArtifact(selftest, .{});
    b.getInstallStep().dependOn(&inst_selftest.step);
    const run_selftest = b.addRunArtifact(selftest);
    if (b.args) |args| run_selftest.addArgs(args);
    // Step.dependOn 返回 void,不能链式调用两遍
    const st_selftest = b.step("selftest", "跑 perft/不变量/战术/残局自测与基准");
    st_selftest.dependOn(&inst_selftest.step);
    st_selftest.dependOn(&run_selftest.step);

    // ── wasm 引擎 ─────────────────────────────────────────────────
    // ReleaseFast 而不是 ReleaseSmall:多出来的字节换搜索速度值。
    // ⚠ strip = true 不是可选项:不 strip 的话 DWARF/name 段会把产物顶爆,
    // 而它们对运行毫无用处。体积闸门在 webos 侧兜底。
    const wasm = b.addExecutable(.{
        .name = "chess",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/engine.zig"),
            .target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .freestanding }),
            .optimize = .ReleaseFast,
            .strip = true,
        }),
    });
    // freestanding wasm 没有 _start,必须显式关掉入口并打开动态导出,
    // 否则连 export 都拿不到。
    wasm.entry = .disabled;
    wasm.rdynamic = true;
    b.installArtifact(wasm);

    // ── 单元测试 ──────────────────────────────────────────────────
    const unit = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/tests.zig"),
            .target = target,
            .optimize = .ReleaseFast,
        }),
    });
    const run_unit = b.addRunArtifact(unit);
    const test_step = b.step("test", "规则/评估单元测试");
    test_step.dependOn(&run_unit.step);
}
