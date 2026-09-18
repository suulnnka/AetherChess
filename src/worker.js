/* ============================================================
 * AI Worker:只是一层薄壳
 *   收 { id, moves, nodes, ms, depth }
 *   回 { id, move, depth, nodes, ms, score }
 *
 * moves 是 (from<<6|to) 的走法序列 —— 传序列而不是传棋盘,
 * 一是结构化克隆最省,二是 UI 与 Worker 共用同一份 rules.js,
 * 走法编码天然一致,不存在两条解析路径。
 *
 * 搜索是同步的,Worker 收到新消息只会排队;UI 侧用请求序号丢弃过期结果,
 * 需要真正中断时直接 terminate 再造一个(见 index.js 的 abortEngine)。
 * ============================================================ */
import { newPos, replayMoves } from './rules.js';
import { searchBest } from './ai.js';

/* ENGINE_TAG 让下游 webos 的体积闸门(check-size.mjs)能在 dist 里认出这个 chunk
 * (字符串不会被压缩改名)。引擎体积预算 35KB gzip 就卡在这个 chunk 上。 */
const ENGINE_TAG = 'chess-engine-v2';
self.__engineTag = ENGINE_TAG;

const BUF = new Int32Array(256);

self.onmessage = (e) => {
  const d = e.data;
  if (d && d.type === 'ping') { self.postMessage({ type: 'pong', tag: ENGINE_TAG }); return; }
  const t0 = Date.now();
  const pos = newPos();
  if (!replayMoves(pos, d.moves, BUF)) {
    self.postMessage({ id: d.id, error: 'illegal-sequence' });
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
};
