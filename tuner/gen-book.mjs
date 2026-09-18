/* ============================================================
 * 开局库生成器:全量导入 lichess-org/chess-openings(GitHub 公开仓库;
 * 按 ECO 开局体系整理,数据依维基百科「国际象棋开局列表」)
 *
 * 用法(node AetherChess 根目录):node tuner/gen-book.mjs
 *  - 下载 a–e.tsv(GitHub contents API,tmpdir 缓存),全部约 3800 行
 *  - SAN 逐手转成坐标着法并用 rules.js 校验(个别无法解析的行跳过并计数)
 *  - 全部行建成一棵谱树(相同前缀只存一次),节点权重 = 经过它的谱线数,
 *    加权随机天然偏向主流着法
 *  - 序列化为字符串谱树内嵌 src/book.js:
 *      节点 := KEY(2字符方格编码) + W(2字符36进制子树权重) + [ '(' 子树 ')' ]
 *      NFAM = 去重后的开局族名(ECO 名称冒号前的英文原文)。
 *
 * src/book.js 是生成物,不要手改;测试:node test/book-test.mjs
 * ============================================================ */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUEEN, ROOK, BISHOP, KNIGHT, PAWN, CHARS, mFrom, mTo, mPromo, mFlag, genLegal, make, newPos } from '../src/rules.js';

const REPO = 'lichess-org/chess-openings';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'src', 'book.js');
const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$';
const sqOf = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - Number(s[1])) * 8;
const encSqPair = (key) => AL[sqOf(key.slice(0, 2))] + AL[sqOf(key.slice(2, 4))];
const PROMO = { Q: QUEEN, R: ROOK, B: BISHOP, N: KNIGHT };

/* ---- 下载 / 缓存 TSV ---- */
async function loadRows() {
  const rows = [];
  for (const f of 'abcde') {
    const cache = join(tmpdir(), `chess-openings-${f}.tsv`);
    if (!existsSync(cache)) {
      const url = `https://api.github.com/repos/${REPO}/contents/${f}.tsv`;
      const res = await fetch(url, { headers: { Accept: 'application/vnd.github.raw' } });
      if (!res.ok) throw new Error(`下载 ${f}.tsv 失败: HTTP ${res.status}`);
      writeFileSync(cache, await res.text());
    }
    for (const l of readFileSync(cache, 'utf8').split('\n')) {
      if (l.includes('\t')) {
        const [eco, name, pgn] = l.split('\t');
        rows.push({ eco, name, pgn });
      }
    }
  }
  return rows;
}

