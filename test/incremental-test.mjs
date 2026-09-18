/* ============================================================
 * 增量评估对拍:随机游走每一步断言 evScore(pos) === evaluateFull(pos),
 * 撤销后断言快照恢复与全量一致。覆盖升变/吃过路兵/易位密集局面。
 * 用法:node test/incremental-test.mjs [局数=60] [步数=240]
 * ============================================================ */
import {
  WHITE, BLACK, newPos, loadPosition, genLegal, make, unmake, TYPES,
} from '../src/rules.js';
import { evAttach, evaluate, evaluateFull } from '../src/eval.js';

const GAMES = Number(process.argv[2] || 60);
const PLIES = Number(process.argv[3] || 240);

const STARTS = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  // 升变密集:兵对峙 + 子力少
  '8/PPPP2kp/8/8/8/8/ppppK3/8 w - - 0 1',
  '2k5/1PP3pp/8/8/8/8/1ppK2PP/8 w - - 0 1',
  // 易位密集
  'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
  'r3k2r/pppqpppp/8/8/8/8/PPPQPPPP/R3K2R w KQkq - 0 1',
  // 吃过路兵窗口
  'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3',
  // 中局复杂局面
  'r2q1rk1/pp2ppbp/2np1np1/8/2BNP3/2N1BP2/PPPQ2PPP/2KR2R1 w K - 0 11',
];

function posFromFen(fen) {
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
  if (parts[2].includes('K')) castle |= 1;
  if (parts[2].includes('Q')) castle |= 2;
  if (parts[2].includes('k')) castle |= 4;
  if (parts[2].includes('q')) castle |= 8;
  let ep = -1;
  if (parts[3] && parts[3] !== '-') ep = (8 - +parts[3][1]) * 8 + 'abcdefgh'.indexOf(parts[3][0]);
  return loadPosition(newPos(), cells, parts[1] === 'b' ? BLACK : WHITE, castle, ep);
}

let seed = 0xc0ffee;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const buf = new Int32Array(256);

let steps = 0, mismatches = 0, undos = 0, undoBad = 0;
let epSeen = 0, castleSeen = 0, promoSeen = 0;

for (let g = 0; g < GAMES; g++) {
  const pos = posFromFen(STARTS[g % STARTS.length]);
  evAttach(pos);
  const stack = [];
  for (let p = 0; p < PLIES; p++) {
    const n = genLegal(pos, buf);
    if (!n) break;
    // 每步都断言:增量 === 全量(整数累加,应逐位相等)
    const a = evaluate(pos), b = evaluateFull(pos);
    steps++;
    if (a !== b) {
      if (++mismatches <= 10) console.log(`  ✗ 局${g} 步${p}: 增量 ${a} vs 全量 ${b}(diff ${a - b})`);
    }
    const m = buf[(rnd() * n) | 0];
    const fl = (m >> 12) & 15;
    if (fl === 5) epSeen++;
    else if (fl === 2 || fl === 3) castleSeen++;
    else if (fl >= 6) promoSeen++;
    stack.push(m);
    make(pos, m);
    // 随机撤销 1~2 步再重下,验证快照恢复
    if (rnd() < 0.1 && stack.length > 2) {
      const undoN = 1 + (rnd() < 0.3 ? 1 : 0);
      const popped = [];
      for (let u = 0; u < undoN; u++) { const mm = stack.pop(); popped.push(mm); unmake(pos, mm); }
      undos += undoN;
      const a2 = evaluate(pos), b2 = evaluateFull(pos);
      if (a2 !== b2) { if (++undoBad <= 10) console.log(`  ✗ 撤销后 局${g} 步${p}: ${a2} vs ${b2}`); }
      for (const mm of popped.reverse()) { make(pos, mm); stack.push(mm); }
      const a3 = evaluate(pos), b3 = evaluateFull(pos);
      if (a3 !== b3) { if (++undoBad <= 10) console.log(`  ✗ 重下后 局${g} 步${p}: ${a3} vs ${b3}`); }
    }
  }
}

console.log(`游走 ${GAMES} 局 × ≤${PLIES} 步:断言 ${steps} 步,不一致 ${mismatches},撤销 ${undos} 次(撤销不一致 ${undoBad})`);
console.log(`覆盖:吃过路兵 ${epSeen} 次,易位 ${castleSeen} 次,升变 ${promoSeen} 次`);
const bad = mismatches + undoBad;
console.log(bad === 0 ? '✓ 增量评估与全量逐位一致' : `✗ ${bad} 处不一致`);
process.exit(bad ? 1 : 0);
