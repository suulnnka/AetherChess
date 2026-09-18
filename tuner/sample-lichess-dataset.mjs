// 从 database.lichess.org 官方评估库(CC0)抽样,生成 HCE 调参用的 train/val JSONL。
// 该库是单文件流(lichess_db_eval.jsonl.zst,~22GB 压缩 / ~129GB 文本,~2.26 亿条),
// 不可随机访问,因此:7z 流式解压 → 逐行轻扫描(只取 FEN 和棋子数,不解析 evals)
// → 按相位配额做水库抽样 → 选中行(~39 万)才 JSON.parse 提取标签。
//
// 用法:
//   node sample-lichess-dataset.mjs --zst <lichess_db_eval.jsonl.zst> [--out data] [--min-scan-gb 6]
// 下载(断点续传,直连 database.lichess.org 可用):
//   curl -C - -o lichess_db_eval.jsonl.zst https://database.lichess.org/lichess_db_eval.jsonl.zst
// 解压依赖 7-Zip(7z x -so);无需其他依赖。
//
// 记录格式(官方):{"fen":"<4字段FEN,无回合计数器>","evals":[{"pvs":[{"cp":N|"mate":N,"line":"e2e4 ..."}],"knodes":N,"depth":N},...]}
// 选标签规则(官方 README):取 depth 最高的 eval,用其第一条 PV;只保留 depth>=20 的记录。
// 视角自检:用 sign(cp) 与子力差的符合度判断标签是白方视角还是行棋方视角,统一归一到白方视角。
// 许可:CC0(https://database.lichess.org,整站声明)。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const zstPath = path.resolve(opt('zst', path.join(process.env.TEMP ?? '/tmp', 'lich', 'lichess_db_eval.jsonl.zst')));
const outDir = path.resolve(opt('out', path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'data')));
const MIN_SCAN_BYTES = Number(opt('min-scan-gb', 6)) * 1024 ** 3;
const VAL_N = 30_000;
const SEED = 20260918;

// 相位桶(按全场棋子数,含王):配额目标与水库容量(×1.15 超采,给 depth>=20 过滤留余量)
const BUCKETS = [
  { name: '25-32子', min: 25, max: 32, target: 100_000 },
  { name: '17-24子', min: 17, max: 24, target: 130_000 },
  { name: '10-16子', min: 10, max: 16, target: 75_000 },
  { name: '5-9子', min: 5, max: 9, target: 26_000 },
  { name: '2-4子', min: 2, max: 4, target: 6_000 },
];
for (const b of BUCKETS) { b.cap = Math.ceil(b.target * 1.15); b.seen = 0; b.kept = []; }

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);

function bucketOf(pieces) {
  return BUCKETS.find(b => pieces >= b.min && pieces <= b.max) ?? null;
}

// 轻量 FEN 提取:行前缀固定为 {"fen":"<FEN>",... ,FEN 无转义字符,indexOf 安全
function fenOf(line) {
  if (!line.startsWith('{"fen":"')) return null;
  const end = line.indexOf('"', 8);
  return end < 0 ? null : line.slice(8, end);
}
function piecesOf(fen) {
  let n = 0;
  const board = fen.slice(0, fen.indexOf(' '));
  for (let i = 0; i < board.length; i++) {
    const c = board.charCodeAt(i);
    if ((c > 64 && c < 91) || (c > 96 && c < 123)) n++;
  }
  return n;
}

