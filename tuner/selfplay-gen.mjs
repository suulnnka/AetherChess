/* ============================================================
 * 自对弈数据生成(Texel 式 RL 数据源)
 *
 * 当前引擎(src/ai.js,FITTED 参数)左右互搏,收集
 *   { g: 局号, fen: 安静局面, r: 该局白方得分(1/0.5/0) }
 * 到 data/selfplay.jsonl。安静局面用 S0-6 的 isQuiet()(qsearch 宽窗
 * 返回值 == 静态分)过滤;被将/超 4k 节点/开局面(前 16 ply)不算。
 *
 * 开局多样性与 duel.mjs 同源:基线引擎(git HEAD)前 16 ply 固定种子
 * top-3 随机分歧 —— 与被调参数无关。
 *
 * 用法:node tuner/selfplay-gen.mjs [局数=2000] [节点/步=10000] [workers=12]
 * ============================================================ */
import { Worker, workerData, parentPort } from 'node:worker_threads';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAMES = Number(process.argv[2] || 2000);
const NODES = Number(process.argv[3] || 10000);
const WORKERS = Math.min(Number(process.argv[4] || 12), os.cpus().length - 1);
const OUT = path.join(HERE, 'data', 'selfplay.jsonl');
const OPENINGS = Number(process.argv[5] || 50);


/* ---------- worker 侧 ---------- */
if (workerData) {
  const { WHITE, BLACK, TYPES, CHARS, C_WK, C_WQ, C_BK, C_BQ, newPos, loadPosition,
    genLegal, make, hasLegalMove, inCheck, isRepetition, insufficientMaterial } =
    await import('../src/rules.js');
  const { searchBest, isQuiet } = await import('../src/ai.js');

  const posFromFen = (fen) => {
    const parts = fen.split(' ');
    const cells = new Int8Array(64);
    const rank = parts[0].split('/');
    for (let r = 0; r < 8; r++) {
      let c = 0;
      for (const ch of rank[r]) {
        if (ch >= '1' && ch <= '8') { c += +ch; continue; }
        cells[r * 8 + c] = (ch === ch.toUpperCase() ? 0 : 8) | TYPES[ch.toLowerCase()];
        c++;
      }
    }
    let castle = 0;
    if (parts[2].includes('K')) castle |= C_WK;
    if (parts[2].includes('Q')) castle |= C_WQ;
    if (parts[2].includes('k')) castle |= C_BK;
    if (parts[2].includes('q')) castle |= C_BQ;
    let ep = -1;
    if (parts[3] && parts[3] !== '-') ep = (8 - +parts[3][1]) * 8 + 'abcdefgh'.indexOf(parts[3][0]);
    return loadPosition(newPos(), cells, parts[1] === 'b' ? BLACK : WHITE, castle, ep);
  };
  const toFen = (pos) => {
    let fen = '';
    for (let r = 0; r < 8; r++) {
      let row = '', empty = 0;
      for (let c = 0; c < 8; c++) {
        const p = pos.b[r * 8 + c];
        if (!p) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += (p >> 3) ? CHARS[p & 7] : CHARS[p & 7].toUpperCase();
      }
      if (empty) row += empty;
      fen += (r ? '/' : '') + row;
    }
    const cs = (pos.castle & C_WK ? 'K' : '') + (pos.castle & C_WQ ? 'Q' : '') + (pos.castle & C_BK ? 'k' : '') + (pos.castle & C_BQ ? 'q' : '');
    return `${fen} ${pos.stm === WHITE ? 'w' : 'b'} ${cs || '-'} ${pos.ep >= 0 ? 'abcdefgh'[pos.ep & 7] + (8 - (pos.ep >> 3)) : '-'}`;
  };

  const { openings, gameIdxs } = workerData;
  const buf = new Int32Array(256);
  for (const g of gameIdxs) {
    const pos = posFromFen(openings[g % openings.length]);
    let result = null;
    const fens = [];
    for (let ply = 0; ply < 320; ply++) {
      if (!hasLegalMove(pos, buf)) { result = inCheck(pos) ? (pos.stm === WHITE ? 0 : 1) : 0.5; break; }
      if (ply > 0 && (isRepetition(pos) || pos.half >= 100 || insufficientMaterial(pos))) { result = 0.5; break; }
      // 安静局面才收标签(开局面 16 ply 之外)
      if (ply >= 16 && isQuiet(pos)) fens.push(toFen(pos));
      const r = searchBest(pos, { nodes: NODES, ms: 3600000, depth: 24 });
      make(pos, r.move);
    }
    if (result === null) result = 0.5;
    parentPort.postMessage({ lines: fens.map((fen) => ({ g, fen, r: result })) });
  }
  process.exit(0);
}

