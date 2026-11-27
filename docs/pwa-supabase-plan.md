# Poor Trader → PWA + Google 登录 + 推送：实施方案

## 原则

- **不登录照常可用**：poortrader.com 现在的体验保持不变。用 Google 登录后才多出两样：自己的 Watchlist 云同步、Poor2Rich 档位推送。
- **数据分工**：市场数据继续放在 Cloudflare Worker + D1；用户数据（自选股、提醒偏好、设备订阅）放 Supabase，靠 RLS 让每个用户只能读写自己的行。
- **先上预览环境**：新功能先部署到 Pages 预览分支 / staging Worker，确认没问题再推到 production。

## 架构

```
 手机/电脑 (PWA)                    Supabase (free)                     Cloudflare
 ┌──────────────────┐  Google 登录   ┌──────────────────────┐            ┌───────────────────────────┐
 │ index.html       │ ─────────────▶ │ Auth (Google OAuth)  │            │ Worker poor-trader-api    │
 │ + supabase-js    │  anon key+JWT  │ Postgres + RLS       │ ◀───────── │ cron */30:                │
 │ + sw.js          │ ─────────────▶ │  watchlist_items     │ service_   │  1 抓指标 → D1            │
 │   (push 显示)     │                │  notification_prefs  │ role key   │  2 算 Poor2Rich 档位      │
 └────────▲─────────┘                │  push_subscriptions  │            │  3 档位变了 → 查订阅       │
          │                          │  notification_log    │            │  4 Web Push (VAPID)       │
          │ 通知                      └──────────────────────┘            └─────────────┬─────────────┘
          └──────────── Push 服务 (Apple / Google FCM / Mozilla) ◀────────────────────────┘
```

## 已完成

- 备份分支 `backup/pre-pwa-2026-11-26`：线上正在跑的版本，含当时未提交的改动。
- PWA 基础：`cloudflare/pages/manifest.webmanifest`、`sw.js`、猕猴桃图标（favicon / iOS / Android maskable / 通知徽章），以及 `index.html` 里的 head 标签和 service worker 注册。
- `secrets/supabase.env`：已被 gitignore，存 DB 密码，以及之后要填的各种 key。
- `supabase/schema.sql`：表、RLS 策略、RPC，可以直接贴进 SQL Editor 运行。

## 你需要在控制台做的（一次性）

1. **Supabase**：新建项目（free）。把 Project URL 和 Publishable key（`sb_publishable_…`，就是原来的 anon key）填进 `secrets/supabase.env`；Secret key 等做推送时再填。
2. **Supabase → SQL Editor**：运行 `supabase/schema.sql`。
3. **Google Cloud Console → APIs & Services**
   - OAuth consent screen：选 External，scopes 用 `email`、`profile`、`openid`，然后 **Publish**。不发布的话只有测试用户能登录。只用这些基础 scope，一般不需要 Google 审核。
   - Credentials → Create OAuth client ID → 类型选 Web application。
     - Authorized redirect URI：`https://<project-ref>.supabase.co/auth/v1/callback`
4. **Supabase → Authentication → Sign In / Providers → Google**：打开，填入 Client ID 和 Secret。
5. **Supabase → Authentication → URL Configuration**
   - Site URL：`https://poortrader.com`
   - Redirect URLs：用精确地址，生产环境不建议用 `**`。代码里登录完回到的就是站点根路径 `/`。
     - `https://poortrader.com/`
     - `https://*.poor-trader-dashboard.pages.dev/`（预览部署用；`*` 只匹配一段子域名）
     - `http://localhost:8788/`（本地测试用）
   - 同一页的 **Providers → Email** 建议关掉，只保留 Google，避免有人用邮箱注册冒充。
6. **把 Project URL 和 anon key 填到两处**（这两个值本来就是公开的，可以提交到 git）：
   - `cloudflare/pages/index.html` 底部的 `window.SUPABASE_URL` 和 `window.SUPABASE_ANON_KEY`。
   - `cloudflare/worker/wrangler.toml` 里 `[vars]` 的 `SUPABASE_URL` 和 `SUPABASE_ANON_KEY`。
7. **设管理员**：只有管理员能编辑公共 Watchlist。这一项是 secret，不写进 toml：

   ```bash
   cd cloudflare/worker && npx wrangler secret put ADMIN_EMAILS
   ```

   提示输入时填你的 Gmail，多个邮箱用逗号分隔。

## 分阶段实施

### Phase 1：PWA 上线 + 手机布局（不动后端）

先部署到预览地址，production 不受影响：

