/* ============================================================
 * 谱库剪枝(生成与对拍共用,单一事实源):
 *   迭代摘除「叶子 且 流行度 w ≤ PRUNE_W 且 深度 ≥ PRUNE_DEPTH」的节点,
 *   摘完后父节点变叶子再按同一规则复查,直到不动点 —— 效果是把
 *   "仅 1 条谱线经过且拖得很长"的冷门理论尾巴整段收回,主流线
 *   (w ≥ 2 或有分叉)一条不动;被截断的线只是更早出谱回落搜索。
 *
 * 阈值口径(2026-09 实测曲线,见 docs/zig-port.md):
 *   W≤1 D≥10 ⇒ 剪 2858/8652 节点,blob gzip 17.4→13.2KB(−24%);
 *   剪掉的正是 gzip 压不动的 from/to 着法字节。要调改这两个常量
 *   重跑 gen-book 即可(探针自动同源)。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../src/book.js';

export const PRUNE_W = 1;
export const PRUNE_DEPTH = 10;

/* NFAM 未导出(book.js 是生成物),从源码提取 —— 与谱树同源 */
export const NFAM = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'book.js'), 'utf8')
    .match(/const NFAM = (\[.*?\]);/s)[1],
);

/** 带深度标注克隆(不动 book.js 的 ROOT;d 从根的孩子起算 0) */
function clone(n, d) {
  return {
    w: n.w,
    fam: n.fam,
    d,
    c: n.c ? Object.fromEntries(Object.entries(n.c).map(([k, v]) => [k, clone(v, d + 1)])) : null,
  };
}

function countAll(n) {
  let c = 1;
  for (const k of Object.values(n.c || {})) c += countAll(k);
  return c;
}

/**
 * 剪枝后的谱树(节点形状与 book.js 相同:{ w, fam, c }),并返回统计。
 * 摘除动作在父层做:step 先递归处理孩子,再判断当前节点是否已无孩子
 * 且满足「低流行 + 够深」,是则由父层删键 —— 哑壳让根级节点走同一路径。
 */
export function prunedRoot() {
  const t = clone(ROOT, -1);
  const outer = { c: { '': t } };
  (function step(n) {
    if (!n.c) return;
    for (const [k, c] of Object.entries(n.c)) {
      step(c);
      if (!c.c && c.d >= PRUNE_DEPTH && c.w <= PRUNE_W && c.d >= 0) delete n.c[k];
    }
    if (Object.keys(n.c).length === 0) n.c = null;
  })(outer);
  const tree = outer.c[''];
  return {
    tree, // 哑壳未按规则删除(d=-1 不满足),结构等同 ROOT 形状
    removed: countAll(ROOT) - 1 - (countAll(tree) - 1),
    kept: countAll(tree) - 1,
  };
}

const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$';
const sqOf = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const encKey = (k) => AL[sqOf(k.slice(0, 2))] + AL[sqOf(k.slice(2, 4))];
const decKey = (k) => {
  const a = AL.indexOf(k[0]), b = AL.indexOf(k[1]);
  return 'abcdefgh'[a & 7] + (8 - (a >> 3)) + 'abcdefgh'[b & 7] + (8 - (b >> 3));
};

/** 在(剪枝后的)谱树上按坐标串序列取候选,形状对齐 book.js 的 bookCandidates:
 *  [{ move:'e2e4', name|null, w }] 或 null(谱外/谱尽) */
export function candidatesOn(root, seqKeys) {
  let node = root;
  for (const k of seqKeys) {
    if (!node.c) return null;
    node = node.c[encKey(k)];
    if (!node) return null;
  }
  if (!node.c) return null;
  return Object.entries(node.c).map(([key, c]) => ({
    move: decKey(key),
    name: c.fam != null ? NFAM[c.fam] : null,
    w: c.w,
  }));
}
