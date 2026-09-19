/* ============================================================
 * 从 src/book.js(单一事实源:TREE 谱树字符串 + NFAM 族名表)生成
 * src/zig/book.bin —— 编译期 @embedFile 进 wasm 的二进制谱库。
 *
 * 价值在**归属**:谱库是引擎数据,和规则/评估/搜索一起住进 wasm
 * (与黑白棋 weights.bin 同一模式),worker 的 JS chunk 从 ~21KB 缩到
 * ~2KB。gzip 尺寸与文本谱树相当(约 20KB,定长节点换掉了文本的结构
 * 字符,熵差不多)—— 总下载量不变,预算在 webos 侧对应调整即可,
 * 不为压缩比折腾格式。
 *
 * 布局(一律小端):
 *   u16  famCount
 *   每族: u16 enLen + UTF-8 英文名 + u16 zhLen + UTF-8 中文名(BOOK_ZH 译名表)
 *   u32  nodeCount            (不含哑根,核对用)
 *   u8   rootKids             (哑根的直接子节点数 —— 树无实体根,单独给)
 *   nodeCount × 前序节点,3 字节起:
 *     u8 from, u8 to          (引擎格号,即线格式 (from<<6|to) 的两半)
 *     u8 flags                bit7 hasFam · bit6-5 流行度等级(2 位)· bit0-4 nKids ≤ 31
 *     [u8 fam]                hasFam 时才有:族下标(0..148)
 *
 * 流行度等级:把谱线数权重等比量化到 4 档,档位权 1 : n : n² : n³。
 * n 在全谱 8652 个权重上拟合(按 w 加权的对数失真最小),n=10 时根分布
 * 几乎无损(e4/d4 量化后 42.7% vs 原 42.0%),且失真代价距最优仅 6%
 * —— 取 n=10,档位权就是 1/10/100/1000。>255 的权重全谱只有 12 个,
 * 绝大多数(5845 个)权重本来就是 1。legacy_js 的 JS 版用精确权重,
 * 两边开局分布近似相同而非逐位相同,这是有意的取舍(2 位换 17KB)。
 *   子节点紧跟父节点头之后;兄弟之间靠"跳过子树"推进(节点变长,跳
 *   子树要按 fam 是否存在步进,见 book.zig)。key 挂在父节点的 c 映射上
 *   (book.js build() 的结构),子节点自身没有,必须随遍历传入。
 *
 * 用法:node tools/gen-book.mjs   (改 book.js 后重跑,再 build:wasm)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../src/book.js';
import { prunedRoot, PRUNE_W, PRUNE_DEPTH } from './book-prune.mjs';
import { BOOK_ZH } from './book-zh.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT_DIR, 'src', 'zig', 'book.bin');

/* NFAM 未导出(生成物不手改),从源码提取 —— 与谱树同源 */
const src = fs.readFileSync(path.join(ROOT_DIR, 'src', 'book.js'), 'utf8');
const NFAM = JSON.parse(src.match(/const NFAM = (\[.*?\]);/s)[1]);
const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$';

/* 双语断言:译名表与 NFAM 对齐(锚点抓三个最出名的,防止顺序错位) */
if (BOOK_ZH.length !== NFAM.length) {
  console.error(`✗ 译名表 ${BOOK_ZH.length} 条 ≠ NFAM ${NFAM.length} 条(book.js 变了要同步 book-zh.mjs)`);
  process.exit(1);
}
for (const [en, zh] of [['Sicilian Defense', '西西里防御'], ['Ruy Lopez', '西班牙开局'], ["King's Indian Defense", '古印度防御']]) {
  const i = NFAM.indexOf(en);
  if (i < 0 || BOOK_ZH[i] !== zh) {
    console.error(`✗ 译名锚点错位:${en} → ${BOOK_ZH[i] ?? '(缺)'}(期望 ${zh})`);
    process.exit(1);
  }
}

/* 剪枝:低流行(w≤PRUNE_W)且够长(≥PRUNE_DEPTH 手)的冷门理论尾巴整段收回,
 * 主流线不动;被截断的线只是更早出谱回落搜索。规则与阈值见 book-prune.mjs。 */
const pruned = prunedRoot();
const ROOT_ = pruned.tree;

if (NFAM.length > 254) {
  console.error(`✗ 族名 ${NFAM.length} 条 > 254(u8 fam 用 255 当"无名"标记)`);
  process.exit(1);
}

const chunks = [];
const u16 = (v) => chunks.push(Buffer.from([v & 255, (v >> 8) & 255]));
const u8 = (v) => chunks.push(Buffer.from([v]));

const POP_N = 10;                       // 拟合结论,见头注释;book.zig 的 POP_LEVELS 必须同步
const popClass = (w) => Math.max(0, Math.min(3, Math.round(Math.log(w) / Math.log(POP_N))));
let nodeCount = 0;
let famNodes = 0;
const emit = (key, node) => {
  const kids = Object.entries(node.c || {});
  if (kids.length > 31) {
    console.error(`✗ 子节点数 ${kids.length} > 31(flags 只留了 5 位)`);
    process.exit(1);
  }
  nodeCount++;
  const hasFam = node.fam != null ? 1 : 0;
  if (hasFam) famNodes++;
  u8(AL.indexOf(key[0]));
  u8(AL.indexOf(key[1]));
  u8((hasFam << 7) | (popClass(node.w) << 5) | kids.length);
  if (hasFam) u8(node.fam);
  for (const [k, c] of kids) emit(k, c);
};

u16(NFAM.length);
for (let i = 0; i < NFAM.length; i++) {
  const en = Buffer.from(NFAM[i], 'utf8');
  const zh = Buffer.from(BOOK_ZH[i], 'utf8');
  u16(en.length); chunks.push(en);
  u16(zh.length); chunks.push(zh);
}
/* nodeCount 占位:记录**字节偏移**(不是 chunks 数组下标 —— concat 之后
 * 两者不同,写错位置会把名字区冲掉,解析全乱,踩过) */
let countOffset = 0;
for (const c of chunks) countOffset += c.length;
chunks.push(Buffer.alloc(4));
const rootKids = Object.keys(ROOT_.c).length;
u8(rootKids);
for (const [k, c] of Object.entries(ROOT_.c)) emit(k, c);

const bin = Buffer.concat(chunks);
bin.writeUInt32LE(nodeCount, countOffset);
fs.writeFileSync(OUT, bin);

const gz = zlib.gzipSync(bin, { level: 9 }).length;
console.log(`✓ ${path.relative(ROOT_DIR, OUT)}:节点 ${nodeCount}(剪枝 −${pruned.removed},w≤${PRUNE_W} 且 ≥${PRUNE_DEPTH} 手)/ 根子 ${rootKids} / 带族名节点 ${famNodes} / 族名 ${NFAM.length} 条(流行度档 1:${POP_N}:${POP_N ** 2}:${POP_N ** 3})`);
console.log(`  raw ${bin.length} B · gzip ${gz} B(${(gz / 1024).toFixed(2)} KB)`);