```bash
cd cloudflare/worker && npx wrangler pages deploy ../pages --project-name poor-trader-dashboard --branch pwa
```

预览地址是 `https://pwa.poor-trader-dashboard.pages.dev`。

**手机布局已完成（2026-11-26，本地，未部署）**。所有样式都写在 `index.html` 末尾的媒体查询里，≥1100px 的桌面布局和改动前逐项对比一致。

- **≤720px（手机）**
  - 底部 tab bar（图标 + 短标签），适配 iPhone 底部安全区。
  - 页头显示 Regime 分数小标签（Prediction 页隐藏，因为那一页本身就以 Regime 卡片开头）。
  - 宽表格在卡片内横向滑动，首列固定。
  - 去掉的列：Market 页的 Date 列、指标表的 Source 列。
  - 图表高度调矮。
  - 输入框字号设为 16px，防止 iOS 聚焦时自动放大页面。
  - 切换 tab 时回到顶部（关闭了会把页面往下拖的滚动锚定）。
- **≤1099px（单列布局，包括平板）**
  - Market Regime 卡片排在最前。
  - 隐藏导航栏时钟和 tab 编号（原来这一排会超出屏幕）。
- **顺手修复**：卡片标题里浮动的 meta 会挤窄 Market Timing 卡片，用 `display: flow-root` 解决。
- **验证**：在 360、390、820 三个宽度下，5 个页面都没有横向溢出。

**安装引导已完成（2026-11-26，本地，未部署）**

- **Android / Chrome / Edge**：捕获 `beforeinstallprompt`，手机和平板上弹出底部横幅「Install」，点了调用原生安装。
- **iOS**：横幅提示「点分享 → 添加到主屏幕」。
- **微信、Instagram 等内置浏览器**：提示「用 Safari / Chrome 打开」。
- **其他行为**：
  - 关掉横幅后 14 天内不再自动弹出，页头的「Install app」链接一直可以用。
  - 已安装的 App 里不显示任何安装提示。
  - 桌面 Chrome 只在页头显示链接，不弹横幅。

### Phase 2：Google 登录 + 个人 Watchlist（代码已完成，2026-11-26，本地，未部署）

- **登录**：
  - supabase-js 锁定在 2.118.0，从 CDN 加载并做 SRI 校验，`flowType: 'pkce'`。
    - 必须用 PKCE：网站的 tab 用 `#hash` 路由，implicit flow 会把 `#access_token=…` 塞进 hash，两者冲突。
  - 只有填了 `SUPABASE_URL` 才会加载 supabase-js；没填时网站和原来完全一样。
  - 登录回来后会回到出发时的那个 tab。
  - 页头：未登录显示「Sign in with Google」；登录后显示头像、名字和「Sign out」，管理员多一个 admin 标记。
- **Watchlist 三种模式**（`window.ptAuth.listMode`）：

  | 模式 | 适用对象 | 列表 | 能做什么 |
  | --- | --- | --- | --- |
  | `public` | 未登录 | 公共列表 | 只读：没有添加框、删除按钮和拖拽，显示「Sign in」提示 |
  | `personal` | 普通用户 | 自己的列表，存在 Supabase `watchlist_items`（RLS） | 增、删、拖拽排序；排序走 `reorder_watchlist` RPC |
  | `admin` | ADMIN_EMAILS 里的用户 | 公共列表 | 编辑，Worker 会校验 token |

  - 个人列表为空时，可以一键「复制公共列表」。
- **Worker**：
  - `GET /api/watchlist?symbols=A,B,…` 给个人列表打分，用的是所有用户共享的缓存。
  - 每次请求最多新算 12 个，剩下的放在 `pending` 里，前端最多轮询 8 次。
  - 个人列表的数据超过 30 分钟会重新计算。
  - 新增 `GET /api/me`，返回当前用户是否是管理员。
- **安全修复**：
  - `POST/DELETE /api/watchlist`、`/reorder`、`POST /api/watchlist/refresh` 现在都要求 Supabase 登录，并且邮箱在 `ADMIN_EMAILS` 里。
  - `?refresh=1` 每个 IP 2 分钟最多一次，超过就直接返回缓存。
  - 原来这些写接口任何人都能调用。
- **部署后、填好配置前的状态**：没有人能通过网页编辑公共列表，包括你自己。需要的话可以用 `wrangler d1 execute` 编辑。
- **还没做**：Market 页的 Stocks 列表（目前存在 localStorage）同步到账号。`watchlist_items.list = 'market'` 已经预留。

