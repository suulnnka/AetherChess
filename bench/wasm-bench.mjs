#!/usr/bin/env node
/* ============================================================
 * 直接对局:本引擎(wasm) vs chessy 的 Rust/WASM 引擎。
 *
 * JS 参照实现移除后,「本引擎」一侧与棋规裁判全走 wasm(见 bench/referee.mjs);
 * 同为 wasm 环境、同为节点预算的对抗赛,口径不变:
 *   本引擎 nodes 含静态搜索;chessy nodes 只计主搜索(qnodes 单列)。
 * 确定性:本引擎 seed 固定;chessy 节点预算固定 ⇒ 整场可复现,可分片。
 *
 * 用法:
 *   node bench/wasm-bench.mjs --level hard --nodes 160000 --games 8
 *   node bench/wasm-bench.mjs --shard 0/4 --out out/w0.json
 *
 * chessy 产物(仓库不附带,默认 bench/vendor/chessy/,已 gitignore):
 *   mkdir -p bench/vendor/chessy && cd bench/vendor/chessy
 *   curl -L -O https://raw.githubusercontent.com/den-run-ai/chessy/main/assets/chessy-ai-fast.wasm
 *   curl -L -O https://raw.githubusercontent.com/den-run-ai/chessy/main/assets/wasm-engine.js
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createEngine } from './referee.mjs';

const require = createRequire(import.meta.url);

/* ---------- CLI ---------- */
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const LEVEL = argOf('--level', 'hard');
const NODES = argOf('--nodes', '160000').split(',').map(Number);   // chessy 的节点预算
const GAMES = Number(argOf('--games', '8'));
const MAXPLY = Number(argOf('--maxply', '200'));
const SHARD = argOf('--shard', '0/1');
const OUT = argOf('--out', '');
const QUIET = argv.includes('--quiet');
/* chessy 的两个产物放在 bench/vendor/chessy/(已 gitignore),仓库里不附带 */
const VENDOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'chessy');
const WASM = argOf('--wasm', process.env.CHESSY_WASM || path.join(VENDOR, 'chessy-ai-fast.wasm'));
const LOADER = argOf('--loader', process.env.CHESSY_LOADER || path.join(VENDOR, 'wasm-engine.js'));

if (!fs.existsSync(WASM) || !fs.existsSync(LOADER)) {
  console.error(`✗ 找不到 chessy 的产物:`);
  console.error(`    wasm   = ${WASM}  ${fs.existsSync(WASM) ? '✓' : '✗'}`);
  console.error(`    loader = ${LOADER}  ${fs.existsSync(LOADER) ? '✓' : '✗'}`);
  console.error('');
  console.error('  仓库里不附带第三方 wasm,先自己下一份(已 gitignore):');
  console.error('');
  console.error('    mkdir -p bench/vendor/chessy && cd bench/vendor/chessy');
  console.error('    curl -L -O https://raw.githubusercontent.com/den-run-ai/chessy/main/assets/chessy-ai-fast.wasm');
  console.error('    curl -L -O https://raw.githubusercontent.com/den-run-ai/chessy/main/assets/wasm-engine.js');
  console.error('');
  console.error('  也可以用 --wasm / --loader 指定别处,或设 CHESSY_WASM / CHESSY_LOADER。');
  process.exit(2);
}

/* ---------- chessy 驱动 ----------
 * 本包 package.json 是 type:module,require 该 UMD loader 会按 ESM 加载:
 * module.exports 分支不生效,工厂结果挂到 globalThis.WasmEngine —— 两种形态都兜住。 */
const _ns = require(LOADER);
const WasmEngine = typeof _ns?.load === 'function' ? _ns : globalThis.WasmEngine;
const chessy = await WasmEngine.load(fs.readFileSync(WASM));

/* ---------- 本引擎(wasm)---------- */
const we = await createEngine();

/* ---------- 终局判定与裁定(referee 提供棋规,这里只做长局裁定) ---------- */

/** chessy 局面 → FEN(由 referee 的棋盘状态拼;we 引擎当前局面即对局局面) */
function fenOf(we, fullmove = 20) {
  const X = we.X;
  X.engineState();
  const b = new Int8Array(X.memory.buffer, X.engineBoardPtr(), 64);
  /* 子力编码 (颜色<<3)|型:1..6 = P N B R Q K;9..14 = 黑 p n b r q k(7/8 无对应子) */
  const CH = ['.', 'P', 'N', 'B', 'R', 'Q', 'K', '.', '.', 'p', 'n', 'b', 'r', 'q', 'k'];
  let s = '';
  for (let rr = 0; rr < 8; rr++) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = b[rr * 8 + f];
      if (!p) { empty++; continue; }
      if (empty) { s += empty; empty = 0; }
      s += CH[p];
    }
    if (empty) s += empty;
    if (rr < 7) s += '/';
  }
  s += X.engineStm() === 0 ? ' w ' : ' b ';
  s += '- - 0 ' + fullmove;
  return s;
}

/**
 * 下一局。ourColor 0=白 1=黑,csNodes 为 chessy 节点预算。
 * 返回 { result(本引擎视角), plies, reason, ourDepth }
 */
