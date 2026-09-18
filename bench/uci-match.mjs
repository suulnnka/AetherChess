#!/usr/bin/env node
/* ============================================================
 * 通用 UCI ↔ UCI 对抗赛(两个外部引擎互相打)。
 *
 * 为什么需要它:chess-bench.mjs 是「本引擎 vs 外部引擎」,只能把外部引擎
 * 通过"本引擎"这一个公共对手间接换算;而 chess-bench-wasm.mjs 里的 chessy
 * 是进程内调用,不是 UCI。要独立校验那条换算链(本引擎 ≈ SF depth 7.3 且
 * ≈ Wasabi depth 5),就得能直接让 Wasabi 和 Stockfish 对打一场。
 *
 * 棋盘用本仓库的 rules.js(合法着法/将杀/三次重复/五十步),两个引擎都不许作弊。
 * 每方各给一个确定性限制(--a-depth / --a-nodes / --a-ms),所以整场可复现,
 * 也因此能用 --shard 分片并行。
 *
 * 用法:
 *   node bench/uci-match.mjs --a <wasabi-cli.mjs> --a-opt none --a-depth 8 \
 *                            --b <stockfish.js> --b-depth 6 --games 12
 *   node bench/uci-match.mjs --a ... --b ... --shard 0/4 --out out/x.json
 * ============================================================ */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import process from 'node:process';

import {
  WHITE, BLACK, QUEEN, NAME,
  mFrom, mTo, mPromo,
  newPos, make, genLegal, hasLegalMove, inCheck,
  isThreefold, insufficientMaterial,
} from '../src/rules.js';

/* ---------- CLI ---------- */
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const GAMES = Number(argOf('--games', '12'));
const MAXPLY = Number(argOf('--maxply', '180'));
const SHARD = argOf('--shard', '0/1');
const OUT = argOf('--out', '');
const QUIET = argv.includes('--quiet');

const mkSide = (tag) => {
  const opts = {};
  const optStr = argOf(`--${tag}-opt`, tag === 'b' ? 'Skill Level=20' : 'none');
  if (optStr !== 'none' && optStr !== '') {
    for (const kv of optStr.split(';')) { const i = kv.indexOf('='); if (i > 0) opts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
  }
  const depth = argOf(`--${tag}-depth`, '');
  const nodes = argOf(`--${tag}-nodes`, '');
  const ms = argOf(`--${tag}-ms`, '');
  const go = depth ? `go depth ${depth}` : nodes ? `go nodes ${nodes}` : ms ? `go movetime ${ms}` : 'go depth 6';
  return {
    name: argOf(`--${tag}-name`, `${tag}:${argOf(`--${tag}`, '')}`),
    path: argOf(`--${tag}`, ''),
    opts, go,
    label: go.replace(/^go /, ''),
  };
};
const A = mkSide('a');
const B = mkSide('b');
for (const s of [A, B]) {
  if (!s.path) { console.error(`✗ 缺少引擎路径: 用 --${s === A ? 'a' : 'b'} <路径> 指定`); process.exit(2); }
  if (s.path !== 'stockfish' && !fs.existsSync(s.path)) {
    console.error(`✗ 找不到引擎: ${s.path}`);
    console.error('  本工具只负责「驱动 + 计分」,不自带任何引擎 —— 用 --a / --b 指向你自己准备的');
    console.error('  UCI 可执行文件即可(原生二进制,或能被 node 跑的 .js/.mjs 包装脚本)。');
    console.error('  例:--a bench/vendor/wasabi-cli.mjs --a-depth 6 --b bench/vendor/stockfish/src/stockfish.js --b-depth 6');
    process.exit(2);
  }
}

/* ---------- UCI 驱动(踩过的坑见 chess-bench.mjs 注释) ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Uci {
  constructor(path, opts, name) {
    this.name = name;
    this.proc = /\.(js|mjs|cjs)$/.test(path)
      ? spawn(process.execPath, [path], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = []; this.best = null; this.scoreCp = null; this.bestScore = null;
    readline.createInterface({ input: this.proc.stdout }).on('line', (l) => {
      this.lines.push(l);
      if (this.lines.length > 4000) this.lines.splice(0, 2000);
      const bm = /^bestmove (\S+)(?:\s+ponder\s+(\S+))?/.exec(l);
      if (bm) { this.best = bm[1]; this.bestScore = this.scoreCp; }
      const sc = /score cp (-?\d+)/.exec(l);
      if (sc) this.scoreCp = Number(sc[1]);
      const mt = /score mate (-?\d+)/.exec(l);
      if (mt) this.scoreCp = Number(mt[1]) > 0 ? 30000 : -30000;
    });
    this.opts = opts;
  }
  send(s) { this.proc.stdin.write(s + '\n'); }
  async waitFor(expect, timeout = 60000) {
    const mark = this.lines.length;
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this.lines.slice(mark).some((l) => (typeof expect === 'function' ? expect(l) : l === expect))) return true;
      await sleep(4);
    }
    return false;
  }
  async init() {
    this.send('uci');
    if (!(await this.waitFor('uciok', 30000))) throw new Error(`${this.name} 未回应 uci`);
    await sleep(300);
    for (const [k, v] of Object.entries(this.opts)) {
      this.send(`setoption name ${k} value ${v}`);
      await sleep(12);
    }
    this.send('isready');
    if (!(await this.waitFor('readyok', 30000))) throw new Error(`${this.name} 未回应 isready`);
  }
  async newGame() { this.send('ucinewgame'); this.send('isready'); await this.waitFor('readyok', 60000); }
  /** 走一步:position 之后用 isready/readyok 做屏障,确保引擎消化完局面再收 go */
  async go(ucis) {
    this.best = null; this.scoreCp = null;
    this.send(ucis.length ? `position startpos moves ${ucis.join(' ')}` : 'position startpos');
    this.send('isready');
    await this.waitFor('readyok', 60000);
    this.send(this.goCmd);
    const t0 = Date.now();
    while (!this.best && Date.now() - t0 < 180000) await sleep(4);
    if (!this.best) throw new Error('超时未返回 bestmove');
    return this.best;
  }
  kill() { try { this.send('quit'); } catch { /* 已退出 */ } try { this.proc.kill(); } catch { /* 已退出 */ } }
}