### Phase 3：Poor2Rich 档位推送（2026-11-26 已部署：Worker `5e16764e`，Pages `b982715b`）

已实现的部分（按下面的设计）：

- **Worker 新模块**：
  - `lib/webpush.ts`：VAPID 和 aes128gcm 加密，只用 WebCrypto。用 `node scripts/test-webpush.mjs` 对照 RFC 8291 附录 A 的测试数据逐字节验证过。
  - `lib/alerts.ts`：档位状态机，和档位要连续出现 2 次才算变化、同档 12 小时内不重复两条防抖规则。
  - `lib/supabase.ts`：用 secret key 访问 Supabase。
- **cron**：每 30 分钟在指标入库后执行 `checkRegimeAlert`。部署后第一次运行只记录基准，不推送。
- **测试接口**：`POST /api/push/test`，需要登录，只发给调用者自己的设备，每人每分钟最多一次。
- **前端**：
  - Regime 卡片上有「Alerts」按钮（扁平铃铛图标），登录后点页头头像，菜单里有「Regime alerts」，都会打开提醒设置对话框。
  - 对话框里可以开关本设备的推送、勾选档位、发测试通知。
  - 退出登录时会自动关掉这台设备的提醒。
- **配置**：
  - VAPID 公钥放在 `index.html` 和 `wrangler.toml`，私钥是 Worker secret `VAPID_PRIVATE_KEY`（已设置）。
  - `SUPABASE_SECRET_KEY` 已设置。
- **推送标题**：「Market regime: Buy (+4.7)」，不带 emoji（KiwiBoard 风格）。

原设计：

- **VAPID 密钥**：本地用 Node 自带的 crypto 生成，不需要第三方服务。公钥放前端，私钥用 `wrangler secret put VAPID_PRIVATE_KEY` 存。
- **前端**：
  1. 用户点「🔔 开启提醒」按钮，在这个点击里调用 `Notification.requestPermission()`（必须由用户手势触发）。
  2. 调用 `pushManager.subscribe`。
  3. 调用 `rpc('save_push_subscription')` 保存订阅。
  4. 设置里可以勾选要接收的档位，默认 Strong Buy、Buy、Cautious Buy、Risk、Strong Risk。
- **Worker cron**（现有的 `*/30`，在指标写入 D1 之后执行）：
  1. 调用 `computeMarketRegime` 得到当前档位。
  2. 和 D1 `kv_store` 里「上次通知的档位」比较。
  3. 防抖：新档位要连续 2 次 tick（1 小时）都一样才算数；同一个档位 12 小时内不重复推送。
  4. 档位变了，并且新档位在提醒列表里：调用 `rpc('regime_alert_targets', {p_label})` 取收件人，然后发 Web Push。用 WebCrypto 实现 VAPID + aes128gcm，不引入 npm 依赖。
  5. Push 服务返回 404 或 410 时，删掉对应订阅。每次推送都写入 `notification_log`。
- **推送内容示例**：标题「📈 Poor2Rich → Buy (+5.2)」，正文「Cautious Buy → Buy · VIX 30.6, F&G 13.7 …」，点开跳到 `/#prediction`。
- **开关**：用环境变量 `PUSH_ENABLED` 控制。先在 staging Worker 上用手动触发的测试接口验证，再对 production 打开。
- **以后可以扩展**：个股提醒，比如 focus_score ≥ 4、形态突破。`notification_log.kind` 已经预留了。

## KiwiBoard 视觉改版（2026-11-26 已部署）

按 `KiwiBoard-design-updated.zip` 的设计规范改版，只改视觉，没有改任何计算、信号阈值、接口或刷新频率。

- **名字**：显示名「Poor KiwiBoard」（域名暂时还是 poortrader.com）。manifest 的 `short_name` 和 iOS 主屏幕名是「KiwiBoard」，因为「Poor KiwiBoard」在主屏幕会被截断。
- **图标**：只有页头「Poor KiwiBoard」旁边用 Kiwi Slice 标志（内联 SVG，颜色跟随主题）；favicon、App 图标、安装横幅、推送通知仍然用原来的半个猕猴桃。
- **主题**：浅色（纯白）/ 深色（中性炭灰，不带绿色调），页头按钮切换，选择存在 `localStorage` 的 `kb.theme`；没选过就跟随系统。图表在切换时用新颜色重画；当时不在屏幕上的图表，等切到那个 tab 再重画（隐藏状态下重画会让世界地图的标记错位）。
- **字体**：Inter（Google Fonts），数字用等宽数字。
- **Overview 页**：大标题 + 4 个 KPI（S&P 500、Nasdaq、VIX、Fear & Greed，全部真实数据）+ 指标走势图 + Market Regime 面板（分数、7 段刻度、Top/Bottom signals、可展开的档位阈值）+ Key Indicators 表（新增 Status 列）+ Regime Drivers。手机和平板上 Market Regime 仍然排在最前面。
- **页头**：「● Live / Delayed / Offline」按数据更新时间判断（45 分钟内算 Live）；登录前只显示「Sign in」，登录后是头像，点开菜单里有 Regime alerts 和 Sign out，不再显示 admin 标记。
- **手机**：保留底部 tab 栏（PWA 更顺手），图标换成统一的细线图标。

