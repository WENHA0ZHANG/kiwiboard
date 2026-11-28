# 回测工具

`docs/algorithm-v2-plan.md` 里的数字都由这里的脚本算出。以后每次改 Regime 或 Watchlist 的规则，都先用它们重跑一遍再上线。

下载的数据和中间结果放在 `work/`（已在 .gitignore 里）。也可以用环境变量 `KB_RESEARCH_DIR` 指向别的目录。需要 Python 3（pandas、numpy、lxml）和 Node。

## 1. 下载数据

下面的命令都在仓库根目录运行。

```bash
mkdir -p research/backtest/work/data/{yahoo,stocks,fred,wiki}
```

**成分股名单**（Wikipedia）。先把 `https://en.wikipedia.org/wiki/List_of_S%26P_500_companies` 存成 `work/data/wiki/sp500.html`，把 `https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies` 存成 `work/data/wiki/ndx_list.html`，然后运行：

```bash
python3 research/backtest/constituents.py research/backtest/work/data/wiki
```

**指数、ETF 和个股日线**（Yahoo）。第三个参数是逗号分隔的代码。个股用 S&P 500 加 Nasdaq 100，再加一些动能股，共约 600 只：

```bash
python3 research/backtest/yahoo_dl.py research/backtest/work/data/yahoo 1985-01-01 "^GSPC,^NDX,^VIX,^VIX3M,^SKEW,SPY,QQQ,^MOVE"
python3 research/backtest/yahoo_dl.py research/backtest/work/data/stocks 2016-01-01 "AAPL,MSFT,..."
```

**FRED 序列**（`fredgraph.csv?id=<序列>&cosd=1985-01-01`）：DGS10、DGS2、T10Y2Y、BAMLH0A0HYM2、DFII10、NFCI、BAA10Y。存到 `work/data/fred/<序列>.csv`。

**线上 D1 的指标历史**，只读，大约读 7,000 行，免费额度是每天 500 万行：

```bash
cd cloudflare/worker && npx wrangler d1 execute poor-trader-db --remote --json \
  --command "SELECT indicator_id, as_of, value, unit FROM observations WHERE as_of >= '2025-04-01' ORDER BY as_of" \
  > ../../research/backtest/work/data/d1_obs.json
```

## 2. Regime 和大盘

| 脚本 | 做什么 |
|---|---|
| `regime_replay.py` | 用 D1 的历史逐日重算线上 v1 分数 |
| `breadth.py` | 计算 NDX 和 S&P 500 成分股站上 20、50、200 日均线的比例，并和 Barchart 对比 |
| `risk_study.py` → `risk_study2.py` | 检验各个风险信号之后的回撤概率，含发布滞后和压力计数 |
| `breadth_study.py` | 检验广度信号，并列出 2026 年见顶前后的各项输入 |
| `zone_study.py` | 检验 SPY/QQQ 的 8/21 EMA 状态和再入场点 |
| `regime_v2.py` | v2 风险分的长期分档，以及 2025–2026 年 v1 和 v2 的对比 |
| `regime_history.cjs` | 用线上的 v2 代码逐日重算 2025-05-01 起的分数，生成回填 `market_regime` 和六个压力序列的 SQL（Key Indicators 的历史图） |

依赖顺序：先跑 `breadth.py`，再跑 `risk_study.py`（生成 `D.pkl`），再跑 `risk_study2.py`（生成 `D2.pkl`），最后跑其他脚本。

## 3. Watchlist

先把线上的分析代码原样打包，再分 8 片逐日回放：

```bash
cloudflare/worker/node_modules/.bin/esbuild cloudflare/worker/src/lib/analysis.ts --bundle --platform=node --format=cjs --outfile=research/backtest/work/analysis.cjs
mkdir -p research/backtest/work/bt
for k in 0 1 2 3 4 5 6 7; do node research/backtest/walk.cjs research/backtest/work/data/stocks research/backtest/work/bt/sig_$k.jsonl $k 8 & done; wait
```

然后依次运行：

- `bt_patterns_sim.py`：模拟突破买入。
- `bt_patterns_sum.py`、`bt_deep.py`：按过滤条件和形态汇总。
- `bt_setups.py`：EP、急跌回踩窄幅 K 线、EMA21 回踩、UnR 这几种买点。
- `bt_warnings.py`：警示信号之后的收益。

统计时只用流动性达标、止损距离 ≥ 1% 的交易：2018 年 FERG 有一笔止损只有 0.01% 的坏数据，单笔就记了 +492R（见计划文档 3.0 节）。

**Watchlist v2 验收**（Special Focus 新打分，每只股票用它自己的买入规则）。`walk.cjs` 读环境变量 `KB_STRESS`，按日期回放当天的市场压力：

```bash
python3 research/backtest/stress_json.py        # 生成 work/stress.json（需要先跑 risk_study2.py）
cloudflare/worker/node_modules/.bin/esbuild cloudflare/worker/src/lib/analysis.ts --bundle --platform=node --format=cjs --outfile=research/backtest/work/bt/analysis_v2.cjs
mkdir -p research/backtest/work/bt/v2
for k in 0 1 2 3 4 5 6 7; do KB_ANALYSIS=research/backtest/work/bt/analysis_v2.cjs KB_STRESS=research/backtest/work/stress.json node research/backtest/walk.cjs research/backtest/work/data/stocks research/backtest/work/bt/v2/sig_$k.jsonl $k 8 & done; wait
python3 research/backtest/bt_focus_v2.py
```

`bt_focus_v2.py` 按门槛 3、4、5 分别汇总：每天的名单数和交易数、计划型和趋势型的平均 R、两个年段和每年的结果。

## 注意

- 股票池是现在的成分股，有幸存者偏差，所以绝对胜率偏高，只能用来比较不同规则。
- 没有计入交易成本和滑点。
- 调参用 2018–2022 年，验证用 2023–2026 年，避免过拟合。
