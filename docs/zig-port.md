# Zig / wasm 移植(main 分支)

> 状态:**完成,验证通过**(分支命名对齐 AetherOthello:main = 叠加了 Zig 实现的
> 线上通道,legacy_js = JS 引擎的历史快照)。main 把引擎(rules / eval / search)
> 逐句移植到 Zig 并编译为 `wasm/chess.wasm`,worker 消息契约与 `legacy_js` 的
> `src/worker.js`(JS 参照实现)完全同一份;webos 主仓切子模块指针即启用。

## 为什么是"逐句移植"而不是重写

评估参数是 **Texel 拟合的产物**,只在产生它的特征定义上有效 —— 包括一个有文档记录的
历史缺陷(`src/eval.js` fusedPiece 注释、`docs/chess-eval-training-report.md` 附录 E):
滑子机动性扫描只走斜线,车的机动性恒 0、后只数斜线。权重就是带着这个缺陷训练的,
修复特征必须重生成数据重拟合。因此移植纪律是**逐位一致**:

- Zobrist 用同一个 mulberry32、同一组种子 ⇒ 哈希与 JS 完全相同(置换表/重复判定可跨实现对拍);
- 走法 int32 打包、标志位、升变编码原样保留 ⇒ worker/UI 零改动;
- 评估特征的**累加顺序**、f64 运算次序、取整方式与 `eval.js` 完全一致(Zig 不做 fast-math);
- 搜索的节点计数检查时机、置换表替换策略、走法排序打分、剪枝阈值、aspiration 扩窗节奏逐句对齐。

## 与 JS 版的唯一语义偏差

wasm 没有墙钟:**时间兜底(ms/deadline)不移植**。节点预算是主约束
(`src/levels.js` 头注释的口径:设备无关、同机可复现),时间本来就是慢机器上的兜底。
JS 的迭代早停「节点过半**且**时间过半」是省墙钟的启发,在节点独大的通道里只会白白
压低最终深度,故也不移植 —— 迭代一直开到节点预算把搜索掐停为止。这恰好等价于
**JS 传超大 ms 预算**的行为,于是"同节点预算 ⇒ 同着法/同分/同深度/同节点数"的
逐位对拍成为可能(见下)。

## wasm ABI(`src/zig/engine.zig`)