### 第二轮调整（2026-11-26 已部署：Worker `6d27fc5c`，Pages `02c9f128`）

- **名字**：改成全小写的 `kiwiboard`，slogan 是「A fresh cut of the market.」（Overview 副标题、页脚、manifest 描述）。主屏幕名也是 `kiwiboard`。
- **图表**：去掉生长 / 绘制动画，所有图表统一淡入（`.kb-fade`）。
- **Market Regime**：档位名（Buy 等）放大在上面，分数在下面。
- **手机**：安装入口改成第一行的下载图标；底部 tab 改为 Market / Watchlist / Global / News / Signals（桌面仍显示完整名字）。
- **Markets & News**：日期和数字不再换行；1280px 以下改为单列，表格不需要横向滚动。
- **设置**（头像菜单 → Settings，或 Regime 卡片的 Alerts 按钮）：
  - 账号信息和退出登录。
  - 主题：System / Light / Dark。
  - Regime alerts：开关、档位、测试通知。
  - 重置个人 watchlist：只对普通用户显示，管理员编辑的是公共列表。
  - 重置 Markets 页的 Stocks 列表：存在这台设备的 localStorage。
  - 删除账号：要输入 DELETE 确认，通过 Worker `DELETE /api/account` 删除 Supabase 用户，所有用户表 `on delete cascade`。
- **推送文字**：标题「Regime: Buy (+4.7)」，正文「Up from Cautious Buy」。
- **主屏幕图标**：半个猕猴桃有暖白底 `#FBF8EE`（`apple-touch-icon-light.png`、`icon-maskable-light-*`）和深灰黑底 `#1C1C1C` 两套，页面按设备的浅色/深色模式选择 `apple-touch-icon` 和 manifest（`manifest.webmanifest` / `manifest-dark.webmanifest`）。限制：iOS 和 Android 都只在「添加到主屏幕」那一刻读取图标，装好之后不会随系统切换。

### 第三轮：手机精简（2026-11-26 已部署：Pages `ec183e75`，只改了 `index.html`，Worker 不变）

只在 ≤720px 生效，桌面和平板不变。375px 宽下各页高度：Market 3841→2602，Watchlist 4367→2963，Global 2694→1903，News 3278→3220（去掉了卡片内的滚动框），Signals 4950→1354。

- **Watchlist K 线图（手机）**：
  - 图例固定两行：先 EMA，再 Stop/TP。
  - 价格轴约 4 个刻度，成交量轴只显示 300M/600M 两个。
  - 日期只显示在成交量下面。
  - 缩放条加粗到 32px，两端是圆角大把手。
  - 触屏上单指拖动用来滚动页面，双指缩放图表。
  - Stop/TP 标签画在线的右端上方，重叠时自动错开。
  - 图下面那段说明文字在手机上隐藏。
- **Watchlist**：
  - 添加股票去掉了 Optional note，输入框和 Add 在同一行。已有的 note 仍会显示。
  - 6 个周期按钮在一行。
  - 8 个指标改成 4×2 的小格，手机上成交量显示 532M 这种 3 位有效数字。
  - Stop / TP1 / TP2 并排显示，点一下展开完整计划。
  - Market Timing 只显示名称、价格和状态，点一下看 EMA。
  - Glossary 折叠。
- **Global**：
  - 指数新闻改为最新的在上面（桌面也是）。
  - 手机上只显示最近 3 次异动，其余放在「Show N earlier moves」后面。
  - 点图上的点会自动展开列表，并滚到对应那一天。
  - 区间按钮在一行；标题去掉「Index Detail —」。
- **Market**：
  - Regime Drivers 只显示有分数的行，0 分的放在「Show N at 0 points」后面。
  - Key Indicators 改成两行一条的紧凑列表，用短名；点一条会滚回上面的图。
  - F&G 图只显示 3 个日期，阈值标签改成「Top 75」这种短写法。
