// 从 ssingh22/chess-evaluations(MIT,parquet 转载自 Kaggle chessData.csv)随机抽样,
// 生成 HCE 调参用的 train/val JSONL。全库 12.95M + 2.63M 行,按回合数排序;
// 本引擎待调参数 <1000,按每参数 ~300 局面抽 33 万足够,不需要全量。
//
// 用法:node tuner/sample-dataset.mjs [--cache <dir>]
//   parquet 会先下到 cache 目录(默认 %TEMP%/hfcheck),已存在则直接复用;
//   抽样完成后可整目录删除,数据以 tuner/data/ 为准。
//
// 来源与许可:
//   evals_large shard0/1  FEN+Evaluation  12,954,834 行(MIT)
//   tactics shard         FEN+Evaluation+Move  2,628,219 行(MIT)
//   randoms 未采用:标签明显更噪(p50 13cp 但均值 587cp)。
// huggingface.co 直连不通,走 hf-mirror.com(resolve 返回 302 → 需跟随重定向)。
//
// 标签解析(实测全库 100% 可解析):
//   "+56" / "-10"      → cp = 56 / -10(白方视角,拟合时按行棋方翻转)
//   "#+3" / "#-3"      → mate = ±3
// FEN 为完整 6 字段(与 lichess 官方 evals 库的 4 字段不同)。

import { parquetRead, parquetMetadataAsync } from 'hyparquet';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SEED = 20260918;
const MIRROR = 'https://hf-mirror.com';
const REPO = 'ssingh22/chess-evaluations';

// 每个来源抽多少行;val 从混合洗牌后的头部切出
const VAL_N = 30_000;
const SOURCES = [
  { name: 'evals_large0', file: 'evals_large/train-00000-of-00002-119fbadcb4be60b9.parquet', sample: 133_000, sid: 0 },
  { name: 'evals_large1', file: 'evals_large/train-00001-of-00002-a738746a2902a63d.parquet', sample: 168_000, sid: 1 },
  { name: 'tactics', file: 'tactics/train-00000-of-00001-87e7d058f638f8f3.parquet', sample: 36_000, sid: 2 },
];

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'data');
const cacheDir = process.argv.includes('--cache')
  ? path.resolve(process.argv[process.argv.indexOf('--cache') + 1])
  : path.join(os.tmpdir(), 'hfcheck');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

// mulberry32:固定种子,重跑同一份 parquet 得到完全相同的数据集
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);

async function ensureParquet(source) {
  const local = path.join(cacheDir, path.basename(source.file));
  const alias = path.join(cacheDir, `${source.name}.parquet`);
  for (const f of [local, alias]) {
    if (fs.existsSync(f) && fs.statSync(f).size > 1e6) return f;
  }
  const url = `${MIRROR}/datasets/${REPO}/resolve/main/${source.file}`;
  console.log(`下载 ${url}`);
  const res = await fetch(url); // fetch 默认跟随 302 到 cas-bridge.xethub.hf.co
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(local, buf);
  return local;
}

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function parseEval(raw) {
  const s = String(raw);
  const m = /^#([+-]?)(\d+)$/.exec(s);
  if (m) return { mate: (m[1] === '-' ? -1 : 1) * Number(m[2]) };
  const cp = parseFloat(s.startsWith('+') ? s.slice(1) : s);
  return Number.isFinite(cp) ? { cp } : null;
}

// 轻量 FEN 校验 + 棋子计数(不做着法验证,那不是抽样阶段的事)
function parseFen(fen) {
  const p = fen.split(' ');
  if (p.length < 4 || !/^[wb]$/.test(p[1])) return null;
  const ranks = p[0].split('/');
  if (ranks.length !== 8) return null;
  let pieces = 0;
  for (const r of ranks) {
    if ([...r].reduce((a, c) => a + (/\d/.test(c) ? +c : 1), 0) !== 8) return null;
    pieces += [...r].filter(c => /\D/.test(c)).length;
  }
  return { stm: p[1], pieces, moveNo: p.length >= 6 ? Number(p[5]) : null };
}

function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

