/* ============================================================
 * AI Worker:引擎的门面(UI 不 import 引擎源码,一切经消息)
 *   ping                     → { type:'pong', tag }
 *   { type:'levels' }        → { type:'levels', tag, engine, default, levels }
 *                              纯声明难度表(数据在 levels.js),不触发任何加载;
 *                              UI 只读 name/id,nodes/ms/depth 是实现细节
 *   { type:'state', id, moves }
 *                            → { type:'state', id, board, stm, legal, check,
 *                                over, result, winner }
 *                              规则查询的单一入口:重演序列后回报棋盘、行棋方全部
 *                              合法着法、将军态与终局判定(将死/逼和/子力不足/
 *                              三次重复)。legal 编码 (from<<6|to),升变只留升后
 *   { type:'think', id, moves, level }
 *                            → { id, move, depth, nodes, ms, score }
 *                            → 开局命中 { id, move, book: true, name, depth: 0, ... }
 *                              level 是**本引擎难度表的下标**(表由 levels 自报)
 *
 * moves 是 (from<<6|to) 的走法序列 —— 传序列而不是传棋盘:
 * 结构化克隆最省,编码只有一套,不存在两条解析路径。
 *
 * 开局库数据内嵌在 book.js 里,worker 查谱命中直接回着;谱外进搜索。
 *
 * 搜索是同步的,Worker 收到新消息只会排队;UI 侧用请求序号丢弃过期结果,
 * 需要真正中断时直接 terminate 再造一个(见 webos 应用的 abortEngine)。
 * ============================================================ */
import {
  newPos, replayMoves, genLegal, hasLegalMove, inCheck, isThreefold,
  insufficientMaterial, mFrom, mTo, mPromo, QUEEN, NAME,
} from './rules.js';
import { searchBest } from './ai.js';
import { bookMove } from './book.js';
import { LEVELS, DEFAULT_LEVEL } from './levels.js';

/* ENGINE_TAG 让下游 webos 的体积闸门(check-size.mjs)能在 dist 里认出这个 chunk
 * (字符串不会被压缩改名)。开局库数据内嵌在 book.js 里,同样计入这个预算。 */
const ENGINE_TAG = 'chess-engine-v2';
self.__engineTag = ENGINE_TAG;

const BUF = new Int32Array(256);

/** 重演序列并产出「UI 渲染所需的全部规则事实」。legal 转成与请求一致的
 *  (from<<6|to) 线格式,升变只留升后(与对弈路径「Worker 按线格式重演、
 *  旗位按合法性还原」的约定互洽)。 */
function describeState(d) {
  const pos = newPos();
  if (!replayMoves(pos, d.moves, BUF)) return { error: 'illegal-sequence' };

  const n = genLegal(pos, BUF);
  const legal = [];
  for (let i = 0; i < n; i++) {
    const m = BUF[i];
    if (mPromo(m) && mPromo(m) !== QUEEN) continue;      // 升变只留升后
    legal.push((mFrom(m) << 6) | mTo(m));
  }

  const check = inCheck(pos);
  let over = false, result = null, winner = -1;
  if (!hasLegalMove(pos, BUF)) {
    over = true;
    if (check) { result = 'mate'; winner = 1 - pos.stm; }   // 将死:行棋方负
    else result = 'stale';                                  // 逼和
  } else if (insufficientMaterial(pos)) {
    over = true;
    result = 'material';                                    // 子力不足,无法将死
  } else if (isThreefold(pos)) {
    over = true;
    result = 'threefold';                                   // 三次重复局面
  }

  return {
    board: Array.from(pos.b),                 // p = 颜色<<3 | 型;0 = 空
    stm: pos.stm,
    legal,
    check,
    over, result, winner,
  };
}

function handle(d) {
  if (d && d.type === 'ping') { self.postMessage({ type: 'pong', tag: ENGINE_TAG }); return; }

  if (d.type === 'levels') {
    /* 纯声明:难度表(含参数)是引擎的实现细节,UI 只拿 name/id 建下拉 */
    self.postMessage({ type: 'levels', tag: ENGINE_TAG, engine: 'js', default: DEFAULT_LEVEL, levels: LEVELS });
    return;
  }

  if (d.type === 'state') {
    const s = describeState(d);
    self.postMessage(s.error
      ? { type: 'state', id: d.id, error: s.error }
      : { type: 'state', id: d.id, tag: ENGINE_TAG, ...s });
    return;
  }

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
  const lv = LEVELS[d.level] ?? LEVELS[DEFAULT_LEVEL] ?? LEVELS[0];
  const r = searchBest(pos, { nodes: lv.nodes, ms: lv.ms, depth: lv.depth });
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