零导入、零分配、freestanding C ABI(布局对齐 AetherOthello 的 `engine.zig`;与黑白棋
不同,**规则也下沉在 wasm 里** —— 黑白棋当时的 worker 注释就写了"等 zig 工具链可用,
规则可下沉为 engineState 导出",这里一步到位):

| 导出 | 说明 |
|---|---|
| `engineInit` / `engineNew` | 就绪探针 / 换局清表 |
| `engineMovesBuf` | 输入缓冲地址:JS 写入 `(from<<6|to)` 序列后 `engineLoad(n)` 重演 |
| `engineLoad(n)` | 从初始局面重演(升变一律升后),返回 1/0 |
| `engineState` + `engineBoardPtr/engineStm/engineLegalPtr/engineLegalCount/engineCheck/engineOver/engineResult/engineWinner` | 规则查询单一入口:棋盘/行棋方/合法着法(线格式,升变只留升后)/将军/终局 |
| `engineEvalCp` | 已装载局面的静态评估(行棋方视角,对拍用) |
| `engineThink(depth, nodes, jitter, seed)` | 搜索;`engineScore/engineDepth/engineNodesLo/Hi` 读细节;jitter 档的随机源由 worker 播种 |
| `engineBind(from, to)` | 谱着绑定:开局库的 from/to → 合法着法完整编码(升后优先) |
| `engineBookMove(seed, lang)` + `engineBookNamePtr/Len` | 开局库应手:按已装载线序列走谱,按流行度档位(2 位量化,权 1:10:100:1000)加权随机抽谱着并绑定;0 = 谱外回落搜索;族名(UTF-8,lang 0=英 1=中)经指针读出 |
| `engineBookCands` + `engineBookCandPtr/FamName` | 当前序列的谱内候选(line/weight/fam)与族名查询(探针对拍用) |
| `enginePerft(depth)` + `enginePerftHi` | perft(探针对拍) |

## 目录与工具

```
src/zig/rules.zig     棋规(mailbox / 走法打包 / make-unmake / Zobrist / replay / FEN 装载)
src/zig/eval.zig      评估(evalTerms 全量路径;JS 的增量评估路径从未在对弈启用,不移植)
src/zig/search.zig    搜索(PVS/TT/qsearch/SEE/LMR/空着/RFP/aspiration/jitter)
src/zig/book.zig      开局谱库:二进制 blob 零拷贝游走(走谱/档位加权抽取/族名)
src/zig/book.bin      谱库 blob(生成物:tools/gen-book.mjs 从 book.js 导出;节点 3 字节起 —— from/to/flags(bit7 族名 · bit6-5 流行度档 · bit0-4 孩子数)+ 可选族名字节。生成前经 book-prune.mjs 剪枝:摘除「w≤1 且 ≥10 手」的冷门理论尾巴,8652→5794 节点,被截断的线只是更早出谱回落搜索。名字区每族存**英/中两条** UTF-8,译名表 tools/book-zh.mjs 与 NFAM 下标对齐,显示语言由 worker 的 lang 参数选,默认中文)
src/zig/engine.zig    wasm 导出层
src/zig/selftest.zig  原生自测(perft/不变量/边角/战术/残局/谱库结构/NPS 基准)
src/zig/params.zig    491 评估参数(生成物:tools/gen-params.mjs 从 eval.js 导出;i32 无损存储,eval.zig 首访转 f64 工作表)
build.zig             selftest(native)/ wasm / 单元测试 三个 step
tools/build-wasm.mjs  zig build → wasm/chess.wasm(入库)→ 体积报告 → 跑探针
tools/probe-wasm.mjs  跨语言对拍(四道关,见下)
tools/worker-test.mjs worker 胶水层契约测试(levels/state/think/开局库)
tools/gen-params.mjs  参数导出(重调参后重跑)
tools/gen-book.mjs    谱库 blob 导出(改 book.js 后重跑)
```

## 验证(四道关)

1. **原生自测** `zig build selftest`:perft 6 局面逐层精确匹配(初始局面到 d5、
   Kiwipete 到 d4)、Zobrist 增量=全量重算(720/720)、make/unmake 逐位还原、
   规则边角(易位/升变/过路兵/将杀逼和/三次重复)、战术(与 JS 测试同局面同期望)、
   残局将杀(后/车对王)、NPS 基准(本机原生 ≈ 77 万,JS 同机 ≈ 27.5 万)。
2. **跨语言对拍** `node tools/probe-wasm.mjs`:
   - perft / state:标准值 + 与 JS 的合法着法表逐项一致;
   - **评估逐位对拍**:随机游走 600 局面,`evaluate(pos)` 与 `engineEvalCp` 完全相等;
   - **开局谱库对拍**:谱内随机游走,每个位置的候选集(line/weight/族名)与
     book.js 的 `bookCandidates` 逐项一致 —— blob 序列化/解析零漂移;
   - **搜索逐位对拍**:自对弈逐手比较 `searchBest`(JS,ms 传超大)与 `engineThink`
     的 move/score/depth/nodes —— 全部相等。搜索按对弈顺序进行,两侧置换表同步演化,
     任何一处实现漂移都会当场炸出。
3. **worker 契约** `node tools/worker-test.mjs`:levels 不触发加载、state 字段形状、
   think 搜索回包、开局库命中(engineBind 绑定谱着)。
4. **JS 回归**:`npm test`(67/67)、`npm run test:book`(10/10)—— 参照实现零改动。

对拍中发现过的坑(都写进了探针):随机游走若选到**士/车升变**,记录的线序列经
「升变一律升后」重演会得到另一个局面 —— 应用层只发升后着法,属探针自身的缺陷;
以及 evalTerms 的滑子扫描缺陷(见上)在 Zig 里数组越界会读到垃圾而非 JS 的
`undefined` 短路,必须显式复刻"只走斜线"。

## 体积与性能

- `wasm/chess.wasm`:raw ≈ 81 KB,**gzip ≈ 25 KB**(置换单表等大头在运行时线性内存,
  不计入下载);webos 侧合并主干时把 JS 引擎 chunk(8.4 KB)换成 worker 胶水 + 本产物。
- 同节点预算下着法与 JS 完全一致,耗时约一半(浏览器 wasm ≈ 60 万 NPS vs JS ≈ 27.5 万);
  等价于**同强度、等待减半**,或在相同等待下把 nodes 预算翻档提强度(后者属
  levels.js 重标定,本次未动 —— 保持与 legacy_js 同难度参数,同预算同着法,便于对照)。

## 重调参 / 改引擎后怎么更新 wasm

```bash
node tools/gen-params.mjs     # eval.js 参数变了:重新导出 params.zig
node tools/gen-book.mjs       # book.js 谱库变了:重新导出 book.bin
node tools/build-wasm.mjs     # 重建 + 自动跑探针(忘了重建或改漂了会在这里被拦住)
git add wasm/chess.wasm src/zig/params.zig src/zig/book.bin
```