/* ---- SAN → 引擎着法(在 pos 上逐手匹配合法走法) ---- */
function sanToMove(pos, sanRaw) {
  const san = sanRaw.replace(/[+#!?]/g, '');
  const buf = new Int32Array(256);
  const n = genLegal(pos, buf);
  if (san === 'O-O' || san === 'O-O-O') {
    const flag = san === 'O-O' ? 2 : 3;                     // F_OO / F_OOO
    for (let i = 0; i < n; i++) if (mFlag(buf[i]) === flag) return buf[i];
    return 0;
  }
  const m = /^([KQRBN])?([a-h])?([1-8])?x?([a-h][1-8])(?:=([QRBN]))?$/.exec(san);
  if (!m) return 0;
  const [, letter, dFile, dRank, target, promo] = m;
  const to = 'abcdefgh'.indexOf(target[0]) + (8 - Number(target[1])) * 8;
  for (let i = 0; i < n; i++) {
    const mv = buf[i];
    if (mTo(mv) !== to) continue;
    const p = pos.b[mFrom(mv)];
    const ty = p & 7;
    const sanLetter = ty === PAWN ? '' : CHARS[ty].toUpperCase();
    if (sanLetter !== (letter || '')) continue;
    const from = mFrom(mv);
    if (dFile && 'abcdefgh'[from & 7] !== dFile) continue;
    if (dRank && String(8 - (from >> 3)) !== dRank) continue;
    if (promo ? mPromo(mv) !== PROMO[promo] : (mPromo(mv) && mPromo(mv) !== QUEEN)) continue;
    return mv;
  }
  return 0;
}
const moveKeyOf = (from, to) => 'abcdefgh'[from & 7] + (8 - (from >> 3)) + 'abcdefgh'[to & 7] + (8 - (to >> 3));
function convert(pgn) {
  const tokens = pgn.split(/\s+/).filter((t) => t && !/^\d+\.+$/.test(t));
  const pos = newPos();
  const seq = [];
  for (const t of tokens) {
    const mv = sanToMove(pos, t);
    if (!mv) throw new Error(t);
    make(pos, mv);
    seq.push(moveKeyOf(mFrom(mv), mTo(mv)));
  }
  return seq;
}

/* ---- 全量建树:节点 = { w: 经过谱线数, kids: Map(着法 → 子节点) } ---- */
const rows = await loadRows();
const root = { w: 0, kids: null };
let okRows = 0, badRows = 0;
for (const { pgn } of rows) {
  let seq;
  try { seq = convert(pgn); } catch { badRows++; continue; }
  okRows++;
  let node = root;
  for (const k of seq) {
    if (!node.kids) node.kids = new Map();                  // 该节点曾是叶子,被更深谱线穿过
    let child = node.kids.get(k);
    if (!child) { child = { w: 0, kids: null }; node.kids.set(k, child); }
    child.w++;
    node = child;
  }
}
console.log(`谱线: ${okRows} 行导入,${badRows} 行跳过;树节点: ${countNodes(root)};最长: ${maxDepth(root)} 手`);

function countNodes(node) {
  let n = 0;
  if (node.kids) for (const child of node.kids.values()) n += countNodes(child) + 1;
  return n;
}
function maxDepth(node) {
  let d = 0;
  if (node.kids) for (const child of node.kids.values()) d = Math.max(d, maxDepth(child) + 1);
  return d;
}

/* ---- 序列化:前序遍历,KEY(2字符) + 权重(2字符36进制) + 括号子树 ---- */
function serialize(node, out) {
  if (!node.kids) return;
  for (const [k, sub] of node.kids) {
    out.push(k, W(sub.w));
    if (sub.kids) {
      out.push('(');
      serialize(sub, out);
      out.push(')');
    }
  }
}
const W = (n) => Math.min(n, 1295).toString(36).padStart(2, '0');
const treeParts = [];
serialize(root, treeParts);
const treeStr = treeParts.join('');
console.log(`树序列化 ${treeStr.length} B`);

/* ---- 精选族中文名:挂在"该族独占的分歧边"上(与其他精选族共享的前缀边不挂) ---- */
function familySeq(sel) {
  const matches = rows
    .filter((r) => sel.eco.test(r.eco) && sel.name.test(r.name))
    .map((r) => ({ ...r, plies: r.pgn.split(/\s+/).filter((t) => !/^\d+\.+$/.test(t)).length }))
    .filter((r) => r.plies >= 6 && r.plies <= 12)
    .sort((a, b) => b.plies - a.plies || a.name.length - b.name.length);
  return matches.length ? convert(matches[0].pgn) : null;
}
const curatedSeqs = CURATED.map((sel) => ({ sel, seq: familySeq(sel) }));
const NAMES = {};
for (let fi = 0; fi < curatedSeqs.length; fi++) {
  const { sel, seq } = curatedSeqs[fi];
  if (!seq) { console.error(`✗ 精选族未命中: ${sel.zh}(${sel.eco})`); process.exit(1); }
  for (let d = 1; d <= seq.length; d++) {
    const prefix = seq.slice(0, d).join('');
    const exclusive = curatedSeqs.every(({ seq: other }) => other === seq || other.slice(0, d).join('') !== prefix);
    if (exclusive) { NAMES[prefix] = sel.zh; break; }
  }
  console.log(`✓ ${sel.zh} · ${seq.length} 手`);
}
