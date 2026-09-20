#!/usr/bin/env node
/* ============================================================
 * 直接对局:本引擎 vs chessy 的 Rust/WASM 引擎。
 *
 * 为什么要有这个:chess-bench.mjs 是把本引擎拿去跟"限深度的 Stockfish"打,
 * 再借 Stockfish 的 depth→Elo 表反推自己的 Elo —— 链路上多了一层外部假设。
 * 而 docs/chess-ai-plan.md 里点名的两个 wasm 引擎里,chessy 的产物是
 * 一个 37KB 的裸 wasm + 一个 15KB 的 JS 加载器,可以在 Node 里直接驱动,
 * 于是可以做一个真正意义上的"同为 JS 环境、同为节点预算"的对抗赛。
 *
 * 两个引擎的方格编号完全一致(a8=0 … h1=63,即 files-major / 从黑方底线起),
 * 所以走法坐标不需要翻转 —— 只有"走法打包格式"和"升变码"不同,
 * 这里统一用 UCI 串当中介,靠 genLegal 反查回本引擎的打包走法。
 *
 * 用法(chessy 产物需要先落地到本地,见 --wasm / --loader):
 *   node bench/wasm-bench.mjs --level hard --nodes 160000 --games 8
 *   node bench/wasm-bench.mjs --nodes 40000,160000,640000 --games 12
 *   node bench/wasm-bench.mjs --shard 0/4 --out out/w0.json
 *
 * 取 chessy 产物(仓库不附带,默认放 bench/vendor/chessy/,已 gitignore):
 *   mkdir -p bench/vendor/chessy && cd bench/vendor/chessy
 *   curl -L -O https://raw.githubusercontent.com/den-run-ai/chessy/main/assets/chessy-ai-fast.wasm
 *   curl -L -O https://raw.githubusercontent.com/den-run-ai/chessy/main/assets/wasm-engine.js
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  WHITE, BLACK, QUEEN, KNIGHT, BISHOP, ROOK,
  CHARS, colorOf, typeOf, NAME,
  mFrom, mTo, mPromo, mIsQuiet,
  newPos, make, genLegal, hasLegalMove, inCheck, isLegal,
  isThreefold, insufficientMaterial,
} from '../src/rules.js';
import { searchBest, LEVELS, evaluate } from '../src/ai.js';

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

/* ---------- chessy 驱动 ---------- */
/* 本包 package.json 是 type:module,require 该 UMD loader 会按 ESM 加载:
 * module.exports 分支不生效,工厂结果挂到 globalThis.WasmEngine —— 两种形态都兜住。 */
const _ns = require(LOADER);
const WasmEngine = typeof _ns?.load === 'function' ? _ns : globalThis.WasmEngine;
const chessy = await WasmEngine.load(fs.readFileSync(WASM));

/* ---------- 局面 → FEN ----------
 * 本引擎方格编号是 a8=0 … h1=63(见 rules.js 的 SQ_A1 = 56),
 * 所以按 rr=0(第8横线)→7(第1横线)、f=0..7 的顺序拼 rank 串即可。 */
function fenOf(pos, fullmove = 1) {
  let s = '';
  for (let rr = 0; rr < 8; rr++) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = pos.b[rr * 8 + f];
      if (!p) { empty++; continue; }
      if (empty) { s += empty; empty = 0; }
      const ch = CHARS[typeOf(p)];
      s += colorOf(p) === WHITE ? ch.toUpperCase() : ch;
    }
    if (empty) s += empty;
    if (rr < 7) s += '/';
  }
  s += pos.stm === WHITE ? ' w ' : ' b ';
  let c = '';
  if (pos.castle & 1) c += 'K';
  if (pos.castle & 2) c += 'Q';
  if (pos.castle & 4) c += 'k';
  if (pos.castle & 8) c += 'q';
  s += c || '-';
  s += ' ' + (pos.ep >= 0 ? NAME(pos.ep) : '-');
  s += ' ' + pos.half + ' ' + fullmove;
  return s;
}

/* ---------- 走法编解码 ---------- */
const PROMO_CH = { 2: 'n', 3: 'b', 4: 'r', 5: 'q' };
const toUci = (m) => NAME(mFrom(m)) + NAME(mTo(m)) + (mPromo(m) ? PROMO_CH[mPromo(m)] : '');

const sqOf = (s) => (8 - Number(s[1])) * 8 + 'abcdefgh'.indexOf(s[0]);
/** UCI 串 → 本引擎打包走法(靠 genLegal 反查,顺带保证合法性) */
function uciToPacked(pos, str) {
  const from = sqOf(str.slice(0, 2)), to = sqOf(str.slice(2, 4));
  const promo = str.length > 4 ? 'nbrq'.indexOf(str[4]) + 2 : 0;
  const buf = new Int32Array(256);
  const n = genLegal(pos, buf);
  for (let i = 0; i < n; i++) {
    const m = buf[i];
    if (mFrom(m) !== from || mTo(m) !== to) continue;
    if (promo) { if (mPromo(m) === promo) return m; }
    else if (!mPromo(m)) return m;
  }
  return 0;
}
/** chessy 返回的 {from,to,promotion(Q/R/B/N)} → UCI 串 */
function chessyToUci(mv) {
  return NAME(mv.from) + NAME(mv.to) + (mv.promotion ? String(mv.promotion).toLowerCase() : '');
}