- **News**：个股新闻不再是卡片里的滚动框。默认显示 3 条，摘要截成 2 行，点一下展开。
- **Signals**：
  - Market Regime Algorithm 和历史顶底表默认折叠，点标题展开。
  - Bull/Bear Alerts 每个指标一行，只有真正的 Top/Bottom 才显示标签，点一下看规则。
- **其他**：
  - 非 Overview 页面的副标题在手机上隐藏。
  - 页脚的数据来源收进「Sources & contact」按钮。
- **实现**：
  - `data-fold`：卡片只显示标题，点标题展开。
  - `data-m-toggle`：点一下给元素加上 `.open`。
  - `_mFold()`：长列表加一个「Show N more」按钮。
  - `.d-only` / `.m-only`：只在桌面或只在手机显示。
  - 以上都只在手机宽度生效。

### 第四轮：按公司名添加股票（2026-11-26 已部署：Worker `1a6dad14`，Pages `f10840b7`）

起因：用户在 Watchlist 输入公司名，比如 google，会被当成股票代码 GOOGLE 存进去，变成一行空数据。Markets 的 Stocks 框也有同样的问题。

- **Worker** `GET /api/symbol-search?q=`（`lib/symbols.ts`）：
  - 走 Yahoo 的搜索接口，只返回股票和 ETF，美股（代码不带 .XX 后缀）排在前面。
  - query1 拿不到结果时会换 query2 再试一次。
  - 搜索结果缓存在 isolate 内存里，因为 workers.dev 上 Cache API 不起作用。
  - 每个 IP 每分钟最多 60 次。
- **`resolve=1`**（点 Add 或按 Enter 时调用）：
  - 精确的代码（nvda、BRK.B → BRK-B）直接添加。
  - 公司名能对上唯一一家美股时直接添加（apple → AAPL、coca cola → KO）。
  - 名字对不上（google → Alphabet）或两种解释冲突时，不自动添加，列出候选让用户选。
  - 两种解释冲突的例子：ford 既可以是 FORD 这个代码，也可以是福特汽车 F。FORD 在 Yahoo 没有价格数据时，按 F 处理。
- **服务器校验**：`POST /api/watchlist` 存之前先确认这个代码在 Yahoo 存在，并且用正式公司名作为显示名。
- **页面**：
  - 两个添加框都有输入提示，候选列表在输入框下面，占整行宽，不会被卡片裁掉。
  - 支持方向键、Enter、Esc，手机上点一下就添加。
  - Stocks 框只收美股。
  - Watchlist 里抓不到价格的旧行，代码旁边会显示 "no data"，用每行末尾的 × 删除。
- **部署顺序**：先部署 Worker，再部署 Pages。新页面依赖新接口，反过来的话添加功能会暂时不能用。

### 第五轮：图表、手机细节和 D1 读取超限（2026-11-26 已部署：Worker `0261a32a`，Pages `5e855b90`）

**D1 超限（当天线上数据接口全部 500）**
- 2026-11-26 过去 24 小时读了 604 万行，超过免费版每天 500 万行。超限后所有读数据的查询都报 `D1_ERROR … daily row read limit`（code 7500），Worker 返回 1101，页面上指标、档位、Watchlist 都加载不出来，直到 UTC 0 点（新加坡早上 8 点）重置。11-27 早上 8 点重置后全部恢复。
- 原因：两条查询每次都扫整张 `observations`（约 4,600 行）。
  - `getLatestObservations`（`GROUP BY indicator_id`），一天约 900 次，417 万行。
  - `getLastUpdateTime` 的 `MAX(inserted_at)`，一天约 350 次，162 万行。
- 修复：
  - `getLatestObservations` 改成递归 CTE，沿主键 (indicator_id, as_of) 逐个找指标，每个指标只做几次索引查找。本地用 seed 数据对比，结果和旧查询完全一样（17 行），全表扫描步数从 3,527 降到 0。
  - `schema.sql` 新增 `idx_observations_inserted_at`，让 `MAX(inserted_at)` 只读 1 行。线上已在 2026-11-27 08:03（新加坡时间）额度重置后建好，查询计划是 `SEARCH observations USING COVERING INDEX idx_observations_inserted_at`。别的已有数据库要补建的话用这条命令（建的时候要读整张表）：
    `npx wrangler d1 execute poor-trader-db --remote --command "CREATE INDEX IF NOT EXISTS idx_observations_inserted_at ON observations(inserted_at);"`
  - 实测（11-27 重置后的两小时）：每小时读 1.8 万到 2.9 万行，折合每天 40 万到 70 万行，约为额度的十分之一。最新值的递归 CTE 每次读 50 到 70 行（旧查询约 4,460 行），`MAX(inserted_at)` 每次读 1 行。现在读得最多的是 `getRecentObservations`（指标走势图和收益率曲线的历史数据，每次约 300 行，读到的都是要用的数据）。