/* ---------- 走法编解码 ---------- */
const PROMO_CH = { 2: 'n', 3: 'b', 4: 'r', 5: 'q' };
const sqOf = (s) => (8 - Number(s[1])) * 8 + 'abcdefgh'.indexOf(s[0]);
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
function terminalReason(pos) {
  const buf = new Int32Array(256);
  if (!hasLegalMove(pos, buf)) return inCheck(pos) ? 'mate' : 'stalemate';
  if (insufficientMaterial(pos)) return 'material';
  if (isThreefold(pos)) return 'threefold';
  if (pos.half >= 100) return 'fiftymove';
  return null;
}

/* ---------- 赛程 ---------- */
const OPENINGS = [
  [], ['e2e4'], ['d2d4'], ['c2c4'], ['g2g3'], ['g1f3'],
  ['e2e4', 'e7e5'], ['d2d4', 'd7d5'], ['e2e4', 'c7c5'],
  ['d2d4', 'g8f6'], ['e2e4', 'e7e6'], ['d2d4', 'e6e6'],
];
const [si, sn] = SHARD.split('/').map(Number);
const games = [];
for (const o of OPENINGS.slice(0, Math.max(1, Math.ceil(GAMES / 2)))) {
  for (const aColor of [WHITE, BLACK]) games.push({ opening: o, aColor });
}
const mine = games.filter((_, i) => i % sn === si);

const eloFromScore = (s) => (s <= 0 ? -Infinity : s >= 1 ? Infinity : -400 * Math.log10(1 / s - 1));
const fmtElo = (e) => (!isFinite(e) ? (e > 0 ? '> +800' : '< -800') : (e >= 0 ? '+' : '') + e.toFixed(0));

const a = new Uci(A.path, A.opts, A.name);
const b = new Uci(B.path, B.opts, B.name);
a.goCmd = A.go; b.goCmd = B.go;
console.log(`A = ${A.label} (${A.path})   B = ${B.label} (${B.path})\n`);
await a.init(); await b.init();

const results = [];
for (const g of mine) {
  await a.newGame(); await b.newGame();
  const pos = newPos();
  const ucis = [];
  for (const u of g.opening) { const m = uciToPacked(pos, u); if (!m) throw new Error('开局非法 ' + u); make(pos, m); ucis.push(u); }

  let out = null;
  for (let ply = 0; ply < MAXPLY; ply++) {
    const term = terminalReason(pos);
    if (term) {
      if (term === 'mate') out = { winner: pos.stm === WHITE ? BLACK : WHITE, reason: 'mate' };
      else out = { winner: null, reason: term };
      break;
    }
    const isA = (pos.stm === g.aColor);
    const eng = isA ? a : b;
    let uci;
    try { uci = await eng.go(ucis); }
    catch (e) { out = { winner: isA ? BLACK : WHITE, reason: 'timeout-' + (isA ? 'A' : 'B') }; break; }
    const m = uciToPacked(pos, uci);
    if (!m) { out = { winner: isA ? BLACK : WHITE, reason: 'illegal-' + (isA ? 'A' : 'B') + ':' + uci }; break; }
    make(pos, m); ucis.push(uci);
  }
  if (!out) {
    /* 步数上限:让 B 再搜一次(浅层)拿评估分来裁定 —— 不这么做的话,
     * 大量其实已分出胜负的长局会被一律算和,把得分率压向 50%。 */
    let cp = 0;
    try { await b.go(ucis); cp = b.bestScore ?? 0; } catch { cp = 0; }
    const whitePov = pos.stm === WHITE ? cp : -cp;
    if (Math.abs(whitePov) < 150) out = { winner: null, reason: `adjudicate ${whitePov}cp` };
    else out = { winner: whitePov > 0 ? WHITE : BLACK, reason: `adjudicate ${whitePov}cp` };
  }
  const aRes = out.winner === null ? 'draw' : (out.winner === g.aColor ? 'win' : 'loss');
  results.push({ opening: g.opening, aColor: g.aColor, aResult: aRes, plies: ucis.length, reason: out.reason });
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ a: A.label, b: B.label, partial: true, results }));
  if (!QUIET) {
    const tag = aRes === 'win' ? 'A胜' : aRes === 'loss' ? 'B胜' : '和';
    console.log(`${(g.opening.join(' ') || '(初始)').padEnd(14)} A执${g.aColor === WHITE ? '白' : '黑'} ${tag}  ${String(ucis.length).padStart(3)}手  ${out.reason}`);
  }
}
a.kill(); b.kill();

const w = results.filter((r) => r.aResult === 'win').length;
const l = results.filter((r) => r.aResult === 'loss').length;
const d = results.length - w - l;
const s = (w + d / 2) / results.length;
console.log(`\nA(${A.label}) 对 B(${B.label}): ${results.length} 局  ${w}胜 ${d}和 ${l}负  得分率 ${(s * 100).toFixed(1)}%  A−B Elo ${fmtElo(eloFromScore(s))}`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ a: A.label, b: B.label, results, w, d, l, score: s }, null, 2));
process.exit(0);