async function sampleSource(src) {
  const local = await ensureParquet(src);
  const rowsAll = [];
  let meta;
  {
    const b = fs.readFileSync(local);
    meta = await parquetMetadataAsync(toArrayBuffer(b));
  }
  const nGroups = meta.row_groups.length;
  const rowsPerGroup = Number(meta.row_groups[0].num_rows);
  const totalRows = nGroups * rowsPerGroup;
  const wantGroups = Math.ceil(src.sample / rowsPerGroup * 1.04);

  // 随机选不重复的 row group(分组内 1000 行同相位,组间打乱相位覆盖)
  const idx = Array.from({ length: nGroups }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const chosen = idx.slice(0, wantGroups);

  const file = toArrayBuffer(fs.readFileSync(local));
  let read = 0;
  for (const g of chosen) {
    const rows = await new Promise((res, rej) =>
      parquetRead({
        file,
        rowStart: g * rowsPerGroup,
        rowEnd: (g + 1) * rowsPerGroup,
        rowFormat: 'object',
        onComplete: res,
      }).catch?.(rej));
    for (const r of rows) {
      const fen = r.FEN ?? r.fen;
      const ev = parseEval(r.Evaluation ?? r.evaluation ?? r.eval);
      const pf = parseFen(fen);
      if (!ev || !pf) continue;
      rowsAll.push({ fen, ...ev, ...pf, s: src.sid });
      read++;
    }
  }
  // 组内全收,抽样在全局洗牌时统一做:超采 ~4%,洗牌后截断
  return { rows: rowsAll, want: src.sample, read, totalRows, nGroups };
}

const collected = [];
for (const src of SOURCES) {
  const { rows, read, totalRows } = await sampleSource(src);
  console.log(`${src.name}: 全库 ${totalRows.toLocaleString()} 行 → 解析有效 ${read.toLocaleString()} 行`);
  for (const r of rows) collected.push(r); // 十万元素级数组不能用 spread push(会爆调用栈)
}

// 去重 → 洗牌 → 截断 → 切 val
const seen = new Set();
const uniq = collected.filter(r => !seen.has(r.fen) && seen.add(r.fen));
for (let i = uniq.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [uniq[i], uniq[j]] = [uniq[j], uniq[i]];
}
const total = Math.min(uniq.length, SOURCES.reduce((a, s) => a + s.sample, 0));
const dataset = uniq.slice(0, total);
const val = dataset.slice(0, VAL_N);
const train = dataset.slice(VAL_N);

const writeJsonl = (file, rows) => {
  const body = rows.map(r => JSON.stringify(
    r.mate !== undefined ? { fen: r.fen, mate: r.mate, s: r.s } : { fen: r.fen, cp: r.cp, s: r.s }
  )).join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, file), body);
  return Buffer.byteLength(body);
};
const trainBytes = writeJsonl('train.jsonl', train);
const valBytes = writeJsonl('val.jsonl', val);

// —— 抽样报告 ——
const cpRows = dataset.filter(r => r.cp !== undefined);
const cps = cpRows.map(r => r.cp).sort((a, b) => a - b);
const mateN = dataset.length - cpRows.length;
const buckets = { '25-32子': 0, '17-24子': 0, '10-16子': 0, '5-9子': 0, '2-4子': 0 };
for (const r of dataset) {
  const k = r.pieces >= 25 ? '25-32子' : r.pieces >= 17 ? '17-24子' : r.pieces >= 10 ? '10-16子' : r.pieces >= 5 ? '5-9子' : '2-4子';
  buckets[k]++;
}
const moves = dataset.map(r => r.moveNo).filter(x => Number.isFinite(x)).sort((a, b) => a - b);
const bySrc = [0, 1, 2].map(s => dataset.filter(r => r.s === s).length);
console.log(`\n数据集 train=${train.length.toLocaleString()} + val=${val.length.toLocaleString()}(train ${(trainBytes / 1e6).toFixed(1)}MB / val ${(valBytes / 1e6).toFixed(1)}MB)`);
console.log(`去重丢弃 ${collected.length - uniq.length} 条重复 FEN`);
console.log(`标签: cp ${(100 * cpRows.length / dataset.length).toFixed(1)}%(|cp| p50=${percentile(cps.map(Math.abs), .5)} p90=${percentile(cps.map(Math.abs), .9)})  mate ${(100 * mateN / dataset.length).toFixed(1)}%`);
console.log(`来源分布 evals0/evals1/tactics = ${bySrc.map(n => n.toLocaleString()).join(' / ')}`);
console.log(`相位分布:`, Object.entries(buckets).map(([k, v]) => `${k}=${(100 * v / dataset.length).toFixed(1)}%`).join('  '));
console.log(`回合数 p10=${percentile(moves, .1)} p50=${percentile(moves, .5)} p90=${percentile(moves, .9)}`);