- 查看用量：`npx wrangler d1 info poor-trader-db`（rows_read_24h 是滚动的 24 小时，不是按 UTC 天算的额度）；找最耗读取的查询：`npx wrangler d1 insights poor-trader-db --timePeriod 1d --sort-by reads --sort-direction DESC`（只看重置以后的用量，可以按小时算，比如 `--timePeriod 2h`）。

**页面**
- 指标走势图：Top / Bottom / Latest 标签加了底板，数值简化（"Latest 15"，不再写 "15.00 0-100"），并优先放在曲线不经过的位置。
- 电脑端标签和手机一致：Market · Watchlist · Global · News · Signals（页面大标题不变）。
- 电脑端 Watchlist 输入框从 240px 加宽到 400px。
- 代码/公司名候选列表改成浮在表格上方（不再把表格往下挤），打开时卡片暂时不裁剪。
- 手机顶部一行：kiwiboard、档位小标签（"Buy +4.7"）、按钮。放不下时只显示分数，再放不下就隐藏（`_fitRegimePill`）。
- 手机地图按地图比例显示（`aspect-ratio: 1.75`，约 194px 高，原来 290px），标题改成两行：标题 + Reload / 时间 + 缩放按钮。
- Watchlist 图表：拖动下方滑块时，以前只有成交量跟着变（`echarts.connect` 按 dataZoom 的 id 配对，滑块只在成交量图里）。两张图现在用同样的 id（`wl-zoom-inside`、`wl-zoom-slider`），价格图里放了一个隐藏的滑块，拖动和双指缩放都会两边同步。电脑端以前也有这个问题。

### 第六轮：News 页（2026-11-26 已部署：Worker `e3005b82`，Pages `7e346e49`）

- 页面标题 "Markets & News" 改成 "News"，和标签一致；副标题 "Today's headlines, futures, crypto and your stocks."。设置里两个列表的说明改成 "On the News tab"。
- 删掉 US Market Indices 卡片。Futures & Crypto 和 Stocks 平分左栏高度，表格在卡片里滚动。
- Futures & Crypto 可以自由添加加密货币和期货：
  - 按名字或代码搜："eth" → ETH-USD，"crude oil" → CL=F，"ES" → ES=F；"oil" 这种含糊的词弹出候选列表。
  - 每行可以置顶、删除。列表存在这台设备的 localStorage（`market.customAssets`、`market.hiddenAssets`、`market.assetOrder`），设置里可以重置。默认 BTC、XAU、XAG，删掉以后再搜可以加回来。
  - Worker：`/api/symbol-search?kind=assets`（Yahoo 的 CRYPTOCURRENCY / FUTURE），`/api/market-overview?assets=ETH-USD,CL=F`（最多 30 个；自己加的行超过 30 分钟会重新拉取）。
- 右边图表默认是比特币，标题行显示全名（"Bitcoin · BTC-USD"）。加密货币和期货也有新闻（Yahoo 新闻搜索；加密货币按名字搜，因为搜 "BTC-USD" 没有结果）。
- 指数名字去掉 "^"：S&P 500 / Dow Jones / Nasdaq。
- 电脑端（≥1280px）表格和图表各占一半：
  - 表格文字都不换行。1280–1439px 单元格左右边距 6px、字号 13px，1440px 起边距 8px、字号 14px。1280px 时表格还剩约 38px 余量，不需要横向滚动。
  - 图表标题行保持一行，公司名太长时以 "…" 结尾，鼠标悬停显示全名。
- 页脚改成 "kiwiboard · a fresh cut of the market."（小写 a）。
- D1 读不了的时候 News 页照常显示：`/api/market-overview`、`/api/stock-detail` 的新闻和 `/api/market-news` 的 D1 缓存读写失败时，直接从 Yahoo / Finnhub 拉取。Market Headlines 请求失败时显示 "Headlines are unavailable right now."，不再一直停在 Loading。
- README 只改了文字（News 介绍和 API 表）。截图里没有 News 页，所以没换图。
- 部署时 D1 还在超限（11-26 23:30 新加坡时间查过，24 小时读 612 万行），News 页照常可用。11-27 早上 8 点重置后，其他接口全部恢复，第五轮的 `idx_observations_inserted_at` 也在 08:03 建好了。

