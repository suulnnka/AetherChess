#!/usr/bin/env node
/* ============================================================
 * 通用 UCI ↔ UCI 对抗赛(两个外部引擎互相打),棋规裁判走本仓库的 wasm
 * (engineState:合法着法/将杀/逼和/子力不足/三次重复;五十步由 referee
 * 手工计数)。原 rules.js(JS 参照实现)裁判层已随 JS 引擎移除。
 *
 * 每方各给一个确定性限制(--a-depth / --a-nodes / --a-ms),整场可复现,
 * 因此能用 --shard 分片并行。
 *
 * 用法:
 *   node bench/uci-match.mjs --a <engineA> --a-opt none --a-depth 8 \
 *                            --b <engineB> --b-depth 6 --games 12
 *   node bench/uci-match.mjs --a ... --b ... --shard 0/4 --out out/x.json
 * ============================================================ */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import process from 'node:process';

import { createEngine } from './referee.mjs';

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
}

/* ---------- 裁判(wasm) ---------- */
const ref = await createEngine();

/* ---------- UCI 引擎驱动(两踩坑说明见 uci-bench.mjs 同名类) ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class UciEngine {
  constructor(bin, opts = {}) {
    this.proc = /\.(js|mjs|cjs)$/.test(bin)
      ? spawn(process.execPath, [bin], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = [];
    this.best = null;
    this.scoreCp = null;
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (l) => {
      this.lines.push(l);
      const bm = /^bestmove (\S+)/.exec(l);
      if (bm) this.best = bm[1];
      const sc = /score cp (-?\d+)/.exec(l);
      if (sc) this.scoreCp = Number(sc[1]);
      const mt = /score mate (-?\d+)/.exec(l);
      if (mt) this.scoreCp = Number(mt[1]) > 0 ? 30000 : -30000;
    });
    this.opts = opts;
  }
  send(s) { this.proc.stdin.write(s + '\n'); }
  async cmd(line, expect, timeout = 30000) {
    const mark = this.lines.length;
    this.send(line);
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this.lines.slice(mark).some((l) => (typeof expect === 'function' ? expect(l) : l === expect))) return true;
      await sleep(5);
    }
    return false;
  }
  async init() {
    if (!(await this.cmd('uci', 'uciok'))) throw new Error(`${'引擎未回应 uci'}`);
    await sleep(400);
    for (const [k, v] of Object.entries(this.opts)) {
      this.send(`setoption name ${k} value ${v}`);
      await sleep(15);
    }
    if (!(await this.cmd('isready', 'readyok'))) throw new Error('引擎未回应 isready');
  }
  async newGame() {
    this.send('ucinewgame');
    await this.cmd('isready', 'readyok', 60000);
  }
  async go(positionCmd, goCmd, timeout = 180000) {
    this.best = null;
    this.scoreCp = null;
    this.send(positionCmd);
    await this.cmd('isready', 'readyok', 60000);
    const t0 = Date.now();
    this.send(goCmd);
    while (!this.best && Date.now() - t0 < timeout) await sleep(4);
    if (!this.best) throw new Error('引擎超时未返回 bestmove');
    return this.best;
  }
  stop() { try { this.send('quit'); } catch { /* 已退出 */ } this.proc.kill(); }
}

/* ---------- 单局 ---------- */
/**
 * 下一局。返回 { result, plies, reason } —— result 从「A 方视角」看。
 */