/* ---------- 主线程:开局生成 + 派发 + 落盘 ---------- */
console.log(`自对弈生成:${GAMES} 局 × ${NODES.toLocaleString()} 节点/步,${WORKERS} workers → data/selfplay.jsonl`);
const { WHITE, BLACK, TYPES, CHARS, C_WK, C_WQ, C_BK, C_BQ, newPos, loadPosition, genLegal, make, unmake } =
  await import('../src/rules.js');
const { searchBest: searchBase } = await import('./baseline/ai-baseline.mjs');

const posFromFenLocal = (fen) => {
  const parts = fen.split(' ');
  const cells = new Int8Array(64);
  const rank = parts[0].split('/');
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rank[r]) {
      if (ch >= '1' && ch <= '8') { c += +ch; continue; }
      cells[r * 8 + c] = (ch === ch.toUpperCase() ? 0 : 8) | TYPES[ch.toLowerCase()];
      c++;
    }
  }
  let castle = 0;
  if (parts[2].includes('K')) castle |= C_WK;
  if (parts[2].includes('Q')) castle |= C_WQ;
  if (parts[2].includes('k')) castle |= C_BK;
  if (parts[2].includes('q')) castle |= C_BQ;
  let ep = -1;
  if (parts[3] && parts[3] !== '-') ep = (8 - +parts[3][1]) * 8 + 'abcdefgh'.indexOf(parts[3][0]);
  return loadPosition(newPos(), cells, parts[1] === 'b' ? BLACK : WHITE, castle, ep);
};
const toFenLocal = (pos) => {
  let fen = '';
  for (let r = 0; r < 8; r++) {
    let row = '', empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = pos.b[r * 8 + c];
      if (!p) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += (p >> 3) ? CHARS[p & 7] : CHARS[p & 7].toUpperCase();
    }
    if (empty) row += empty;
    fen += (r ? '/' : '') + row;
  }
  const cs = (pos.castle & C_WK ? 'K' : '') + (pos.castle & C_WQ ? 'Q' : '') + (pos.castle & C_BK ? 'k' : '') + (pos.castle & C_BQ ? 'q' : '');
  return `${fen} ${pos.stm === WHITE ? 'w' : 'b'} ${cs || '-'} ${pos.ep >= 0 ? 'abcdefgh'[pos.ep & 7] + (8 - (pos.ep >> 3)) : '-'}`;
};

console.log('生成开局(基线引擎,16 ply,top-3 随机)…');
const openings = [];
{
  const buf = new Int32Array(256);
  for (let k = 0; k < OPENINGS; k++) {
    let s = 0x51ab + k * 7919;
    const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const pos = posFromFenLocal('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    for (let p = 0; p < 16; p++) {
      const n = genLegal(pos, buf);
      if (!n) break;
      const cands = [];
      for (let i = 0; i < n; i++) {
        make(pos, buf[i]);
        const r = searchBase(pos, { nodes: 20000, ms: 3600000, depth: 4 });
        unmake(pos, buf[i]);
        cands.push([buf[i], pos.stm === WHITE ? r.score : -r.score]);
      }
      cands.sort((a, b) => b[1] - a[1]);
      make(pos, cands[(rnd() * 3) | 0][0]);
    }
    openings.push(toFenLocal(pos));
  }
}

const t0 = Date.now();
const rows = [];
let received = 0;
await new Promise((resolve) => {
  const per = Math.ceil(GAMES / WORKERS);
  for (let w = 0; w < WORKERS; w++) {
    const idxs = Array.from({ length: GAMES }, (_, i) => i).slice(w * per, (w + 1) * per);
    if (!idxs.length) break;
    const worker = new Worker(new URL(import.meta.url), { workerData: { openings, gameIdxs: idxs } });
    worker.on('message', ({ lines }) => {
      for (const l of lines) rows.push(l);
      received++;
      if (received % 100 <= WORKERS) {
        process.stdout.write(`\r  ${received}/${GAMES} 局完成,样本 ${rows.length}(${((Date.now() - t0) / 1000 / 60).toFixed(1)} min)   `);
      }
    });
    worker.on('error', (e) => { console.error('worker error', e); process.exit(1); });
  }
  // 兜底轮询完成
  const timer = setInterval(() => {
    if (received >= GAMES) { clearInterval(timer); resolve(); }
  }, 500);
});

const fp = fs.openSync(OUT, 'w');
for (const r of rows) fs.writeSync(fp, JSON.stringify(r) + '\n');
fs.closeSync(fp);
console.log(`\n完成:${rows.length.toLocaleString()} 个安静局面样本(${GAMES} 局),用时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min → ${OUT}`);
