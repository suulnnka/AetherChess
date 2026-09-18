/* ============================================================
 * AI Worker:只是一层薄壳
 *   收 { id, moves, nodes, ms, depth }
 *   回 { id, move, depth, nodes, ms, score }
 *   开局命中时回 { id, move, book: true, name, depth: 0, nodes: 0, ms, score: 0 }
 *
 * moves 是 (from<<6|to) 的走法序列 —— 传序列而不是传棋盘,
 * 一是结构化克隆最省,二是 UI 与 Worker 共用同一份 rules.js,
 * 走法编码天然一致,不存在两条解析路径。
 *
 * 开局库数据在 book.bin(独立资产,不占引擎代码 chunk),启动时异步加载;
 * 加载完成前的查谱请求自动回落搜索。
 *
 * 搜索是同步的,Worker 收到新消息只会排队;UI 侧用请求序号丢弃过期结果,
 * 需要真正中断时直接 terminate 再造一个(见 index.js 的 abortEngine)。
 * ============================================================ */
import { newPos, replayMoves, NAME } from './rules.js';
import { searchBest } from './ai.js';
import { bookMove } from './book.js';

/* ENGINE_TAG 让下游 webos 的体积闸门(check-size.mjs)能在 dist 里认出这个 chunk
 * (字符串不会被压缩改名)。引擎体积预算 35KB gzip 就卡在这个 chunk 上。
 * 开局库数据以 base64 内嵌在 book.js 里,同样计入这个预算。 */
const ENGINE_TAG = 'chess-engine-v2';
self.__engineTag = ENGINE_TAG;

const BUF = new Int32Array(256);

function handle(d) {
  if (d && d.type === 'ping') { self.postMessage({ type: 'pong', tag: ENGINE_TAG }); return; }
  const t0 = Date.now();
  const pos = newPos();
  if (!replayMoves(pos, d.moves, BUF)) {
    self.postMessage({ id: d.id, error: 'illegal-sequence' });
    return;
  }
  /* 开局库优先:命中谱着直接回着,不再搜索。回的也是完整着法编码,
   * UI 侧按 d.book 区分展示(开局名 / 搜索信息)。 */
  const bm = bookMove(pos, d.moves.map((p) => NAME(p >> 6) + NAME(p & 63)));
  if (bm) {
    self.postMessage({ id: d.id, move: bm.move, book: true, name: bm.name, depth: 0, nodes: 0, ms: Date.now() - t0, score: 0 });
    return;
  }
  const r = searchBest(pos, { nodes: d.nodes, ms: d.ms, depth: d.depth });
  self.postMessage({
    id: d.id,
    move: r.move,
    depth: r.depth,
    nodes: r.nodes,
    ms: Date.now() - t0,
    score: r.score,
  });
}

self.onmessage = (e) => handle(e.data);