### 第七轮：Watchlist 和 News 表格（2026-11-27 已部署：Pages `7e4324fc`，Worker 没变，仍是 `e3005b82`）

只改了 `cloudflare/pages/index.html`。原则：文字不折成两行，表格里不留大块空白。

**Watchlist 页**
- Glossary：每行一个术语，缩写单独一列（84px），解释对齐。电脑侧栏里一列，平板全宽时两列（CSS `columns: 290px`）。"Stop / TP1 / TP2" 拆成两条；"(W)" 改成 "Pattern on the weekly chart"。
- Market Timing：副标题只写 "Daily · 8 / 21 / 50 EMA"，和标题在同一行，更新时间放进悬停提示。三个方块在所有宽度都一行一个。以前 681–1024px 三个并排，每个约 210px，名字会折行；一行放下名字、价格和涨跌要约 290px。
- My Watchlist 标题区（`.wl-head`）：
  - 第一行是标题和 Reload。
  - 第二行是添加框（未登录时是登录提示），占满整行，和 Futures & Crypto 一样，所以候选列表一样宽，公司名完整显示。添加框曾试过放进标题行，但用户觉得框变短、下面的候选也跟着变短，所以改回第二行。
  - 添加提示浮在输入框下方，表格不会跳动。
- 表格：
  - Symbol 列和按钮列只占需要的宽度（`width: 1%`），多余空间平均分给数字列，股票代码和价格之间的空隙和其他列一样。
  - 每行末尾加了和 News 一样的置顶、删除图标按钮。置顶由 `_wlMoveToTop` 实现，保存方式和拖动排序相同（admin：`POST /api/watchlist/reorder`；个人列表：Supabase `reorder_watchlist`）。还没有在登录状态下实际测过。
- 手机（≤720px）：固定的第一列两边各留 16px，其他单元格左右 8px，约 700px 宽时表格不用横向滚动。

**News 页表格**
- 列宽：Name 12%、Date 10%、Latest 14%、1W/1M/3M/1Y 各 13%，按钮列 `width: 1%`（以前 19%）。1440px 时 1Y 到置顶按钮的空白从约 50px 减到 29px；1280px 也不折行、不横向滚动。
- 手机：固定列两边留 14px。
- 修复了线上原有的问题：手机上表格上下滚动时，第一行盖住表头 "Name"。原因是桌面的表头规则（`:is(.stocks-card, .assets-card) .stocks-table-wrap thead th`，z-index 1）优先级更高，把左上角单元格的 z-index 3 压掉了。

### 第八轮：通过 poortrader.com 登录 Google（2026-11-27 已部署：Pages `da6474c1`，Worker 没变）

- 原因：Google 登录页显示的是回调地址的域名。以前回调在 Supabase，所以显示 `ethdmtzhgopviprocsny.supabase.co`。
- 做法：
  - 在 poortrader.com 上，Sign in 直接跳到 Google（OpenID Connect，`response_type=id_token`，带 nonce 的 SHA-256 和 state）。
  - Google 回到 `/auth/callback`（文件 `cloudflare/pages/auth/callback.html`）。这个页面把结果存进 localStorage，再回到原来的标签页。
  - index.html 的 `finishDirect()` 检查 state，然后用 `signInWithIdToken` 交给 Supabase 建立会话。账号、列表、权限都不变。
  - 现在 Google 页面显示 "poortrader.com"。
- 后备：
  - Supabase 拒绝 token 时，自动改用原来的 Supabase 登录（`signInWithOAuth`，PKCE），并在这台设备上停用新方式 24 小时（`kb.gsi.off`）。
  - 其他域名（本地预览、pages.dev）一直用原来的方式。
- 设置：
  - Google Cloud（项目 kiwiboard-515907）的 Web 客户端加了重定向地址 `https://poortrader.com/auth/callback`。原来的 Supabase 回调地址要保留，后备要用。
  - Supabase 不用改，用的是同一个 Google 客户端。
- 坑：scope 里的空格必须写成 `%20`。用 `URLSearchParams` 生成的是 `+`，Google 每次都报 "redirect_uri_mismatch"，这个报错有误导性。
  - 第一次上线（Pages `f67e2e71`）和第二次（`039cb46a`）因此各有约 1 分钟点 Sign in 会进 Google 的错误页（03:12、03:15 UTC），随后马上暂停（`2bcf446f`、`e5290948`）。
  - 改成 `%20` 后上线 `da6474c1`。
