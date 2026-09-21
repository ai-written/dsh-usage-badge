# 设计备注（详细版）

> 这是原来的长版 README，保留下来当设计备注：实现取舍、官方政策原文、路由与配置字段语义、测试套件清单、以及踩过的坑。
> 面向使用者的简明说明请看 [README](../README.md)。

# dsh-usage-badge

DeepSeek Harness 的**用量徽标插件**：侧边栏底部（设置按钮上方）一行「今日用量」显示当日 token 总量与估算费用，点开可看 24 小时 / 近 7 日 / 近 30 日 / 近 12 个月用量，按 provider 筛选，并按 **DeepSeek 官方定价**与**中国法定节假日日历**计价。

它把 [DeepSeek-Harness](https://github.com/ai-written/DeepSeek-Harness) 桌面壳里的「每日用量徽标」重做成一个独立的 DSH 插件，因此**纯 `dsh web` 与 CLI 也能用**，不再依赖 Tauri 壳。

![DeepSeek Harness 侧边栏底部的「今日用量」行与用量弹窗](assets/usage-dialog.png)

**零依赖、零构建**：宿主半只用 Node 内建模块；浏览器半是手写的单文件 bundle（`lib/client.js` 既是源码也是产物），不需要 esbuild、不需要 `pnpm run build`。图不用图表库，四序列折线是手写 SVG。

## 安装

前置：Node ≥ 22.15（需要 `zlib.zstdDecompressSync` 读 `.jsonl.zstd` 日志）+ 带 `dsh plugin` 命令的 DSH。

```sh
# 从本地路径安装（把 <本仓库路径> 换成本项目的绝对路径）
dsh plugin --profile web add <本仓库路径>

# 或开发模式：符号链接，改完 lib/client.js 刷新页面即生效
dsh plugin --profile web add link:<本仓库路径>
```

装完**重启客户端**（插件行在启动时扫描并装载）：

```sh
dsh web
```

之后按改动位置区分：

| 改了哪里 | 要做什么 |
|---|---|
| `lib/client.js`（界面、图表） | **刷新页面**即可 —— 浏览器半由宿主按需读取，实测刷新就能拿到新字节 |
| `lib/index.js` 及其余宿主半、`lib/holidays-cn.json` | **重启客户端** —— 宿主半是进程启动时装载的模块，换掉文件不会重新执行 |

> 用 `link:` 安装时这条区分最重要：界面改动不必重启，可以放心调样式；宿主半的改动攒着一起做，一次重启验完。

卸载：

```sh
dsh plugin --profile web remove dsh-usage-badge
```

## 界面上有什么

侧边栏底部的 **「今日用量」行**（就在「设置」上方，所以它跟设置行同一套高度、圆角、悬停与缩进；侧边栏收起时缩成 36×36 的小方块），从左到右依次是：

- **「今日用量」** 标签
- **峰谷圆点**：谷时灰色、峰时橙色；悬停圆点本身会显示 `峰时 ×2` / `谷时 ×1` / `国庆节 · 全天空闲`
- **当日 token 总量**（输入 + 缓存 + 输出）
- **当日估算金额**

整行每 5 秒刷新，悬停显示完整明细（金额 / token / 请求数 / 当前档位）。点击打开两个面板：

**用量**

- 四个区间页签：24 小时（今天逐小时）/ 近 7 日 / 近 30 日 / 近 12 个月
- 今日有多个 provider 时出现 provider 筛选
- 合计卡片：金额、请求数、Token 总量、缓存命中率
- **四序列折线图**，与桌面壳的图表同一套配色与读法：金额（蓝，带面积填充）、token 总量（绿）、请求数（紫）、缓存命中率（橙虚线，固定 0–100 刻度），各自独立缩放、共用横轴；鼠标移上去显示该点的四项数值与竖线参考线（`mode: 'index'`，和壳里的 tooltip 行为一致）
- 近 7 日 / 近 30 日里，**法定节假日用绿色背景色带**标出（这些日子全天按空闲价）

**单价配置**（全部只读 + 两个动作：**重新获取** / **应用官方价格**，没有任何要手填的字段）

- **官方定价**：每次打开这个面板都实时抓取 DeepSeek 官方定价页并解析（中文页人民币 / 英文页美元），列出现行单价、高峰时段与政策原文；**这是唯一的单价来源**
- **法定节假日日历**：内置日历的覆盖年份与天数、今天是不是法定节假日、数据来源文号
- **当前生效单价**：当前 default 行与全部覆盖行，只做展示

> 为什么没有汇率 / 币种 / 倍率可填：官方中文页就是人民币，徽标也始终是人民币，所以这些都不需要配置。它们作为**进阶字段仍然被支持**（写在 `pricing.json` 里就生效，比如给某个网关模型加 `multiplier`），只是面板不提供入口；一旦某个覆盖行带上了非 1 的倍率，面板会**自动多出一列「倍率」**把它显示出来，避免一个改变金额的系数被藏起来。

## 官方定价

点开「单价配置」时会实时抓取官方定价页并解析：

| 来源 | 页面 | 币种 |
|---|---|---|
| 中文页 | <https://api-docs.deepseek.com/zh-cn/quick_start/pricing> | 人民币 |
| English | <https://api-docs.deepseek.com/quick_start/pricing> | 美元 |

页面是 Docusaurus 服务端渲染的 HTML，无需浏览器即可读取。解析出的内容：

- **每个模型的单价**：输入（缓存命中）/ 输入（缓存未命中）/ 输出，空闲与高峰两档
- **高峰时段窗口**：从脚注读出，并识别其声明的时区（中文页写「北京时间」，英文页写 UTC）
- **政策原文**：空闲价为高峰价的一半、周末与法定节假日全天空闲
- **已下线的旧模型名**：脚注 (1) 列出的 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍按下线前对应模型计价，会一并写入覆盖行

**时区换算**：配置里的 `peakRanges` 是**本机小时**，而官方页面的窗口按它自己声明的时区书写，所以解析时会把窗口从来源时区换算到本机（英文页的 `01:00–04:00 / 06:00–10:00 UTC` 会换算成本机的 `09:00–12:00 / 14:00–18:00`）。面板同时显示原始窗口与本机换算后的窗口。

**「应用官方价格」会写入什么**：把每个模型的**空闲价**写成覆盖行的单价，并把 `timeOfUse` 设为 `peakMultiplier: 2 / valleyMultiplier: 1`（等价于「空闲价是高峰价的一半」，也与桌面壳原有配置同形），同时打开节假日日历。你手写的其他覆盖行、`default` 行与未知字段都不会被动。

**抓取是脆弱的**：官方页面改版后解析会失败——此时面板显示失败原因并保留原有价格，可继续手改 JSON 兜底。`test/fixtures/` 保存了本解析器验证过的页面快照，页面一变测试就会失败；`node test/official-pricing.live.mjs` 会用真实页面与快照对比，确认线上页面仍能解析。

**抓取频率**：每次打开面板都会请求一次；宿主机把几秒内的重复请求合并（20 秒窗口），所以反复开关面板不会反复打官网。

## 法定节假日与峰谷判定

DeepSeek 官方政策原文：

> 空闲时段价格为高峰时段价格的一半。北京时间周一至周五（**不含中国法定节假日**）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括**周末及中国法定节假日全天均为空闲时段**。

也就是说，节假日日历只影响**一个方向**：

- 落在周一至周五的**法定节假日** → 全天按空闲价（不做处理的话会按峰价计费，这是日历存在的意义）

而**周末永远按空闲价**，即使国务院把它调休成上班日 —— 政策原文说的是「周末…全天均为空闲时段」，调休后的周日仍然是周末。**所以本插件刻意不把调休上班日当作工作日计价**：那样会在官方明明写着全天空闲的日子上收峰价。

内置日历（`lib/holidays-cn.json`）逐年记录放假日，数据来自国务院办公厅的年度放假安排通知，并保存文号与链接；调休上班日也一并收录作为存档，但**不参与计价**：

| 年份 | 文件 | 放假日 | 调休上班日（仅存档） |
|---|---|---|---|
| 2025 | 国办发明电〔2024〕7号 | 28 | 5 |
| 2026 | 国办发明电〔2025〕7号 | 33 | 6 |

**这在你自己的历史数据上是可测的，而且我在这里犯过错**：本机 `2026-09-20` 是调休上班的周日，我最初把它按工作日计价，得出 **¥13.78**；按政策原文（周末全天空闲）应为 **¥7.46** —— 也就是说我**多收了 ¥6.32**，而当时我以为是自己修好了桌面壳的「少算」。现已改正，`2026-09-19`（普通周六）与 `2026-09-21`（普通周一）的数字不受影响。这个错误现在被 `test/holidays.verify.mjs` 里三条断言钉住（调休周日、调休周六、以及旧配置里的 `holidays.workdays` 必须被忽略）。

配置方式（顶层 `holidays`，与 `timeOfUse` 分开，因为它回答的是「哪些日子适用」，而 `timeOfUse` 回答「峰时窗口在哪」）：

```json
"holidays": { "source": "cn" }
```

| `holidays.source` | 含义 |
|---|---|
| 缺省 / `"none"` | 不做节假日处理（与旧行为完全一致） |
| `"cn"` | 内置中国日历 |
| `"custom"` | 只用你自己给的日期 |

另外 `holidays.extra` 可随时补日期（额外放假日）。新增年份只要按同样格式往 `lib/holidays-cn.json` 的 `years.<year>` 里补一条；当年份缺失时启动日志与面板都会提示「这些年按普通工作日处理」，不会静默算错。旧配置里的 `holidays.workdays` 会被忽略（不报错），因为它已不是计价输入。

## 文件放在哪

本插件**只在自己的一个目录里读写文件**，共享的 `storages` 根目录里不会出现任何属于它的东西：

```
$DSH_HOME/storages/usage-badge/
├── pricing.json    # 价格表（可手改；「应用官方价格」也写这里）
└── cache.json      # 会话日志的折叠缓存（可随时删，会重建）
```

> 未设置 `DSH_HOME` 时即 `~/.dsh/storages/usage-badge/`。

之所以单独开目录：`storages` 根目录同时放着 DSH 自己的缓存（`session_projcache*`、`workspace.json`）以及别的工具留下的文件，插件文件混在里面会让人分不清归属。目录路径会显示在弹窗「单价配置 → 当前生效单价」区块底部。

**旧位置仍可读**：升级前放在根目录的 `storages/usage-pricing.json` 会作为回退被读取（启动日志会写明），第一次写入（比如应用官方价格）时会迁移到 `usage-badge/pricing.json`，旧文件保持原样不动。

## 价格表

价格表是 `storages/usage-badge/pricing.json`：

```
$DSH_HOME/storages/usage-badge/pricing.json
```

**正常使用不需要碰这个文件**：面板里点「应用官方价格」就会把官方单价写进去，峰谷时段与节假日日历也一起配好。手工编辑只在进阶场景下需要（给网关模型加单价、加自定义节假日），改完即时生效。

文件不存在或无法解析时按内置默认模板计价（占位符不会落盘；模板可用 `GET /usage-badge/config` 查看）。字段：

| 字段 | 说明 |
|---|---|
| `default` | 兜底价格行（`inputPerMillion` / `cacheReadPerMillion` / `cacheWritePerMillion` / `outputPerMillion` / `currency`） |
| `overrides` | 按键覆盖，支持 `模型名`、`provider\|模型名`、`provider\|*`、`*\|模型名` 四种写法 |
| `timeOfUse` | 峰谷计价，`{ enabled, days, peakMultiplier, valleyMultiplier, peakRanges }`；「应用官方价格」会按官方页面的窗口自动填好 |
| `holidays` | 节假日日历，`{ source, extra }`；`source: "cn"` 即内置中国日历 |

进阶字段（面板不提供入口，手写才生效）：

| 字段 | 说明 |
|---|---|
| `exchangeRate` | 跨币种换算用的汇率，仅当价格行与合计币种不一致时才用到 |
| `totalCurrency` | 合计币种 `cny`（缺省）/ `usd` |
| `multiplier` | 全局倍率（可被 override 行覆盖） |
| `contextMultiplier` | 上下文长度档位，`{ "threshold": "128K", "multiplier": 1.5 }`，**严格大于**阈值才生效 |

计价优先级：**纯模型名 > `provider\|模型名` > `provider\|*` > `*\|模型名`**，逐价格字段独立取最高优先级；键名匹配不区分大小写。每次请求的费用按该请求的**发起时刻**判定峰谷，并整体乘以模型倍率与上下文档位倍率；法定节假日覆盖 `days` 的判定（周末不因调休改变计价）。

> 价格表每次刷新都重新读取，改完不用重启。

## 架构

```
dsh-usage-badge
├── cordis.patch.yml        # bundle 补丁：向 profile 插入一行 usage-badge
├── lib/
│   ├── index.js            # 宿主半：HTTP 路由 + 快照组装 + 配置读写
│   ├── fold.js             # 会话日志发现、zstd 解码、逐请求折叠、增量缓存
│   ├── pricing.js          # 价格解析与成本计算（从桌面壳移植）
│   ├── holidays.js         # 节假日日历：加载、展开、判定规则
│   ├── holidays-cn.json    # 逐年放假日与调休上班日（后者仅存档，不参与计价；含来源文号）
│   ├── official-pricing.js # 官方定价页抓取、解析与应用
│   └── client.js           # 浏览器半：手写单文件 bundle
└── test/                   # 5 个回归套件 + 1 个联网核对脚本，见下
```

**数据流**：

1. 宿主半在启动时折叠 `$DSH_HOME/sessions` 下所有会话日志。每个 `assistant/message` 事件里的 `usage` 是一条已完成的请求；`request/header` / `request/context` 决定它属于哪个 provider / model。按**本地日历日**与 `provider|model` 入桶，并保留**逐请求**记录——这是上下文档位、峰谷与节假日都能按每次请求算的前提。
2. 增量缓存写在自己的目录里：`$DSH_HOME/storages/usage-badge/cache.json`。只重读 size / mtime / 路径变化的日志；日志被删除时保留缓存中的历史贡献（与桌面壳一致）。
3. 浏览器半轮询 `GET /usage-badge/summary`，本地完成区间聚合与筛选；切到「单价配置」时才去抓官方定价。

**路由**（全部挂在 `ctx.webServer` 上）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/usage-badge/summary` | 徽标与图表所需的全部数据（含 `calendar` 与每日 `dayClass`） |
| GET | `/usage-badge/config` | 生效价格表、内置日历覆盖情况、当前节假日状态、各文件路径 |
| PUT/POST | `/usage-badge/config` | 改 `exchangeRate` / `totalCurrency` 等，**仅接受 loopback 来源** |
| GET | `/usage-badge/official-pricing?source=&refresh=1` | 抓取并解析官方定价页 |
| POST | `/usage-badge/official-pricing/apply` | 应用官方价格，**仅接受 loopback 来源** |

**为什么用 HTTP 路由而不是 Typert RPC**：第三方插件很难提供严格模式要的生成描述符，而 Typert 的 SRC 回退路径在文档里被定位为开发路径。命名路由不需要 codegen、不需要 gateway 接线，代价是路由本身不走授权层——所以两个写入口额外加了 loopback 校验。

**UI 挂载点**：`sidebar.footer.action` —— 侧边栏自己声明的「设置按钮旁边的底部动作」席位。用这个席位而不是浮动图层，行才会跟已发布的行对齐并共用布局：席位把侧边栏的 `wide` 状态交给条目，所以展开时是一整行、收起时是 36×36 方块，也永远不会压到别的控件上（对比 `shell.overlay`：那是整帧浮层，条目得自己定位，放不好就会盖住侧边栏内容）。

## 验证

```sh
npm install     # 只为测试装 react / react-dom
npm test
```

| 脚本 | 覆盖什么 |
|---|---|
| `test/manifest.verify.mjs` | 包契约：`dsh.bundle.patch` / `dsh.client` / `exports["./client"]` 是否与磁盘上的文件对得上；patch 行名与包名是否一致；宿主半**没有** `export default`（有的话 Loader 的 `unwrapExports` 会丢弃 `inject`）；节假日数据文件的结构与来源完整性 |
| `test/pricing.verify.mjs` | 用临时 `DSH_HOME` + 合成会话日志跑真实宿主半，断言精确金额。第一组用例**逐字移植自桌面壳的 `pricing-key-case.verify.mjs`**（同样的 fixture、同样的期望值），用来证明移植后的定价与原实现一致；另覆盖上下文档位（严格大于、`"128K"` 紧凑写法、缓存 token 计入上下文）、峰谷 `days` 规则与跨币种换算 |
| `test/holidays.verify.mjs` | 节假日日历的行为：工作日节假日全天空闲、**调休周末仍按空闲价**（政策原文说周末全天空闲）、旧配置里的 `holidays.workdays` 被忽略、关闭日历时回到旧的按星期行为、自定义 `extra`、以及同一个月内不同日子的分类互不干扰 |
| `test/official-pricing.verify.mjs` | 解析器对**中英文两个页面快照**的逐字段断言（含旧模型别名、时区识别与换算）；页面结构变化时会抛错而不是静默返回错价；`应用` 的合并语义（未知字段存活、`default` 行不动）；并用**被 stub 掉的 fetch** 跑通两个路由，最后验证应用后的价格真的参与计费 |
| `test/client.render.mjs` | 用替身 Loader 加载浏览器 bundle，检查 slot 注册形状与 `id`，再用 `react-dom/server` 渲染两个面板，断言金额格式、区间页签、四序列折线的条数与配色、悬停 tooltip 的装配、provider 页签、官方价格表内容、节假日徽标与日历区块、展开/收起两种行形态，以及空数据 / 稀疏 provider 两个边界不崩 |
| `test/smoke.mjs` | 对着**本机真实**的 `$DSH_HOME` 跑一遍，打印徽标金额、今日 token 构成、当前峰谷档位、节假日日历状态与最近 7 天 |
| `test/official-pricing.live.mjs` | **联网**核对：抓真实页面并与 `test/fixtures/` 的快照逐字段比对，确认官方页面仍能解析、价格未变 |

`test/smoke.mjs` 只读会话日志与价格表；测试脚本唯一会写的是临时目录，联网脚本不写任何文件。

## 已知限制

- **节假日与峰谷按本机时区判定**：官方窗口按北京时间定义，应用官方价格时已把窗口换算到本机。但**日历匹配用的是本地日期**，主机不在 UTC+8 时，跨午夜的请求可能落到错误的本地日期从而判错节假日。中国主机（UTC+8）下完全精确。如需任意时区精确，可加 `timeOfUse.zone` 选项（尚未实现）。
- **节假日数据需要逐年更新**：内置 2025 与 2026。国务院通常在每年 11 月公布次年安排，届时需补 `lib/holidays-cn.json`；缺失年份会在启动日志与面板提示，不会静默算错。
- **官方页面解析依赖当前页面结构**：改版后「获取官方定价」会报错（面板显示原因并保留原价格），用 `node test/official-pricing.live.mjs` 可以随时核对；价格仍可手改 JSON 兜底。
- **定价数字仅供参考**：token 列是五桶合计，与官方「三列」天然对不齐（reasoning token 单独上报且不计费），与官方实时数字存在分钟级时差；**对账请以金额为准**。
- **只统计 DSH 记进日志的调用**：统计口径是会话日志里的 `assistant/message` + `usage`；某个插件直接请求外部 API 且不向宿主上报 usage，这部分消耗统计不到。
- **首次启动要冷扫一遍全部日志**（实测 209 份日志约 10 秒，分片让出事件循环，不会卡住宿主）。之后走增量：实测热启动 237ms、折叠 0 份。缓存文件丢失才会再次冷扫。
- **历史依赖日志仍在盘上**：已删除的日志靠缓存里保留的贡献继续计入；缓存也丢了，那段历史就没了。
- **不做**：余额查询、订阅额度（Coding Plan）、**手工维护单价**（单价唯一来源是官方页面，面板里没有要填的字段）、峰谷切换弹窗/系统通知、中英双语、历史回填 CLI。这些是 [`dsh-cost-meter`](https://github.com/Han-1413141/dsh-cost-meter) 的领域；本插件刻意只做徽标、图表、官方定价同步与节假日判定。

## 与桌面壳的关系

桌面壳的用量功能（`src-tauri/usage/usage-sidecar.mjs` + `usage-panel.js` + Rust 胶水）与本插件**功能重叠**，口径差异只有一处：本插件会识别**法定节假日**（工作日节假日全天按空闲价），桌面壳只会按星期几判断；另外官方定价可以一键同步。周末的判定两边一致 —— 调休上班日不按工作日计价。

两者已**不再共用价格表**：本插件读写自己的 `storages/usage-badge/pricing.json`，而桌面壳的 sidecar 固定读 `storages/usage-pricing.json`。所以同时使用时要各自维护价格表；只用本插件时，把价格表放在 `usage-badge/pricing.json` 即可（放在旧位置也能被读到，只是会在首次写入时迁移过去）。

- 用本插件：`dsh web` / 官方桌面客户端 / CLI 都有徽标，壳里那套约 2800 行可以删掉。
- 用桌面壳：保留 sidecar 的故障隔离（插件跑在宿主进程内，出问题影响的是整个 DSH；sidecar 崩了只写日志），但计时口径偏松。

## 发布到 npm

工作流在 [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)：推 `v*` tag 触发，也可以手动触发（默认只预演）。

**认证用 Trusted Publishing（OIDC），不需要任何 secret。** 这是 npm 现在的推荐做法 —— 长驻 token 这条路已经走不通了：

- npm 从 2025 年 11 月起**只支持 Granular access tokens，Classic（含 Automation）token 已被撤销并停止生成**。所以"在 npm 上生成一个 Automation token 塞进 GitHub Secrets"这个老办法已经不适用。
- 新建的**可写 granular token 默认 7 天过期、最长 90 天**，放进 CI secret 就得不断轮换，不适合"配一次跑一年"的发布。
- Trusted Publishing 由 npm 校验「哪个仓库的哪个 workflow」来授权，每次发布换一次短期凭据，并且**自动附带 provenance 签名**（不需要 `--provenance`）。

### 配置步骤

1. **先让包存在**：Trusted Publisher 是配在**包设置页**上的，所以全新包必须先发一次 —— 本地 `npm login` 后 `npm publish --access public`（会走你账号的 2FA）。
2. **在 npmjs.com 配 Trusted Publisher**：进该包的 Settings → Trusted Publisher → 选 GitHub Actions，填四个字段：
   - Organization or user：你的 GitHub 账号
   - Repository：仓库名
   - Workflow filename：`publish.yml`（**只填文件名**，必须带 `.yml`，大小写敏感）
   - Allowed actions：**勾上允许直接 `npm publish`**（默认只允许 `npm stage publish`，不勾就直接发不出去）
3. **`package.json` 的 `repository.url` 必须与 GitHub 仓库完全一致** —— 这是 npm 的硬性要求，不匹配会拒绝发布。
4. 之后每次发版：改 `package.json` 的 `version` → 提交 → `git tag v0.1.1 && git push origin dev --tags`。

### 需要知道的坑

- **npm 不会在保存时校验** Trusted Publisher 配置：字段填错只在**发布时**以 `ENEEDAUTH`（Unable to authenticate）报出来。
- 必须用 **GitHub 托管的 runner**（`ubuntu-latest` 这类），自托管 runner 不支持。
- 私有仓库**不会**生成 provenance（即使包本身是公开的）。
- Trusted Publishing 要求 **npm CLI ≥ 11.5.1 + Node ≥ 22.14**，所以工作流里用的是 Node 24。
- 每个包最多 10 个 trusted publisher，且**已配好的不能修改**，要改只能删掉重建。

### 如果一定要用 token

只能用 granular token：Access Tokens → Generate New Token → `Bypass two-factor authentication`（按需）→ Packages and scopes 选 `Read and write (publish and stage)` 并指明这个包 → 生成后放进仓库的 `NPM_TOKEN` secret，同时在工作流的发布步骤上补回 `env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`。注意它会过期（最长 90 天）。更安全的替代是 `Read and write (stage only)`：CI 只能**暂存**版本，由维护者用 2FA 审核提升。

## License

MIT