/* ---------- 终局判定 ---------- */
function terminalReason(pos) {
  const buf = new Int32Array(256);
  if (!hasLegalMove(pos, buf)) return inCheck(pos) ? 'mate' : 'stalemate';
  if (insufficientMaterial(pos)) return 'material';
  if (isThreefold(pos)) return 'threefold';
  if (pos.half >= 100) return 'fiftymove';
  return null;
}

/* ---------- 单局 ---------- */
const MATE_CP = 25000;
const ourCfgOf = (id) => {
  const lv = LEVELS.find((l) => l.id === id);
  if (!lv) throw new Error('未知难度: ' + id);
  return { nodes: lv.nodes, ms: lv.ms, depth: lv.depth };
};

/** 白方视角静态分:本引擎 evaluate 是"走棋方视角",chessy 是白方视角 */
const ourEvalWhite = (pos) => { const e = evaluate(pos); return pos.stm === WHITE ? e : -e; };

/**
 * 下一局。ourColor 为本引擎执色,csNodes 为 chessy 的节点预算。
 * 返回 { result(本引擎视角), plies, reason, ourDepth }
 */
function playGame(ourCfg, csNodes, opening, ourColor) {
  const pos = newPos();
  const ucis = [];
  const hist = Object.create(null);      // 供 chessy 做重复局面判定:FEN → 出现次数
  let fullmove = 1;
  let depthSum = 0, depthN = 0;

  for (let u of opening) {
    const m = uciToPacked(pos, u);
    if (!m) throw new Error('开局走法非法: ' + u);
    hist[fenOf(pos, fullmove)] = (hist[fenOf(pos, fullmove)] || 0) + 1;
    make(pos, m); ucis.push(u);
    if (pos.stm === WHITE) fullmove++;
  }

  for (let ply = 0; ply < MAXPLY; ply++) {
    const term = terminalReason(pos);
    if (term) {
      if (term === 'mate') return { result: pos.stm === ourColor ? 'loss' : 'win', plies: ucis.length, reason: 'mate', ourDepth: depthN ? depthSum / depthN : 0 };
      return { result: 'draw', plies: ucis.length, reason: term, ourDepth: depthN ? depthSum / depthN : 0 };
    }

    const mover = pos.stm;
    const fen = fenOf(pos, fullmove);
    let uci;
    if (mover === ourColor) {
      const r = searchBest(pos, ourCfg);
      if (!r.move) return { result: 'draw', plies: ucis.length, reason: 'no-move', ourDepth: 0 };
      uci = toUci(r.move);
      depthSum += r.depth; depthN++;
    } else {
      // positions 是 FEN→出现次数的映射(ABI v2 要求),不是数组
      const r = chessy.search(fen, { maxDepth: 24, nodeLimit: csNodes, quiesce: true, positions: { ...hist } });
      if (!r.move) return { result: mover === ourColor ? 'loss' : 'win', plies: ucis.length, reason: 'cs-no-move', ourDepth: depthN ? depthSum / depthN : 0 };
      uci = chessyToUci(r.move);
    }

    const m = uciToPacked(pos, uci);
    if (!m) {
      // 引擎给了非法着法 —— 直接判它输(这本身也是强度信息,要记录下来)
      return { result: mover === ourColor ? 'loss' : 'win', plies: ucis.length, reason: 'illegal-by-' + (mover === ourColor ? 'us' : 'chessy') + ':' + uci, ourDepth: depthN ? depthSum / depthN : 0 };
    }
    hist[fen] = (hist[fen] || 0) + 1;
    make(pos, m); ucis.push(uci);
    if (pos.stm === WHITE) fullmove++;
  }

  /* 步数上限:两个引擎的静态评估取平均来裁定,避免长局被一律算和 */
  const a = ourEvalWhite(pos);
  let c = 0;
  try { c = chessy.evaluate(fenOf(pos, fullmove)); } catch { c = 0; }
  const cp = Math.round((a + c) / 2);
  const who = cp > 0 ? WHITE : BLACK;
  const avg = depthN ? depthSum / depthN : 0;
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
    for (const ourColor of [WHITE, BLACK]) games.push({ nodes: n, opening: o, ourColor });
  }
}
const mine = games.filter((_, i) => i % sn === si);

const eloFromScore = (s) => (s <= 0 ? -Infinity : s >= 1 ? Infinity : -400 * Math.log10(1 / s - 1));
const fmtElo = (e) => (!isFinite(e) ? (e > 0 ? '>+800' : '<-800') : (e >= 0 ? '+' : '') + e.toFixed(0));
const LBL = { win: '胜', loss: '负', draw: '和' };

if (!QUIET) console.log(`本引擎: ${LEVEL}(${JSON.stringify(ourCfgOf(LEVEL))})   对手: chessy(wasm) 节点预算 ${NODES.join('/')}\n`);

const results = [];
for (const g of mine) {
  const r = playGame(ourCfgOf(LEVEL), g.nodes, g.opening, g.ourColor);
  results.push({ ...g, ...r });
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ level: LEVEL, opponent: 'chessy', partial: true, results }));
  if (!QUIET) {
    console.log(`cs${String(g.nodes / 1000).padStart(4)}k ${g.ourColor === WHITE ? '白' : '黑'} ${(g.opening.join(' ') || '(初始)').padEnd(14)} ${LBL[r.result]}  ${String(r.plies).padStart(3)}手  d${r.ourDepth.toFixed(1)}  ${r.reason}`);
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
