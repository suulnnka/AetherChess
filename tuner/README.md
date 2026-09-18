# chess-eval-tuner:HCE 调参数据与训练器

评估函数调参(`docs/chess-eval-upgrade.md` §五 / `docs/chess-eval-tuning-plan.md`,训练报告见
`docs/chess-eval-training-report.md`)。训练目标 491 个参数,lichess CC0 数据 32 万条。

## 目录内容

| 文件 | 作用 |
|---|---|
| `sample-lichess-dataset.mjs` | 主数据源采样(lichess 官方评估库,CC0,按相位配额分层) |
| `sample-ssingh22-dataset.mjs` | 备用源(hf parquet,MIT),当前不用 |
| `feature-collinearity.mjs` | 机动性/通路兵的冗余度与样本量实测(参数集大小的依据) |
| `verify-features.mjs` | S0-1/S0-2 双闸门:纯重构逐分一致 + dot(features,w)===evaluate |
| `fit-eval.mjs` | **训练器**:闭式 ridge(向手写先验收缩)+ 覆盖度闸门 + 钉参考格 + 失衡行降权 + 符号投影,产出 `data/fitted-params.*` |
| `duel.mjs` | A/B 自对弈(拟合版 vs 基线,开局自动生成,固定节点预算,多 worker) |
| `baseline/ai-baseline.mjs` | 从 git HEAD 提取的改造前引擎(duel 的对照,A/B 的"旧") |
| `results/` | **入库的产物**:fit-run.log(最终拟合运行原文)、duel-400.log(A/B 全程)、fitted-params.json/.js.txt(参数与元数据)。`data/` gitignore,这里的副本是持久记录 |

## 训练流水线

```
node tuner/fit-eval.mjs        # 训练(读 data/train|val.jsonl)
   ↓ 产出 data/fitted-params.js.txt(FITTED 字面量)
替换 src/eval.js 中的 FITTED(脚本见 training-report)
   ↓
node test/engine-test.mjs                # 67/67 闸门
node tuner/verify-features.mjs # 特征一致性闸门
(webos 侧)npm run build                         # 体积闸门:引擎 chunk gzip ≤35KB,在下游 webos 仓库执行
node tuner/duel.mjs 400 50000 12   # A/B ≥400 局
```

## 当前数据源(唯一):lichess 官方评估库

- 来源:<https://database.lichess.org/#evals>,`lichess_db_eval.jsonl.zst`
  (单文件 ~22GB 压缩 / ~129GB 文本,实测 ~4.8 亿条;Stockfish 评估,每条带 `depth`/`knodes`)
- 许可:**CC0**(database.lichess.org 整站声明),对本项目无任何约束。
- 生成:`node tuner/sample-lichess-dataset.mjs --zst <下载的.zst>`
  - 下载:直连 `database.lichess.org` 可用;`curl -C - -o lichess_db_eval.jsonl.zst https://database.lichess.org/lichess_db_eval.jsonl.zst`
  - 解压走 `7z x -so`(7-Zip ≥ 21 支持 zstd),无其他依赖。
  - 抽样:流式逐行轻扫描(不解析 evals)→ 按相位配额(棋子数分 5 桶)水库抽样
    → 选中行才 `JSON.parse` 提取"depth 最高的 eval 的首 PV"(官方推荐规则)。
  - 质量:只保留 `depth>=20` 的记录;固定种子(SEED=20260918)可复现;
    自动做视角自检(sign(标签) vs 白方子力差),必要时归一到白方视角。
- 输出 `data/train.jsonl`(29.2 万)+ `data/val.jsonl`(3 万),行格式:
  - `{"fen":"...","cp":-58,"d":24,"kn":318482}`(cp 标签)
  - `{"fen":"...","mate":-3,"d":35,"kn":1120341}`(将杀标签)
  - `fen` 为 **4 字段 FEN**(lichess 不带回合计数器),标签为**白方视角**。
  - `d`=该标签的搜索深度,`kn`=千节点数;拟合时可按 d/kn 加权或过滤。

## 备用源:ssingh22/chess-evaluations(MIT)

`sample-ssingh22-dataset.mjs` 从 huggingface(经 hf-mirror.com,直连不通)的 parquet 随机抽样,
字段为 6 字段 FEN + cp 字符串。当前数据集**不用**它,仅当 lichess 管线不可用时备用。

## 注意

- `data/` 已 gitignore:体积大且可由脚本确定性重建(拟合产物 `fitted-params.json` 同理,
  持久副本是 `eval.js` 里的 FITTED 字面量)。
- 两个采样脚本都不做局面合法性校验(着法级),那是引擎/拟合器的事;这里只保证
  FEN 结构正确、标签与源一致。
- ⚠ **数据偏差(训练中实测,详见 training-report)**:lichess 分析库里的失衡局面
  几乎全是"弃子/弃兵且有补偿"的局面(玩家只会分析有意思的局面),直接蒸馏会
  系统性低估子力。训练器用"子力冻结手写值 + 失衡行降权"防御。
