/* ============================================================
 * 从 src/eval.js 的 EVAL_P(调参拟合的 491 参数)生成 src/zig/params.zig。
 *
 * 为什么不手抄:491 个 f64 手抄必错;而且参数是拟合产物,以后重调参时
 * 重跑本脚本即可同步 zig 侧。生成物入库(与 eval.js 一样是"源码")。
 *
 * 精度:用 String(x) 的最短往返十进制(Node 保证 round-trip),zig 解析
 * f64 字面量按 IEEE754 正确舍入 ⇒ 逐位一致。
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
  const v = String(EVAL_P[i]);
  lines.push(`  ${v.includes('.') || v.includes('e') ? v : v + '.0'},   // [${i}]`);
}

const head = `// ============================================================
// 国际象棋评估参数(491 个,调参拟合值)—— **生成物,勿手改**。
// 来源:src/eval.js 的 EVAL_P,由 tools/gen-params.mjs 导出。
// (zig 0.16 起没有块注释,这里用行注释)
// 重调参后重跑:node tools/gen-params.mjs && node tools/build-wasm.mjs
// ============================================================
pub const N = ${N_EVAL_PARAMS};

/// 与 eval.js EVAL_P 逐位一致(f64 最短往返十进制)
pub const P = [_]f64{
`;

fs.writeFileSync(OUT, head + lines.join('\n') + '\n};\n');
console.log(`✓ ${path.relative(ROOT, OUT)}(${N_EVAL_PARAMS} 参数,来自 eval.js 的拟合值)`);
