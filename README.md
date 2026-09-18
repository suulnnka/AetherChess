# AetherChess

纯 JavaScript 国际象棋引擎:零依赖、无 DOM、Node 与浏览器 Worker 通用。
从 [WebOS](<https://github.com/suulnnka/AetherWebOS>)(纯前端网页操作系统)的 3D 国际象棋应用中抽离而来,
棋规、搜索、评估、调参、对弈基准全部自研,不借鉴任何开源引擎代码。

**在线体验:** 打开 <https://suulnnka.github.io/AetherWebOS/> 启动「3D 国际象棋」应用 —— 那里面跑的就是本引擎
(Worker 后台思考,四档强度,状态栏实时显示深度/节点数/评分)。

## 引擎构成

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/rules.js` | 483 | 棋规:Int8Array(64) mailbox / int32 打包走法 / make-unmake / 增量 Zobrist(双 32 位)/ replayMoves |
| `src/eval.js` | 441 | 评估:491 参数 HCE(子力 + 中残局 PST 插值 + 兵结构 + 王盾 + 双象 + 机动性 + 通路兵 + 王区威胁),参数由 lichess 评估库 32 万条 Texel 拟合 |
| `src/ai.js` | 455 | 搜索:PVS + 迭代加深 + 置换表 + 静态搜索(δ 剪枝 + SEE)+ 空着剪枝 + LMR + reverse futility + aspiration 窗口 + 将军延伸,MVV-LVA / killer / history 排序 |
| `src/worker.js` | 41 | Worker 薄壳:`{id, moves, nodes, ms, depth}` → `{id, move, depth, nodes, ms, score}` |

**硬性约束**:`src/` 下不 import 渲染库、不碰 DOM —— Worker 与 Node 测试共用同一份代码,不存在两条解析路径。

- 强度:约 **2030 Elo**(与限深 Stockfish 交叉对弈标定,见 `docs/chess-ai-plan.md` §9.5;评估调参后又有提升,见 `docs/chess-eval-training-report.md`)
- 难度:4 档(初级/中级/高级/大师),按**节点预算**划分 —— 设备无关、同机可复现;低档用"最优着法 N 分以内随机挑"控弱,不会前后矛盾
- 体积:引擎 chunk gzip 约 **8.4 KB**(下游 webos 卡 35 KB 预算闸门)

## 用法

```js
import { newPos, make, genLegal } from './src/rules.js';
import { searchBest, LEVELS, DEFAULT_LEVEL } from './src/ai.js';

const pos = newPos();
const r = searchBest(pos, LEVELS[DEFAULT_LEVEL]);   // { move, score(白方视角厘兵), depth, nodes, ms }
make(pos, r.move);
```

浏览器里放 Worker 跑(见 `src/worker.js`):主线程只传走法序列 `(from<<6|to)[]`,
Worker 重演出局面再搜索,结构化克隆代价最小。

## 测试与基准

```bash
npm test                      # perft(6 局面精确匹配)+ 旧实现对拍 + make/unmake 还原 + 和棋规则,67/67
node test/engine-test.mjs --quick   # 快速档
node test/engine-test.mjs 2         # 只跑第 2 节(--list 查看全部)

node bench/uci-bench.mjs --depth 5 --games 8        # vs 限深 Stockfish(JS 构建,自动 npm pack 拉取)
node bench/wasm-bench.mjs --level hard --games 8    # vs chessy 的 Rust/WASM 引擎
node bench/uci-match.mjs --a A.mjs --b B.mjs        # 任意两个 UCI 引擎互打
```

对弈工具依赖的外部引擎二进制不入库(`bench/vendor/` 已 gitignore),首次使用按脚本内提示下载。

## 评估调参

`tuner/` 是完整的 HCE 调参流水线:lichess 官方评估库(CC0)按相位配额抽样 32 万条 →
闭式 ridge 拟合(钉参考格 + 失衡行降权 + 符号投影)→ 特征一致性闸门 → A/B 自对弈 ≥400 局验证。
详见 `tuner/README.md` 与 `docs/`。

## 文档

| 文档 | 内容 |
|---|---|
| `docs/chess-ai-plan.md` | 引擎方案与全部实测:文件拆分、搜索/评估设计、体积闸门、棋力标定(Elo)、各项优化的数据结论 |
| `docs/chess-eval-upgrade.md` | 评估升级决策:三方(手写/lichess 拟合/参数集)对照与许可证核查 |
| `docs/chess-eval-tuning-plan.md` | 调参决策:参数集设计、采样器、闸门、验收标准 |
| `docs/chess-eval-training-report.md` | 训练报告:拟合结果、A/B 对弈数据、落地过程 |

## License

MIT