async function playGame(levelId, csNodes, opening, ourColor) {
  we.reset();
  const hist = Object.create(null);      // 供 chessy 做重复局面判定:FEN → 出现次数
  let fullmove = 1;
  const ucis = [];

  const recordFen = () => {
    const f = fenOf(we, fullmove);
    hist[f] = (hist[f] || 0) + 1;
  };

  for (const u of opening) {
    recordFen();
    we.playUci(u);
    ucis.push(u);
    if (we.X.engineStm() === 0) fullmove++;
  }

  for (let ply = 0; ply < MAXPLY; ply++) {
    const { legal, over, result } = we.refresh();
    if (over) {
      const weLost = (result === 'mate' && we.X.engineStm() === ourColor);
      const r = result === 'mate' ? (weLost ? 'loss' : 'win')
        : result === 'fiftymove' ? 'draw' : 'draw';
      return { result: r, plies: ucis.length, reason: result, ourDepth: we.ourAvgDepth() };
    }
    if (!legal.length) return { result: 'draw', plies: ucis.length, reason: 'no-legal', ourDepth: we.ourAvgDepth() };

    let uci;
    if (we.X.engineStm() === ourColor) {
      uci = we.think(levelId, 1);
      if (!uci) return { result: 'draw', plies: ucis.length, reason: 'no-move', ourDepth: we.ourAvgDepth() };
    } else {
      const r = chessy.search(fenOf(we, fullmove), { maxDepth: 24, nodeLimit: csNodes, quiesce: true, positions: { ...hist } });
      if (!r.move) return { result: ourColor === we.X.engineStm() ? 'win' : 'loss', plies: ucis.length, reason: 'cs-no-move', ourDepth: we.ourAvgDepth() };
      const mv = r.move;
      uci = 'abcdefgh'[mv.from & 7] + (8 - (mv.from >> 3)) + 'abcdefgh'[mv.to & 7] + (8 - (mv.to >> 3))
        + (mv.promotion ? String(mv.promotion).toLowerCase() : '');
    }

    recordFen();
    we.playUci(uci);
    ucis.push(uci);
    if (we.X.engineStm() === 0) fullmove++;
  }

  /* 步数上限:两侧静态评估取平均来裁定,避免长局被一律算和 */
  const a = we.evalWhite();
  let c = 0;
  try { c = chessy.evaluate(fenOf(we, fullmove)); } catch { c = 0; }
  const cp = Math.round((a + c) / 2);
  const who = cp > 0 ? 0 : 1;
  const avg = we.ourAvgDepth();
  if (Math.abs(cp) < 150) return { result: 'draw', plies: ucis.length, reason: `adjudicate ${cp}cp`, ourDepth: avg };
  return { result: who === ourColor ? 'win' : 'loss', plies: ucis.length, reason: `adjudicate ${cp}cp`, ourDepth: avg };
}

/* ---------- 赛程 ---------- */
const OPENINGS = [
  [], ['e2e4'], ['d2d4'], ['c2c4'], ['g2g3'], ['g1f3'],
  ['e2e4', 'e7e5'], ['d2d4', 'd7d5'], ['e2e4', 'c7c5'],
  ['d2d4', 'g8f6'], ['e2e4', 'e7e6'], ['d2d4', 'e7e6'],
];

const [si, sn] = SHARD.split('/').map(Number);
const games = [];
for (const n of NODES) {
  for (const o of OPENINGS.slice(0, Math.max(1, Math.ceil(GAMES / 2)))) {
    for (const ourColor of [0, 1]) games.push({ nodes: n, opening: o, ourColor });
  }
}
const mine = games.filter((_, i) => i % sn === si);

const eloFromScore = (s) => (s <= 0 ? -Infinity : s >= 1 ? Infinity : -400 * Math.log10(1 / s - 1));
const fmtElo = (e) => (!isFinite(e) ? (e > 0 ? '>+800' : '<-800') : (e >= 0 ? '+' : '') + e.toFixed(0));
const LBL = { win: '胜', loss: '负', draw: '和' };

if (!QUIET) console.log(`本引擎: wasm ${LEVEL}   对手: chessy(wasm) 节点预算 ${NODES.join('/')}\n`);

const results = [];
for (const g of mine) {
  const r = await playGame(LEVEL, g.nodes, g.opening, g.ourColor);
  results.push({ ...g, ...r });
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ level: LEVEL, opponent: 'chessy', partial: true, results }));
  if (!QUIET) {
    console.log(`cs${String(g.nodes / 1000).padStart(4)}k ${g.ourColor === 0 ? '白' : '黑'} ${(g.opening.join(' ') || '(初始)').padEnd(14)} ${LBL[r.result]}  ${String(r.plies).padStart(3)}手  d${r.ourDepth.toFixed(1)}  ${r.reason}`);
  }
}

/* ---------- 汇总 ---------- */
const byNodes = {};
for (const r of results) {
  const b = byNodes[r.nodes] ||= { w: 0, l: 0, d: 0, n: 0 };
  b.n++;
  if (r.result === 'win') b.w++; else if (r.result === 'loss') b.l++; else b.d++;
}
const summary = Object.entries(byNodes).sort((a, b) => a[0] - b[0]).map(([n, b]) => {
  const s = (b.w + b.d / 2) / b.n;
  return { chessyNodes: Number(n), ...b, score: s, elo: eloFromScore(s) };
});

if (!QUIET) {
  console.log('\nchessy节点   局  胜  和  负   本引擎得分率      相对 chessy 的 Elo 差');
  for (const s of summary) {
    console.log(`${String(s.chessyNodes / 1000).padStart(8)}k  ${String(s.n).padStart(3)} ${String(s.w).padStart(3)} ${String(s.d).padStart(3)} ${String(s.l).padStart(3)}   ${(s.score * 100).toFixed(1).padStart(8)}%   ${fmtElo(s.elo).padStart(9)}`);
  }
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ level: LEVEL, opponent: 'chessy', results, summary }, null, 2));
process.exit(0);
