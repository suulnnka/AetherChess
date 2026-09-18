#!/usr/bin/env node
/* ============================================================
 * 对弈基准:把本引擎当选手,和外部 UCI 引擎打对抗赛,换算 Elo 差。
 *
 * 为什么需要它:perft / 战术单测只能证明"规则对、战术能看穿",
 * 证明不了"棋力有多强"。唯一能给出强度数字的办法是对弈。
 *
 * 对手侧:任何 UCI 引擎都行,默认用 stockfish@10 的 JS 构建
 *   (npmmirror 上 0.38MB tarball,wasm 版约 40~58 万 NPS,与本引擎同量级),
 *   通过 `go depth N` 限制强度 —— Stockfish 每加深一层大约 +50~70 Elo,
 *   所以「在哪个深度上打成 50%」就能反推我们的强度。
 *   用 `--sf <路径>` 指定别的引擎(如本机原生 Stockfish)。
 *
 * 两侧都用「确定性预算」而不是墙钟时间(本引擎给节点数,Stockfish 给深度),
 * 所以每个对局都是可复现的 —— 也正因此可以用 --shard 分片并行跑而不影响结果。
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

import {
  WHITE, BLACK, QUEEN, NAME,
  mFrom, mTo, mPromo,
  newPos, make, genLegal, hasLegalMove, inCheck,
  isThreefold, insufficientMaterial, replayMoves,
} from '../src/rules.js';
import { searchBest, LEVELS } from '../src/ai.js';

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

/** 默认对手:优先 tools/vendor 下自备的引擎,其次 node_modules 里的 native 版,最后 PATH。
 *  仓库里**不**附带任何第三方引擎二进制 —— 要跑基准得先自己下一份,见下面的报错提示。 */
function defaultSfPath() {
  const cands = [
    path.join(VENDOR, 'stockfish', 'src', 'stockfish.js'),   // `npm pack stockfish@10 && tar -xzf` 解开后的位置
    path.join(VENDOR, 'stockfish', 'stockfish.js'),
    path.join(VENDOR, 'stockfish.js'),
    './node_modules/.bin/stockfish.exe',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return 'stockfish';     // 都没有就赌 PATH,由下面的检查决定是否可用
}

/** 回落到 PATH 的情况下,先探一下 `stockfish` 是不是真的起得来,
 *  免得等到 spawn 抛一个 ENOENT 出来(那个报错对使用者毫无指导意义)。 */
function pathStockfishUsable() {
  try { return !spawnSync('stockfish', ['--help'], { timeout: 8000, stdio: 'ignore' }).error; }
  catch { return false; }
}
const SF_MISSING = SF_PATH === 'stockfish' ? !pathStockfishUsable() : !fs.existsSync(SF_PATH);

/* ---------- 走法编码:引擎打包格式 ↔ UCI 串 ---------- */
const PROMO_CH = { 2: 'n', 3: 'b', 4: 'r', 5: 'q' };
const toUci = (m) => NAME(mFrom(m)) + NAME(mTo(m)) + (mPromo(m) ? PROMO_CH[mPromo(m)] : '');

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
/** UCI 串序列 → 引擎局面 + 线格式序列((from<<6)|to) */
function setupFrom(ucis) {
  const pos = newPos();
  const wire = [];
  for (const u of ucis) {
    const m = uciToPacked(pos, u);
    if (!m) throw new Error('无法解析开局走法: ' + u);
    make(pos, m);
    wire.push((mFrom(m) << 6) | mTo(m));
  }
  return { pos, wire };
}

/* ---------- Stockfish 驱动 ----------
 * 两条踩过的坑:
 *  1. `setoption name Threads value 1` 会把 nmrugg 的 Stockfish.js 10 **整个卡死**
 *     (该构建是单线程 emscripten 产物,设置线程数会去初始化线程池然后挂住,
 *     表现是后续 isready / go 全部再无回应)。所以只设真正需要的选项。
 *  2. emscripten 运行时是异步加载完的:发完 `uci` 拿到 `uciok` 之后还要再等一会儿,
 *     否则紧接着灌进去的 setoption / isready 会被丢掉。 */
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
  /** 发一条命令并等某个应答行出现 */
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
    await sleep(400);            // emscripten 运行时是异步加载完的,这之前灌进去的命令会被丢掉
    for (const [k, v] of Object.entries(this.opts)) {
      this.send(`setoption name ${k} value ${v}`);
      await sleep(15);
    }
    if (!(await this.cmd('isready', 'readyok'))) throw new Error('对手未回应 isready');
  }
  /** 开局清空:uci 规范只要求引擎自己清状态,不要求回 readyok,
   *  所以这里用 isready/readyok 当同步屏障(Wasabi 就不回 ucinewgame)。 */
  async newGame() {
    this.send('ucinewgame');
    await this.cmd('isready', 'readyok', 60000);
  }
  /** 让对手按 `goCmd` 走一步,返回 UCI 串(顺便把评估分记下来,供裁定用)。
   *  position 之后用 isready/readyok 做屏障,确保引擎已消化完局面再收 go ——
   *  直接 sleep 一个固定时间是靠不住的(Wasabi 首次搜索前的首个 go 会被吞掉)。 */
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
const MATE_CP = 25000;

