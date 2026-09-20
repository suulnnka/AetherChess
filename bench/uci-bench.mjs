#!/usr/bin/env node
/* ============================================================
 * 对弈基准:把本引擎(wasm)当选手,和外部 UCI 引擎打对抗赛,换算 Elo 差。
 *
 * JS 参照实现移除后,本引擎一侧与棋规裁判全走 wasm(见 bench/referee.mjs)。
 * 对手侧:任何 UCI 引擎都行,默认找 stockfish@10 的 JS 构建(自备到
 * bench/vendor/),用 `go depth N` 限制强度 —— 「在哪个深度上打成 50%」
 * 就能反推我们的强度。
 *
 * 两侧都用「确定性预算」(本引擎节点数,对手深度),每局可复现,可分片并行。
 *
 * 用法:
 *   node bench/uci-bench.mjs --depth 5               # 和 depth 5 的 Stockfish 打
 *   node bench/uci-bench.mjs --depth 3,5,7 --games 4 # 扫一档
 *   node bench/uci-bench.mjs --shard 0/4 --out a.json
 *   node bench/uci-bench.mjs --level master --depth 8
 *   node bench/uci-bench.mjs --sf /path/to/engine --sf-opt none --depth 6,8
 * ============================================================ */
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createEngine } from './referee.mjs';

/** 自备对手引擎的存放目录(gitignore 掉了,不进仓库) */
const VENDOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor');

/* ---------- CLI ---------- */
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const DEPTHS = argOf('--depth', '5').split(',').map(Number);
const GAMES = Number(argOf('--games', '4'));         // 每个深度打几局(必须是偶数,黑白各半)
const MAXPLY = Number(argOf('--maxply', '160'));
const LEVEL = argOf('--level', 'hard');
const SF_PATH = argOf('--sf', process.env.SF_PATH || defaultSfPath());
const OUT = argOf('--out', '');
const SHARD = argOf('--shard', '0/1');
const QUIET = argv.includes('--quiet');

/** 默认对手:优先 bench/vendor 下自备的引擎,其次 PATH。仓库不附带第三方引擎。 */
function defaultSfPath() {
  const cands = [
    path.join(VENDOR, 'stockfish', 'src', 'stockfish.js'),   // `npm pack stockfish@10 && tar -xzf` 解开后的位置
    path.join(VENDOR, 'stockfish', 'stockfish.js'),
    path.join(VENDOR, 'stockfish.js'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return 'stockfish';     // 都没有就赌 PATH,由下面的检查决定是否可用
}

/** 回落到 PATH 的情况下,先探一下 `stockfish` 是不是真的起得来。 */
function pathStockfishUsable() {
  try { return !spawnSync('stockfish', ['--help'], { timeout: 8000, stdio: 'ignore' }).error; }
  catch { return false; }
}
const SF_MISSING = SF_PATH === 'stockfish' ? !pathStockfishUsable() : !fs.existsSync(SF_PATH);

/* ---------- 本引擎(wasm)---------- */
const we = await createEngine();

/* ---------- Stockfish 驱动 ----------
 * 两条踩过的坑:
 *  1. `setoption name Threads value 1` 会把 nmrugg 的 Stockfish.js 10 整个卡死
 *     (单线程 emscripten 产物,设线程数会初始化线程池然后挂住)。只设真正需要的选项。
 *  2. emscripten 运行时异步加载:发完 `uci` 拿到 uciok 后还要再等一会儿,
 *     否则紧接着的 setoption / isready 会被丢掉。 */
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
    if (!(await this.cmd('uci', 'uciok'))) throw new Error('对手未回应 uci');
    await sleep(400);            // emscripten 运行时是异步加载完的,这之前灌的命令会被丢掉
    for (const [k, v] of Object.entries(this.opts)) {
      this.send(`setoption name ${k} value ${v}`);
      await sleep(15);
    }
    if (!(await this.cmd('isready', 'readyok'))) throw new Error('对手未回应 isready');
  }
  async newGame() {
    this.send('ucinewgame');
    await this.cmd('isready', 'readyok', 60000);
  }
  /** position 后用 isready/readyok 做屏障,确保引擎已消化完局面再收 go */
  async go(positionCmd, goCmd, timeout = 180000) {
    this.best = null;
    this.scoreCp = null;
    this.send(positionCmd);
    await this.cmd('isready', 'readyok', 60000);
    const t0 = Date.now();
    this.send(goCmd);
    while (!this.best && Date.now() - t0 < timeout) await sleep(4);
    if (!this.best) throw new Error('对手超时未返回 bestmove');
    return this.best;
  }
  stop() { try { this.send('quit'); } catch { /* 已退出 */ } this.proc.kill(); }
}

/* ---------- 单局对局 ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 下一局。ourColor 0=白 1=黑,是本引擎执的颜色。
 * 返回 { result, plies, reason, avgDepth } —— result 从「本引擎视角」看
 */
