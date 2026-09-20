/* ============================================================
 * 从 src/eval.js 的 EVAL_P(调参拟合的 491 参数)生成 src/zig/params.zig。
 *
 * 为什么不手抄:491 个参数手抄必错;而且参数是拟合产物,以后重调参时
 * 重跑本脚本即可同步 zig 侧。生成物入库(与 eval.js 一样是"源码")。
 *
 * 精度:拟合值全为整数码兵 ⇒ i32 无损存储(省一半 wasm 文件字节);
 * eval.zig 首次访问时转 f64 工作表,整数在 f64 中表示精确 ⇒ 仍与
 * eval.js EVAL_P 逐位一致。出现非整数拟合值时直接报错,绝不静默丢精度。
 *
 * 用法:node tools/gen-params.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVAL_P, N_EVAL_PARAMS, EVAL_FITTED } from '../src/eval.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'zig', 'params.zig');

if (!EVAL_FITTED) {
  console.error('✗ eval.js 当前是手写初值(FITTED 为空),没有可导出的拟合参数');
  process.exit(1);
}
if (EVAL_P.length !== N_EVAL_PARAMS) {
  console.error(`✗ 参数个数 ${EVAL_P.length} ≠ ${N_EVAL_PARAMS}`);
  process.exit(1);
}

const lines = [];
for (let i = 0; i < EVAL_P.length; i++) {
  const v = EVAL_P[i];
  if (!Number.isInteger(v) || v > 2147483647 || v < -2147483648) {
    console.error(`✗ EVAL_P[${i}] = ${v} 不是 i32 整数 —— i32 存储会丢精度;`);
    console.error('  要么调参器输出取整,要么把本生成器和 eval.zig 回退成 f64 存储');
    process.exit(1);
  }
  lines.push(`  ${v},   // [${i}]`);
}

const head = `// ============================================================
// 国际象棋评估参数(491 个,调参拟合值)—— **生成物,勿手改**。
// 来源:src/eval.js 的 EVAL_P,由 tools/gen-params.mjs 导出。
// (zig 0.16 起没有块注释,这里用行注释)
// 重调参后重跑:node tools/gen-params.mjs && node tools/build-wasm.mjs
// ============================================================
pub const N = ${N_EVAL_PARAMS};

/// i32 无损存储(拟合值全为整数码兵);eval.zig 首次访问时转 f64 工作表,
/// 整数在 f64 中表示精确 ⇒ 与 eval.js EVAL_P 逐位一致
pub const P_I32 = [_]i32{
`;

fs.writeFileSync(OUT, head + lines.join('\n') + '\n};\n');
console.log(`✓ ${path.relative(ROOT, OUT)}(${N_EVAL_PARAMS} 参数,i32 存储,来自 eval.js 的拟合值)`);