function terminalReason(pos) {
  const buf = new Int32Array(256);
  if (!hasLegalMove(pos, buf)) return inCheck(pos) ? 'mate' : 'stalemate';
  if (insufficientMaterial(pos)) return 'material';
  if (isThreefold(pos)) return 'threefold';
  if (pos.half >= 100) return 'fiftymove';
  return null;
}

/**
 * 下一局。ourColor 是本引擎执的颜色。
 * 返回 { result, plies, reason, avgDepth } —— result 从「本引擎视角」看:win / loss / draw
 */
async function playGame(sf, ourCfg, opening, ourColor, sfDepth) {
  const { pos } = setupFrom(opening);
  const ucis = opening.slice();
  const depths = [];

  for (let ply = 0; ply < MAXPLY; ply++) {
    const term = terminalReason(pos);
    if (term) {
      if (term === 'mate') {
        const loser = pos.stm;                      // 走不了棋又被将军的一方是被将死
        return { result: loser === ourColor ? 'loss' : 'win', plies: ucis.length, reason: 'mate' };
      }
      return { result: 'draw', plies: ucis.length, reason: term };
    }

    const mover = pos.stm;
    let uci;
    if (mover === ourColor) {
      const r = searchBest(pos, ourCfg);
      if (!r.move) return { result: 'draw', plies: ucis.length, reason: 'no-move' };
      uci = toUci(r.move);
      depths.push(r.depth);
    } else {
      const posCmd = ucis.length ? `position startpos moves ${ucis.join(' ')}` : 'position startpos';
      uci = await sf.go(posCmd, `go depth ${sfDepth}`);
    }

    const m = uciToPacked(pos, uci);
    if (!m) return { result: mover === ourColor ? 'loss' : 'win', plies: ucis.length, reason: 'illegal-by-' + (mover === ourColor ? 'us' : 'sf') };
    make(pos, m);
    ucis.push(uci);
  }

  /* 步数上限:用对手的浅层评估裁定。
   * 不这么做的话,大量其实已分出胜负的长局会被算成和棋,把得分率压向 50%。 */
  const posCmd = `position startpos moves ${ucis.join(' ')}`;
  await sf.go(posCmd, 'go depth 12');
  const cp = sf.scoreCp ?? 0;
  const whitePov = pos.stm === WHITE ? cp : -cp;
  const avg = depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : 0;
  if (Math.abs(whitePov) < 150) return { result: 'draw', plies: ucis.length, reason: `adjudicate ${whitePov}cp`, avgDepth: avg };
  const favored = whitePov > 0 ? WHITE : BLACK;
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

function ourConfig(levelId) {
  const lv = LEVELS.find((l) => l.id === levelId);
  if (!lv) throw new Error('未知难度: ' + levelId + '(可选 ' + LEVELS.map((l) => l.id).join('/') + ')');
  return { nodes: lv.nodes, ms: lv.ms, depth: lv.depth };
}

function eloFromScore(s) {
  if (s <= 0) return -Infinity;
  if (s >= 1) return Infinity;
  return -400 * Math.log10(1 / s - 1);
}
const fmtElo = (e) => !isFinite(e) ? (e > 0 ? '>+800' : '<-800') : (e >= 0 ? '+' : '') + e.toFixed(0);

if (!QUIET) console.log(`本引擎: ${LEVEL}(${JSON.stringify(ourConfig(LEVEL))})   对手: ${SF_PATH}\n`);

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

/* 传给对手的 UCI 选项。默认给 Stockfish 拉满实力;换别的引擎(如 Wasabi)用
 * `--sf-opt none` 或 `--sf-opt Hash=64;OwnBook=false` 覆盖。 */
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
    for (const ourColor of [WHITE, BLACK]) games.push({ depth: d, opening: o, ourColor });
  }
}
const mine = games.filter((_, i) => i % sn === si);

const results = [];
for (const g of mine) {
  await sf.newGame();
  const r = await playGame(sf, ourConfig(LEVEL), g.opening, g.ourColor, g.depth);
  results.push({ ...g, ...r });
  // 每局落盘一次:长跑里进程被中断也不会丢掉已经跑出来的部分
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ level: LEVEL, sfPath: SF_PATH, partial: true, results }));
  if (!QUIET) {
    const tag = r.result === 'win' ? '胜' : r.result === 'loss' ? '负' : '和';
    console.log(`d${String(g.depth).padStart(2)} ${(g.ourColor === WHITE ? '白' : '黑')} ${(g.opening.join(' ') || '(初始)').padEnd(14)} ${tag}  ${String(r.plies).padStart(3)}手  ${r.reason}`);
  }
}
sf.stop();

/* 汇总 */
const byDepth = {};
for (const r of results) {
  const b = byDepth[r.depth] ||= { w: 0, l: 0, d: 0, n: 0 };
  b.n++; if (r.result === 'win') b.w++; else if (r.result === 'loss') b.l++; else b.d++;
}
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
