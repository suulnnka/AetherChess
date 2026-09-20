#!/usr/bin/env node
/* ============================================================
 * wasm 产物冒烟:对 wasm/chess.wasm 本体做最小正确性检查。
 * JS 参照实现移除后,这就是 build-wasm 的产物关卡(与 zig build test 互补:
 * 那边验源码逻辑,这边验「落盘的产物本身能起、算得对」)。
 *
 *   ① engineInit + enginePerft:起始局面 perft 1..4 对标准值
 *   ② engineThink:起始局面出招必须落在 engineState 的合法着法表里
 *   ③ 傻瓜自弈 40 步:每步都合法,终局判定字段自洽(不到终局必须 over=0)
 *
 * 退出码:0 通过 / 1 失败
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { instance } = await WebAssembly.instantiate(fs.readFileSync(path.join(ROOT, 'wasm', 'chess.wasm')), {});
const X = instance.exports;

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
};

ok(X.engineInit() === 0, 'engineInit');

/* ---- ① perft 标准值 ---- */
const PERFT = [20, 400, 8902, 197281];
for (let d = 1; d <= 4; d++) {
  X.engineLoad(0);
  const n = X.enginePerft(d);
  ok(n === PERFT[d - 1], `perft(${d}) = ${n}(标准值 ${PERFT[d - 1]})`);
}

/* ---- 裁判助手:合法表 + 走子 ----
 * 位序注意:engineState 的 legalOut 是线格式 (from<<6|to);engineThink 返回
 * **内部打包**(from = 低 6 位,mFrom(m)=m&63,见 rules.zig)。各自解包后按
 * {from,to} 无序对比较,不比原始整数。 */
const legalPairs = () => Array.from(new Int32Array(X.memory.buffer, X.engineLegalPtr(), X.engineLegalCount()))
  .map((w) => ((w >> 6) & 63) * 64 + (w & 63));
const thinkPair = (m) => (m & 63) * 64 + ((m >> 6) & 63);
const applySeq = (wires) => {
  const view = new Int32Array(X.memory.buffer, X.engineMovesBuf(), wires.length);
  for (let i = 0; i < wires.length; i++) view[i] = wires[i];
  return X.engineLoad(wires.length) === 1;   // engineLoad 从初始局面重演全序列
};
const sqName = (s) => 'abcdefgh'[s & 7] + (8 - (s >> 3));
const toUci = (m) => sqName(m & 63) + sqName((m >> 6) & 63);

/* ---- ② think 出招合法性 ---- */
X.engineLoad(0);
X.engineState();
const legal0 = legalPairs();
const mv = X.engineThink(24, 40000, 0, 1);
ok(mv !== 0 && legal0.includes(thinkPair(mv)), `engineThink 出招 ${toUci(mv)} 在合法表内(${legal0.length} 个合法着法)`);

/* ---- ③ 傻瓜自弈 40 步(浅搜,只验规则自洽) ---- */
X.engineLoad(0);
let ply = 0, bad = null;
const seq = [];                                              // 线格式全序列(engineLoad 语义)
for (; ply < 80; ply += 2) {                                 // 80 ply = 40 回合
  X.engineState();
  if (X.engineOver() === 1) break;
  const legal = legalPairs();
  if (!legal.length) { bad = '局面未终局但没有合法着法'; break; }
  const w = X.engineThink(2, 3000, 0, 7);
  if (!legal.includes(thinkPair(w))) { bad = `第 ${ply + 1} 步引擎给出着法不在合法表内`; break; }
  /* engineThink 是内部打包 → 转线格式(from 高位)再入序列 */
  seq.push(((w & 63) << 6) | ((w >> 6) & 63));
  if (!applySeq(seq)) { bad = `第 ${ply + 1} 步 engineLoad 拒绝了合法表内的着法`; break; }
}
if (bad) ok(false, `自弈:${bad}`);
else ok(true, `自弈 ${ply} 步全程合法${ply < 80 ? '(提前终局,result=' + X.engineResult() + ')' : ''}`);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
