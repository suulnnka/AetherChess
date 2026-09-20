/* ============================================================
 * 构建浏览器用的 wasm 产物并落到 wasm/chess.wasm(入库,与 AetherOthello
 * 的 wasm/othello.wasm 同一交付方式)。
 *
 * 为什么入库:webos 侧 vite build 直接从源码树里 fetch 这个 .wasm
 *   (worker 里的 new URL('../wasm/chess.wasm', import.meta.url)),
 *   仓库里没有它就构建不起来。代价是**改了引擎必须重跑本脚本并提交**,
 *   所以脚本最后会跑产物关卡:zig 原生测试(perft/规则/自检)+ wasm 冒烟
 *   (实例化 → enginePerft 标准值 → engineThink 合法出招),忘了重建或
 *   产物漂了都会被拦住。
 *
 * 用法:node tools/build-wasm.mjs [--skip-probe]
 * 退出码:0 成功 / 1 构建或验证失败
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const ZIG = process.env.ZIG || 'zig';
const OUT = path.join(ROOT, 'wasm', 'chess.wasm');
const BUILT = path.join(ROOT, 'zig-out', 'bin', 'chess.wasm');

/** WinGet 装的 zig 在 Windows 上会间歇 AccessDenied(杀软/文件占用),
 *  重试几次就好 —— AetherOthello 的 build-wasm 里踩过,同一套兜底。 */
function zigBuild() {
  for (let i = 1; i <= 4; i++) {
    try {
      execFileSync(ZIG, ['build'], { stdio: 'inherit', cwd: ROOT });
      return;
    } catch (err) {
      const txt = String((err && (err.stdout || err.stderr || err.message)) || err);
      const transient = /AccessDenied|Access is denied|另一个程序正在使用|EBUSY|EPERM/i.test(txt);
      console.error(`\n✗ zig build 第 ${i} 次失败${transient ? '(瞬时占用,重试)' : ''}`);
      if (!transient || i === 4) throw err;
    }
  }
}

console.log('» zig build');
zigBuild();

const raw = fs.readFileSync(BUILT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(BUILT, OUT);

const gz = zlib.gzipSync(raw, { level: 9 }).length;
const br = zlib.brotliCompressSync(raw, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
}).length;
const kb = (n) => (n / 1024).toFixed(2) + ' KB';
console.log(`\n» zig-out/bin/chess.wasm → wasm/chess.wasm`);
console.log(`  raw    ${String(raw.length).padStart(7)} B   ${kb(raw.length)}`);
console.log(`  gzip   ${String(gz).padStart(7)} B   ${kb(gz)}`);
console.log(`  brotli ${String(br).padStart(7)} B   ${kb(br)}`);
console.log('  (webos 体积闸门:国际象棋预算 50KB gzip = worker 胶水 + 本产物求和计费)');

if (!process.argv.includes('--skip-probe')) {
  console.log('\n» zig 原生测试(zig build test:perft 标准值 / 规则 / 状态)');
  execFileSync(ZIG, ['build', 'test'], { stdio: 'inherit', cwd: ROOT });
  console.log('\n» wasm 产物冒烟(node tools/wasm-smoke.mjs)');
  execFileSync(process.execPath, ['tools/wasm-smoke.mjs'], { stdio: 'inherit', cwd: ROOT });
}
console.log('\n✓ wasm 产物已就绪:wasm/chess.wasm');