- 验证：
  - 线上用浏览器真实登录了一次：Google 页面没有报错，回到 Watchlist，已登录（admin），没有触发后备。
  - 本地测了取消登录、state 不对、直接打开回调页、Supabase 拒绝 token 后自动改用旧方式。
- 测试注意：内置浏览器已经登录了用户的 Google 账号，任何登录测试都会直接以用户身份（admin）完成。测完用 `client.auth.signOut({ scope: 'local' })` 结束，不能用页面的 Sign out（supabase-js 默认 global，会让所有设备都退出）。
- 只停用新方式：把 `DIRECT_ORIGIN` 改成 `""` 再部署。
- 以后想让 Google 页面显示 "kiwiboard" 和图标：需要 Google 的品牌验证，要求在 Search Console 验证 poortrader.com、首页名字一致、有隐私政策页。

## 平台限制

- **iOS / iPadOS**：需要 16.4 以上，并且必须先「添加到主屏幕」，在主屏幕打开的 App 里才能开启推送。
- **Supabase free**：项目 7 天没有活动会被暂停。可以让 Worker cron 每天对 Supabase 做一次轻量查询，保持活跃。
- **D1 Free**：每天最多读 500 万行、写 10 万行，UTC 0 点重置。超了以后所有读数据的查询都会失败，直到重置或升级 Workers Paid（$5/月）。D1 按扫描的行数计费，新查询要避免全表扫描（见第五轮）。
- **Workers Free**：每次调用的 CPU 时间上限是 10ms。档位推送只需要算 1 次 + 发 N 条，用户少的时候没问题。订阅数到几百以后，改用 Queues 分批发送，或者升级到付费计划。
- **Google 登录页**：从第八轮起，poortrader.com 上显示 "poortrader.com"。后备的 Supabase 登录和其他域名仍显示 `<ref>.supabase.co`。要显示 "kiwiboard" 和图标，需要 Google 品牌验证。
- **密钥**：service_role key 只能放在 Worker secret 里，绝不能出现在 `index.html`。DB 密码只有 CLI 或 psql 才会用到，网站本身用不到。

## 回滚

- **代码**：
  - 第八轮之前：`git checkout f917e35 -- cloudflare/pages/index.html`，再删掉 `cloudflare/pages/auth/`
  - 第七轮之前：`git checkout 8409724 -- cloudflare/pages/index.html`
  - 第六轮之前：`git checkout 683522e -- cloudflare/pages/index.html cloudflare/worker/src README.md`
  - 第五轮之前：`git checkout 02b91c3 -- cloudflare/pages/index.html cloudflare/worker/src/lib/db.ts cloudflare/schema.sql`
  - 第三轮之前：`git checkout backup/pre-phone-pass-2026-11-26 -- cloudflare/pages/index.html`
  - 改版前：`git checkout backup/pre-kiwiboard-2026-11-26 -- cloudflare/pages cloudflare/worker/src`
  - PWA 之前：`git checkout backup/pre-pwa-2026-11-26 -- cloudflare/pages`
- **线上版本**：
  - 第八轮之前：Pages `7e4324fc`。只想停用新的登录方式的话，把 `DIRECT_ORIGIN` 改成 `""` 再部署就行。
  - 第七轮之前：Pages `7e346e49`（这一轮只改了页面，Worker 不用退）。
  - 第六轮之前：Pages `5e855b90`，Worker `0261a32a`。新页面要用新 Worker 的 `assets=` 参数（只退 Worker 的话，自己加的期货和加密货币没有数据），所以先退 Pages，再退 Worker。
  - 第五轮之前：Pages `3e8e6069`，Worker `1a6dad14`。页面和 Worker 互不依赖，可以分开回滚；退 Worker 会让 D1 读取量回到超限的水平。
  - 第四轮之前：Pages `ec183e75`，Worker `6d27fc5c`。回滚时先退 Pages，再退 Worker。
  - 第三轮之前：Pages `02c9f128`，Worker `6d27fc5c`。第三轮只改了 Pages，回滚只需要把 Pages 退回 `02c9f128`。
  - 第二轮之前：Pages `b982715b`，Worker `5e16764e`（`npx wrangler rollback 5e16764e-b6ab-4ea7-8a1b-3a9fa8b9e436`）。
  - 改版前：Pages `759dc1c8`，Worker `9310c3f9`。
- **Pages**：Cloudflare Dashboard → Pages → Deployments → 选旧版本 → Rollback。
- **Worker**：`npx wrangler rollback`
- **Service worker**：如果 SW 出问题，把 `sw.js` 换成在 activate 里调用 `self.registration.unregister()` 的版本，然后重新部署。
