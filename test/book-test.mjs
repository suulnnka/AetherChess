/* ============================================================
 * 开局库测试
 *   运行:node test/book-test.mjs
 *
 * 三道关:
 *   1. 全树边合法性:对谱树的每一条边(约 8600 个着法),在其对应
 *      局面上用 rules.js 验证合法 —— 全覆盖,任何数据错误都会爆。
 *   2. bookResponse 抽查:初始局面给出候选;特定主线(西班牙 Bb5、
 *      法兰西 e5)给出正确应着与开局族名;族名不含变种(无冒号);
 *      随机沿谱行走到底会耗尽并返回 null,沿途每手都合法。
 *   3. bookMove 绑定:查谱结果必须是当前局面的合法着法(含易位谱着),
 *      且升变取升后(与搜索/Worker 的着法编码一致)。
 * ============================================================ */
import { newPos, genLegal, make, unmake, mFrom, mTo, mPromo, NAME, QUEEN } from '../src/rules.js';
import { ROOT, bookResponse, bookCandidates, bookMove } from '../src/book.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } };
const section = (s) => console.log('\n== ' + s);

const sqOf = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - Number(s[1])) * 8;
/* 2字符方格编码(与生成器一致):格子 0..63 → 单字符;树键解码回 4字符着法 */
const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$';
const decKey = (k) => {
  const a = AL.indexOf(k[0]), b = AL.indexOf(k[1]);
  return 'abcdefgh'[a & 7] + (8 - (a >> 3)) + 'abcdefgh'[b & 7] + (8 - (b >> 3));
};
const findMove = (pos, key) => {
  const from = sqOf(key.slice(0, 2)), to = sqOf(key.slice(2, 4));
  const buf = new Int32Array(256);
  const n = genLegal(pos, buf);
  for (let i = 0; i < n; i++) {
    if (mFrom(buf[i]) !== from || mTo(buf[i]) !== to) continue;
    const pr = mPromo(buf[i]);
    if (pr && pr !== QUEEN) continue;
    return buf[i];
  }
  return 0;
};

/* ============================================================
 * 1. 全树边合法性:DFS 谱树,每条边在对应局面上必须是合法着法
 * ============================================================ */
section('全树边合法性(DFS 每条边)');
let edges = 0, broken = null;
(function walk(node, pos) {
  if (!node.c) return;
  for (const [key2, child] of Object.entries(node.c)) {
    const key = decKey(key2);
    const mv = findMove(pos, key);
    if (!mv) { broken = `${key}(${child.w}) 不合法`; return; }
    make(pos, mv);
    edges++;
    walk(child, pos);
    unmake(pos, mv);
  }
})(ROOT, newPos());
ok(!broken, `谱树 DFS:${broken || edges + ' 条边全部合法'}`);

/* ============================================================
 * 2. bookResponse 抽查
 * ============================================================ */
section('bookResponse 抽查');
const first = bookResponse([]);
ok(!!first && /^[a-h][1-8][a-h][1-8]$/.test(first.move), `初始局面应给出候选,实得 ${JSON.stringify(first)}`);
ok(first.name === null || (typeof first.name === 'string' && first.name && !first.name.includes(':')),
  `开局名应为不带变种的族名,实得 ${JSON.stringify(first.name)}`);

const spanish = bookCandidates(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5']);
ok(!!spanish && spanish.some((c) => c.move === 'a7a6' && c.name === 'Ruy Lopez'),
  `西班牙 Bb5 后应含带名候选 a7a6(Ruy Lopez),实得 ${JSON.stringify(spanish?.filter((c) => c.name).slice(0, 3))}`);

const french = bookCandidates(['e2e4', 'e7e6', 'd2d4', 'd7d5', 'e4e5']);
ok(!!french && french.some((c) => c.move === 'c7c5' && c.name === 'French Defense'),
  `法兰西 e5 后应含带名候选 c7c5(French Defense),实得 ${JSON.stringify(french?.filter((c) => c.name))}`);

// 随机沿谱行走到底:book 耗尽(叶子返回 null),沿途每手都合法
{
  const pos = newPos();
  let exhausted = false, allLegal = true, plies = 0;
  for (let ply = 0; ply < 60; ply++) {
    const hit = bookMove(pos, []);
    if (!hit) { exhausted = pos.ply > 0; break; }
    const buf = new Int32Array(256);
    const n = genLegal(pos, buf);
    let legal = false;
    for (let i = 0; i < n; i++) if (buf[i] === hit.move) { legal = true; break; }
    if (!legal) { allLegal = false; break; }
    make(pos, hit.move);
    plies++;
  }
  ok(exhausted && allLegal, `随机谱内行走到底应全部合法并耗尽(allLegal=${allLegal}, exhausted=${exhausted})`);
}

/* ============================================================
 * 3. bookMove 绑定:查谱结果必须是当前局面的合法着法
 * ============================================================ */
section('bookMove 绑定(含易位谱着)');
{
  // 意大利吉乌奥科钢琴主线 3...Bc5 后,谱内下一手含 4.O-O(王车易位)
  const pos = newPos();
  const seq = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'];
  for (const k of seq) make(pos, findMove(pos, k));
  const bm = bookMove(pos, seq);
  ok(!!bm, `意大利局面应命中谱着,实得 ${JSON.stringify(bm)}`);
  if (bm) {
    const buf = new Int32Array(256);
    const n = genLegal(pos, buf);
    let legal = false;
    for (let i = 0; i < n; i++) if (buf[i] === bm.move) { legal = true; break; }
    ok(legal, 'bookMove 返回的着法必须在当前局面合法');
    const coords = NAME(mFrom(bm.move)) + NAME(mTo(bm.move));
    const allowed = bookCandidates(seq).map((c) => c.move);
    ok(allowed.includes(coords), `绑定坐标应属谱内候选,实得 ${coords}(候选:${allowed.join('/')})`);
  }

  // 悔棋还原性:走谱着再撤销,局面必须逐位还原
  const before = JSON.stringify(pos.b);
  const mv = bookMove(pos, seq);
  if (mv) {
    make(pos, mv.move);
    unmake(pos, mv.move);
    ok(JSON.stringify(pos.b) === before, '走谱着再撤销,棋盘必须还原');
  }
}

console.log(`\n${fail ? '✗' : '✓'} 开局库测试:${pass} 通过,${fail} 失败`);
process.exit(fail ? 1 : 0);