async function playGame(a, b, goA, goB, opening, aColor) {
  ref.reset();
  const ucis = opening.slice();
  for (const u of opening) ref.playUci(u);

  for (let ply = 0; ply < MAXPLY; ply++) {
    const { legal, over, result } = ref.refresh();
    if (over) {
      if (result === 'mate') {
        const loser = ref.X.engineStm();               // 走不了棋又被将军的一方
        return { result: loser === aColor ? 'loss' : 'win', plies: ucis.length, reason: 'mate' };
      }
      return { result: 'draw', plies: ucis.length, reason: result };
    }
    if (!legal.length) return { result: 'draw', plies: ucis.length, reason: 'no-legal' };

    const isA = ref.X.engineStm() === aColor;
    const mover = isA ? a : b;
    const goCmd = isA ? goA : goB;
    const posCmd = ucis.length ? `position startpos moves ${ucis.join(' ')}` : 'position startpos';
    const uci = await mover.go(posCmd, goCmd);

    if (!legal.some((m) => m.uci === uci)) {
      // 非法着法判负(这本身也是强度信息)
      return { result: mover === a ? 'loss' : 'win', plies: ucis.length, reason: 'illegal:' + uci };
    }
    ref.playUci(uci);
    ucis.push(uci);
  }

  /* 步数上限:用 B 方浅层评估裁定(|cp|<150 记和) */
  const posCmd = `position startpos moves ${ucis.join(' ')}`;
  await b.go(posCmd, 'go depth 12');
  const cp = b.scoreCp ?? 0;
  const whitePov = ref.X.engineStm() === 0 ? cp : -cp;
  if (Math.abs(whitePov) < 150) return { result: 'draw', plies: ucis.length, reason: `adjudicate ${whitePov}cp` };
  const favored = whitePov > 0 ? 0 : 1;
  return { result: favored === aColor ? 'win' : 'loss', plies: ucis.length, reason: `adjudicate ${whitePov}cp` };
}

/* ---------- 主流程 ---------- */
const OPENINGS = [
  [],
  ['e2e4'],
  ['d2d4'],
  ['c2c4'],
  ['g2g3'],
  ['e2e4', 'e7e5'],
  ['d2d4', 'd7d5'],
  ['e2e4', 'c7c5'],
  ['d2d4', 'g8f6'],
  ['e2e4', 'e7e6'],
];

for (const s of [A, B]) {
  if (!QUIET) console.log(`${s.name} [${s.label}]`);
}
if (!QUIET) console.log('');

const a = new UciEngine(A.path, A.opts);
await a.init();
const b = new UciEngine(B.path, B.opts);
await b.init();

/* 任务表:每个开局 × 两种执色;按 shard 切片 */
const [si, sn] = SHARD.split('/').map(Number);
const games = [];
for (const o of OPENINGS.slice(0, Math.max(1, Math.ceil(GAMES / 2)))) {
  for (const aColor of [0, 1]) games.push({ opening: o, aColor });
}
const mine = games.filter((_, i) => i % sn === si);

const results = [];
for (const g of mine) {
  await a.newGame();
  await b.newGame();
  const r = await playGame(a, b, A.go, B.go, g.opening, g.aColor);
  results.push({ ...g, ...r });
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ a: A.name, b: B.name, partial: true, results }));
  if (!QUIET) {
    const tag = r.result === 'win' ? 'A胜' : r.result === 'loss' ? 'B胜' : '和';
    console.log(`${(g.opening.join(' ') || '(初始)').padEnd(14)} A${g.aColor === 0 ? '白' : '黑'} ${tag}  ${String(r.plies).padStart(3)}手  ${r.reason}`);
  }
}
a.stop();
b.stop();

/* 汇总 */
const n = results.length;
const aw = results.filter((r) => r.result === 'win').length;
const dr = results.filter((r) => r.result === 'draw').length;
const score = (aw + dr / 2) / n;
const elo = (s) => (s <= 0 ? '<-800' : s >= 1 ? '>+800' : ((s >= 0.5 ? '+' : '') + (-400 * Math.log10(1 / s - 1)).toFixed(0)));
if (!QUIET) {
  console.log('\n局  A胜  和  B胜   A 得分率    Elo 差(A 视角)');
  console.log(`${String(n).padStart(3)} ${String(aw).padStart(4)} ${String(dr).padStart(4)} ${String(n - aw - dr).padStart(4)}   ${(score * 100).toFixed(1).padStart(6)}%   ${elo(score).padStart(7)}`);
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ a: A.name, b: B.name, results, score }, null, 2));
process.exit(0);
