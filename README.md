# AetherChess

Zig/WASM 国际象棋引擎:规则、评估、搜索、开局谱库全部编译进一份 chess.wasm,
JS 侧只剩一个 Worker 门面(src/worker.js)。从 [WebOS](<https://github.com/suulnnka/AetherWebOS>)
(纯前端网页操作系统)的 3D 国际象棋应用中抽离而来,棋规、搜索、评估全部自研,
不借鉴任何开源引擎代码。仓库内`没有第二份引擎实现` —— 不存在两条解析路径。

**在线体验:** 打开 <https://suulnnka.github.io/AetherWebOS/> 启动「3D 国际象棋」应用 —— 那里面跑的就是本引擎
(Worker 后台思考,四档强度,状态栏实时显示深度/节点数/评分)。

## 在线对弈页(GitHub Pages,免 CI)

本仓库自带一个**开箱即玩的对弈页**:布局与交互取自 WebOS 的国际象棋应用,
同一份 Worker 契约接的也是本仓库的引擎 —— wasm 通道(zig → chess.wasm),含编译期内嵌开局谱库。**没有构建、没有 CI**:站点即仓库本身,GitHub Pages 原样引用仓库文件直接出页面:

**<https://suulnnka.github.io/AetherChess/>**

页面即仓库布局:`index.html`(根)+ `pages/`(页面资产),引擎入口在 `src/`、
wasm 在 `wasm/`,全部按相对路径引用 —— 本地预览无需构建,仓库根起任意静态
服务器即可:

```bash
python3 -m http.server 8000     # 仓库根起服
# 打开 http://localhost:8000/
```

线上开启只需一次:仓库 **Settings → Pages → Build and deployment → Source 选
「Deploy from a branch」,Branch 选默认分支 + `/(root)`**;此后每次推送自动更新,
不走任何 Actions。

功能与 WebOS 应用一致:新对局 / 难度(引擎自报表)/ 人机或双人 / 换边 / 悔棋
(开局库谱着直出,将死 / 逼和 / 子力不足 / 三次重复自动判终局),底栏左侧行棋状态、右侧实时引擎搜索信息。


## 单实现:zig → wasm,JS 只当门面

历史上这里曾有 JS 参照实现(rules/eval/ai/book)与 zig 移植双轨并行,靠逐位对拍锁一致。
2026-09 起 JS 参照实现整体移除:zig 是引擎的唯一源码,`src/zig/* → wasm/chess.wasm`,
WebOS 国际象棋应用与对弈页跑的都是它。正确性闸门由 zig 原生测试接替
(`zig build test` 单元测试、`selftest` 原生自测)加上产物冒烟
(`tools/wasm-smoke.mjs`:perft 标准值 + 出招合法性 + 自弈走查),
`npm run build:wasm` 每次重建都会自动跑一遍。移植史与 ABI 见 `docs/zig-port.md`(历史文档)。

## 引擎构成

| 文件 | 职责 |
|---|---|
| `src/zig/rules.zig` | 棋规:Int8Array(64) mailbox / int32 打包走法 / make-unmake / 增量 Zobrist(双 32 位)/ replayMoves |
| `src/zig/eval.zig` | 评估:491 参数 HCE,全整数运算(子力 + 中残局 PST 插值 + 兵结构 + 王盾 + 双象 + 机动性 + 通路兵 + 王区威胁),参数由 lichess 评估库 32 万条 Texel 拟合 |
| `src/zig/search.zig` | 搜索:PVS + 迭代加深 + 置换表(2^19 槽)+ 静态搜索(δ 剪枝 + SEE)+ 空着剪枝 + LMR + reverse futility + aspiration 窗口 + 将军延伸,MVV-LVA / killer / history 排序 |
| `src/zig/book.zig + book.bin` | 开局谱库:二进制 blob 编译期嵌入(3800 条谱线 + 双语开局族名) |
| `src/worker.js` | wasm 的唯一 JS 门面:ping/levels/state/think 消息契约,难度表内联 |

**硬性约束**:`src/zig/` 不 import 渲染库、不碰 DOM;JS 侧无引擎逻辑,只有消息编解码。


## 用法

引擎不作为库导出 —— 通过 Worker 消息契约使用(见 `src/worker.js` 头注释):
主线程只传走法序列 `(from<<6|to)[]`,Worker 重演出局面再搜索/查谱,
结构化克隆代价最小。`{type:'state'}` 提供棋规查询(棋盘/合法着法/终局判定),
应用侧不需要第二份棋规实现。


## 测试与基准

```bash
npm run selftest              # 原生自测:perft/不变量/战术/残局/NPS 基准
npm run test:zig              # 单元测试(zig test)
npm run build:wasm            # 重建 wasm/chess.wasm,自动跑 zig test + 产物冒烟(改引擎后必跑)
npm run test:worker           # worker 胶水层契约测试

node bench/uci-bench.mjs --depth 5 --games 8        # vs 限深 Stockfish(JS 构建,自备)
node bench/wasm-bench.mjs --level hard --games 8    # vs chessy 的 Rust/WASM 引擎
node bench/uci-match.mjs --a A --b B                # 任意两个 UCI 引擎互打,wasm 当裁判
```

bench 三件套的棋规裁判与本引擎选手**都走 wasm**(bench/referee.mjs):
五十步规则由裁判层手工计数(wasm 无此导出),升变按引擎口径只收升后。
对弈工具依赖的外部引擎二进制不入库(`bench/vendor/` 已 gitignore),
首次使用按脚本内提示下载。