// —— 第一阶段:流式扫描 + 相位配额水库 ——
async function scan() {
  if (!fs.existsSync(zstPath)) throw new Error(`找不到 ${zstPath},先用 curl -C - 下载`);
  const t0 = Date.now();
  const child = spawn('7z', ['x', '-so', zstPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  let pending = Buffer.alloc(0);
  let bytes = 0, lines = 0, badFen = 0;
  let lastLog = 0;

  const feed = (chunk) => {
    bytes += chunk.length;
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let start = 0, nl;
    while ((nl = pending.indexOf(10, start)) >= 0) {
      const line = pending.subarray(start, nl);
      start = nl + 1;
      if (line.length < 20) continue;
      lines++;
      // FEN(含结尾引号)一定落在行头 110 字节内;只解码头部,不为整行建字符串
      const fen = fenOf(line.toString('latin1', 0, Math.min(line.length, 110)));
      if (!fen) { badFen++; continue; }
      const b = bucketOf(piecesOf(fen));
      if (!b) continue;
      b.seen++;
      // 选中行必须拷贝副本:subarray 会 pin 住整个 64KB chunk(OOM 教训)
      const copy = () => Buffer.from(line);
      if (b.kept.length < b.cap) b.kept.push(copy());
      else if (bytes < MIN_SCAN_BYTES) {
        const j = Math.floor(rng() * b.seen);
        if (j < b.cap) b.kept[j] = copy();
      }
    }
    pending = pending.subarray(start);
    if (bytes - lastLog > 2 ** 30) {
      lastLog = bytes;
      const min = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`[scan] ${(bytes / 2 ** 30).toFixed(1)}GiB ${lines / 1e6}M行 坏行${badFen} 池:${BUCKETS.map(b => b.kept.length / 1000 | 0).join('/')}k(${min}min)`);
    }
  };

  for await (const chunk of child.stdout) feed(chunk);
  const done = new Promise((res, rej) => { child.on('close', c => c === 0 ? res() : rej(new Error(`7z 退出码 ${c}(文件不完整?)`))); });
  await done;
  console.log(`[scan] 完成:${(bytes / 2 ** 30).toFixed(1)}GiB ${lines / 1e6}M行,池内 ${BUCKETS.reduce((a, b) => a + b.kept.length, 0) / 1000 | 0}k 条,用时 ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

await scan();

// —— 第二阶段:对池内行 JSON.parse,取 depth 最高的 eval 首 PV ——
const seenFen = new Set();
const rows = [];
let noEval = 0, lowDepth = 0, dup = 0, mateN = 0, cpN = 0;
const depthHist = [];
let agree = 0, known = 0; // POV 自检:sign(label) vs sign(白方子力差)
for (const b of BUCKETS) {
  for (const line of b.kept) {
    let rec;
    try { rec = JSON.parse(line.toString('utf8')); } catch { noEval++; continue; }
    const fen = rec.fen;
    if (seenFen.has(fen)) { dup++; continue; }
    seenFen.add(fen);
    const evals = rec.evals;
    if (!Array.isArray(evals) || evals.length === 0) { noEval++; continue; }
    let best = null;
    for (const e of evals) if (e && e.depth >= (best?.depth ?? -1)) best = e; // 并列取后一个(更多 PV)
    if (!best || !best.pvs || best.pvs.length === 0) { noEval++; continue; }
    if (best.depth < 20) { lowDepth++; continue; }
    const pv = best.pvs[0];
    const row = { fen, d: best.depth, kn: best.knodes ?? 0 };
    if (pv.mate !== undefined) { row.mate = pv.mate; mateN++; }
    else if (typeof pv.cp === 'number') { row.cp = pv.cp; cpN++; }
    else { noEval++; continue; }
    // POV 自检:只在"明显局面"(|cp|>=300 且 |子力差|>=2)上判,战术位子力差不说明视角
    if (row.cp !== undefined) {
      const parts = fen.split(' ');
      if (parts.length >= 4 && /^[wb]$/.test(parts[1]) && Math.abs(row.cp) >= 300) {
        let mb = 0;
        for (const c of parts[0]) {
          const v = { p: 1, n: 3, b: 3, r: 5, q: 9 }[c.toLowerCase()];
          if (v) mb += c === c.toUpperCase() ? v : -v;
        }
        if (Math.abs(mb) >= 2) { known++; if (Math.sign(row.cp) === Math.sign(mb)) agree++; }
      }
    }
    row.b = b.name;
    rows.push(row);
    depthHist.push(best.depth);
  }
}
const povShare = known ? agree / known : 0;
const stmPov = povShare < 0.4; // 与子力差几乎反号 → 标签是行棋方视角
console.log(`[标签] 有效 ${rows.length} cp=${cpN} mate=${mateN} | 无评估${noEval} 低深度(<20)${lowDepth} 重复FEN${dup}`);
console.log(`[视角] sign(标签)≈sign(白方子力差) ${(povShare * 100).toFixed(1)}%(n=${known}) → 判定为${stmPov ? '行棋方视角,已归一到白方' : '白方视角,无需翻转'}`);
if (stmPov) {
  for (const r of rows) {
    const stm = r.fen.split(' ')[1];
    if (stm === 'b') { if (r.cp !== undefined) r.cp = -r.cp; else r.mate = -r.mate; }
  }
}
depthHist.sort((a, b) => a - b);
const pct = q => depthHist[Math.floor(q * depthHist.length)];
console.log(`[深度] p10=${pct(.1)} p50=${pct(.5)} p90=${pct(.9)}`);

// —— 每桶截到配额 → 合并洗牌 → 切 val ——
const finalRows = [];
for (const b of BUCKETS) {
  const pool = rows.filter(r => r.b === b.name);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  if (pool.length < b.target) console.warn(`[配额] ${b.name} 只有 ${pool.length}/${b.target}(源里该相位偏少)`);
  finalRows.push(...pool.slice(0, b.target));
}
for (let i = finalRows.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [finalRows[i], finalRows[j]] = [finalRows[j], finalRows[i]];
}
const val = finalRows.slice(0, VAL_N);
const train = finalRows.slice(VAL_N);

fs.mkdirSync(outDir, { recursive: true });
const writeJsonl = (name, list) => {
  const body = list.map(({ b, ...r }) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, name), body);
  return Buffer.byteLength(body);
};
const tb = writeJsonl('train.jsonl', train);
const vb = writeJsonl('val.jsonl', val);

console.log(`\n[输出] train=${train.length}(${(tb / 1e6).toFixed(1)}MB) + val=${val.length}(${(vb / 1e6).toFixed(1)}MB) → ${outDir}`);
const mix = {};
for (const r of finalRows) mix[r.b] = (mix[r.b] ?? 0) + 1;
console.log(`[相位]`, Object.entries(mix).map(([k, v]) => `${k}=${(100 * v / finalRows.length).toFixed(1)}%`).join('  '));
