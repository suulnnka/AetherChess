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
 *   每族: u16 nameByteLen + UTF-8 族名
 *   u32  nodeCount            (不含哑根,核对用)
 *   u8   rootKids             (哑根的直接子节点数 —— 树无实体根,单独给)
 *   nodeCount × 前序节点,每个 6 字节:
 *     u8 from, u8 to          (引擎格号,即线格式 (from<<6|to) 的两半)
 *     u16 weight              (子树谱线数,采样权重,原样取自 book.js)
 *     u8  fam                 (族下标,255 = 无名)
 *     u8  nKids
 *   子节点紧跟父节点头之后;兄弟之间靠"跳过子树"推进(见 book.zig)。
 *   key 挂在父节点的 c 映射上(book.js build() 的结构),子节点自身
 *   没有,必须随遍历传入。
 *
 * 用法:node tools/gen-book.mjs   (改 book.js 后重跑,再 build:wasm)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../src/book.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT_DIR, 'src', 'zig', 'book.bin');

/* NFAM 未导出(生成物不手改),从源码提取 —— 与谱树同源 */
const src = fs.readFileSync(path.join(ROOT_DIR, 'src', 'book.js'), 'utf8');
const NFAM = JSON.parse(src.match(/const NFAM = (\[.*?\]);/s)[1]);
const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$';

if (NFAM.length > 254) {
  console.error(`✗ 族名 ${NFAM.length} 条 > 254(u8 fam 用 255 当"无名"标记)`);
  process.exit(1);
}

const chunks = [];
const u16 = (v) => chunks.push(Buffer.from([v & 255, (v >> 8) & 255]));
const u8 = (v) => chunks.push(Buffer.from([v]));

let nodeCount = 0;
const emit = (key, node) => {
  const kids = Object.entries(node.c || {});
  if (kids.length > 255) {
    console.error(`✗ 子节点数 ${kids.length} > 255(u8 nKids 放不下)`);
    process.exit(1);
  }
  nodeCount++;
  u8(AL.indexOf(key[0]));
  u8(AL.indexOf(key[1]));
  u16(node.w);
  u8(node.fam != null ? node.fam : 255);
  u8(kids.length);
  for (const [k, c] of kids) emit(k, c);
};

u16(NFAM.length);
for (const nm of NFAM) {
  const b = Buffer.from(nm, 'utf8');
  u16(b.length);
  chunks.push(b);
}
/* nodeCount 占位:记录**字节偏移**(不是 chunks 数组下标 —— concat 之后
 * 两者不同,写错位置会把名字区冲掉,解析全乱,踩过) */
let countOffset = 0;
for (const c of chunks) countOffset += c.length;
chunks.push(Buffer.alloc(4));
const rootKids = Object.keys(ROOT.c).length;
u8(rootKids);
for (const [k, c] of Object.entries(ROOT.c)) emit(k, c);

const bin = Buffer.concat(chunks);
bin.writeUInt32LE(nodeCount, countOffset);
fs.writeFileSync(OUT, bin);

const gz = zlib.gzipSync(bin, { level: 9 }).length;
console.log(`✓ ${path.relative(ROOT_DIR, OUT)}:节点 ${nodeCount} / 根子 ${rootKids} / 族名 ${NFAM.length} 条`);
console.log(`  raw ${bin.length} B · gzip ${gz} B(${(gz / 1024).toFixed(2)} KB)`);