async function playGame(sf, levelId, opening, ourColor, sfDepth) {
  we.reset();
  const ucis = opening.slice();
  for (const u of opening) we.playUci(u);

  for (let ply = 0; ply < MAXPLY; ply++) {
    const { legal, over, result } = we.refresh();
    if (over) {
      if (result === 'mate') {
        const loser = we.X.engineStm();
        return { result: loser === ourColor ? 'loss' : 'win', plies: ucis.length, reason: 'mate', avgDepth: we.ourAvgDepth() };
      }
      return { result: 'draw', plies: ucis.length, reason: result, avgDepth: we.ourAvgDepth() };
    }
    if (!legal.length) return { result: 'draw', plies: ucis.length, reason: 'no-legal', avgDepth: we.ourAvgDepth() };

    let uci;
    if (we.X.engineStm() === ourColor) {
      uci = we.think(levelId, 1);
      if (!uci) return { result: 'draw', plies: ucis.length, reason: 'no-move', avgDepth: we.ourAvgDepth() };
    } else {
      const posCmd = ucis.length ? `position startpos moves ${ucis.join(' ')}` : 'position startpos';
      uci = await sf.go(posCmd, `go depth ${sfDepth}`);
    }

    if (!legal.some((m) => m.uci === uci)) {
      // 对手给了非法着法 —— 直接判它输(这本身也是强度信息)
      return { result: we.X.engineStm() === ourColor ? 'win' : 'loss', plies: ucis.length, reason: 'illegal-by-sf:' + uci, avgDepth: we.ourAvgDepth() };
    }
    we.playUci(uci);
    ucis.push(uci);
  }

  /* 步数上限:用对手的浅层评估裁定,长局不致一律算和。 */
  const posCmd = `position startpos moves ${ucis.join(' ')}`;
  await sf.go(posCmd, 'go depth 12');
  const cp = sf.scoreCp ?? 0;
  const whitePov = we.X.engineStm() === 0 ? cp : -cp;
  const avg = we.ourAvgDepth();
  if (Math.abs(whitePov) < 150) return { result: 'draw', plies: ucis.length, reason: `adjudicate ${whitePov}cp`, avgDepth: avg };
  const favored = whitePov > 0 ? 0 : 1;
  return { result: favored === ourColor ? 'win' : 'loss', plies: ucis.length, reason: `adjudicate ${whitePov}cp`, avgDepth: avg };
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

if (!QUIET) console.log(`本引擎: wasm ${LEVEL}(nodes ${we.LEVELS[LEVEL].nodes})   对手: ${SF_PATH}\n`);

if (SF_MISSING) {
  console.error(`✗ 找不到可用的对手引擎(解析结果: ${SF_PATH})\n`);
  console.error('  仓库里不附带第三方引擎,先自己下一份放到 bench/vendor/(已 gitignore):');
  console.error('');
  console.error('    # Stockfish 10 的 JS 构建(0.38MB,单线程,和本引擎同量级,最省事)');
  console.error('    npm pack stockfish@10.0.2 && mkdir -p bench/vendor/stockfish && \\');
  console.error('      tar -xzf stockfish-10.0.2.tgz -C bench/vendor/stockfish --strip-components=1');
  console.error('    # 之后默认就会用 bench/vendor/stockfish/src/stockfish.js');
  console.error('');
  console.error('  也可以用本机原生引擎:  --sf /path/to/stockfish   (或环境变量 SF_PATH)');
  process.exit(2);
}

/* 传给对手的 UCI 选项。默认拉满;换别的引擎用 `--sf-opt none` 覆盖。 */
const SF_OPT = argOf('--sf-opt', 'Skill Level=20');
const sfOpts = {};
if (SF_OPT !== 'none') {
  for (const kv of SF_OPT.split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) sfOpts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
}
const sf = new UciEngine(SF_PATH, sfOpts);   // 千万不要设 Threads,见上面第 1 条
await sf.init();

/* 任务表:每个深度 × 每个开局 × 两种执色;按 shard 切片 */
const [si, sn] = SHARD.split('/').map(Number);
const games = [];
for (const d of DEPTHS) {
  for (const o of OPENINGS.slice(0, Math.max(1, Math.ceil(GAMES / 2)))) {
    for (const ourColor of [0, 1]) games.push({ depth: d, opening: o, ourColor });
  }
}
const mine = games.filter((_, i) => i % sn === si);

const results = [];
for (const g of mine) {
  await sf.newGame();
  const r = await playGame(sf, LEVEL, g.opening, g.ourColor, g.depth);
  results.push({ ...g, ...r });
  // 每局落盘一次:长跑里进程被中断也不会丢掉已经跑出来的部分
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ level: LEVEL, sfPath: SF_PATH, partial: true, results }));
  if (!QUIET) {
    const tag = r.result === 'win' ? '胜' : r.result === 'loss' ? '负' : '和';
    console.log(`d${String(g.depth).padStart(2)} ${(g.ourColor === 0 ? '白' : '黑')} ${(g.opening.join(' ') || '(初始)').padEnd(14)} ${tag}  ${String(r.plies).padStart(3)}手  ${r.reason}`);
  }
}
sf.stop();

/* 汇总 */
const byDepth = {};
for (const r of results) {
  const b = byDepth[r.depth] ||= { w: 0, l: 0, d: 0, n: 0 };
  b.n++; if (r.result === 'win') b.w++; else if (r.result === 'loss') b.l++; else b.d++;
}
const eloFromScore = (s) => (s <= 0 ? -Infinity : s >= 1 ? Infinity : -400 * Math.log10(1 / s - 1));
const fmtElo = (e) => !isFinite(e) ? (e > 0 ? '>+800' : '<-800') : (e >= 0 ? '+' : '') + e.toFixed(0);

const summary = Object.entries(byDepth).sort((a, b) => a[0] - b[0]).map(([d, b]) => {
  const s = (b.w + b.d / 2) / b.n;
  return { depth: Number(d), ...b, score: s, elo: eloFromScore(s) };
});

if (!QUIET) {
  console.log('\n深度   局  胜  和  负   得分率    对 depth-N Stockfish 的 Elo 差');
  for (const s of summary) {
    console.log(`${String(s.depth).padStart(3)}  ${String(s.n).padStart(3)} ${String(s.w).padStart(3)} ${String(s.d).padStart(3)} ${String(s.l).padStart(3)}   ${(s.score * 100).toFixed(1).padStart(5)}%   ${fmtElo(s.elo).padStart(7)}`);
  }
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ level: LEVEL, sfPath: SF_PATH, results, summary }, null, 2));
process.exit(0);
