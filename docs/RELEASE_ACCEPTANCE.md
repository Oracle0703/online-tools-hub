# 发布验收与证据

Online Tools Hub 把“可以发布”定义为一组可重复验证的门禁，而不是一次人工浏览。
v1.0 各完成条件与对应命令、测试、Actions artifact 的逐项映射见 [v1.0 发布检查表与证据索引](V1_RELEASE_CHECKLIST.md)。检查表不预填执行结果；当前提交的 GitHub Checks 才是发布结论。

## Pull Request 分层门禁

- Draft PR：格式化、静态检查、类型检查、单元测试、覆盖率和生产构建。
- Ready for review：增加 Chromium、Firefox、WebKit 的完整 Playwright 套件，以及首页、十四个工具页、知识中心、代表工作流、隐私能力中心与更新日志的移动端 Lighthouse 门禁。
- Ready for review：在 GitHub 托管的 `windows-2025` 和 `macos-15` 环境中，分别用真实 Microsoft Edge 与 Safari 完成候选发布冒烟测试。
- `main`：重跑全部门禁；只有 CI 整体成功后，Pages 工作流才部署同一已验证提交。

## 自动验收范围

Playwright 套件覆盖：

- 十四个工具的核心功能、错误路径和直达路由；
- 六个公开工作流的 Planner、Worker、离线执行、取消、文件入口、受限批处理与资源释放；
- 360px 布局、44px 触控目标和 `prefers-reduced-motion`；
- 独立标题、描述、canonical、Open Graph、robots 和结构化数据；
- 隐私 canary 的原文、URL 编码、Base64、Base64URL 与 SHA-256 表示；
- Cookie、URL/history、Local/Session Storage、IndexedDB、网络请求、控制台、剪贴板读取与 Blob URL 生命周期；其中 LocalStorage 只允许版本化的主题、快捷工具元数据和用户主动保存的纯配方结构，工具/工作流输入、输出及其编码或哈希表示均不得写入；
- axe WCAG A/AA 扫描，不允许 serious 或 critical 问题。

0.7.0 的新增门禁还包括：

- 文本差异的最短行级结果、统一/并排视图、复杂度预算和 `.diff` 导出；
- SHA-256/SHA-512 公开向量、文本/文件一致性、摘要核对和文件上限；
- YAML / JSON 双向转换、重复键、多文档、错误行列和不兼容值；
- JWT Base64URL/UTF-8/JSON 错误、时间声明状态，以及始终可见的“未验证签名”提示。

0.8.0 继续增加：

- CSV / JSON 的 BOM、CRLF、引号换行、分隔符、表头/列数与数字精度门禁；
- 查询参数的重复键、空键值、无等号项、百分号/表单编码和稳定排序门禁；
- PWA 安装清单、子路径 scope、版本化预缓存、离线回退与缓存隐私门禁；
- 八篇指南的唯一 canonical、Article/Breadcrumb 结构化数据、站点地图与工具反向链接；
- 图片设备分级像素、批量结果与 ZIP 内存保护，以及 meta CSP 生效顺序断言。

0.9.0 继续增加：

- 智能入口对 JSON、JWT、URL、查询串、Base64、时间戳、CSV、TSV、YAML 与图片签名的本地识别、误判边界、大小限制和三项建议上限；
- 全站命令面板对工具、指南和常见任务的分组搜索、中文任务别名、收藏/最近排序、键盘闭环与 360 px 触控体验；
- CSV、Base64、URL 与 JWT 后续流程的显式“复制并打开”接力，以及失败回退与目标页手动粘贴说明；
- 剪贴板读取、输入持久化、正文 URL/history 泄露和识别结果复述原文的新增隐私 canary 门禁。

v1.0 的资源隔离基础门禁继续增加：

- 使用浏览器 `Performance Resource Timing` 记录内容页、首页以及 JSON、YAML 代表工具页真正请求的文档、脚本和样式资源，并按 `transferSize` 或 `encodedBodySize` 的较大值执行未压缩传输上限；
- 普通内容页和首页不得请求任一工具专属 CSS，代表工具页只能请求自身及共享样式；测试使用相对路由，不绑定 GitHub Pages 的固定 base，并在 Chromium、Firefox、WebKit 中执行；
- 构建期 gzip 预算与浏览器传输预算分别验收，并逐项比对两侧去重后的 `assets/` 页面 `.css`、`.js` 路径集合；差异会报告构建图中缺失的请求和浏览器额外请求，避免任一门禁遗漏动态 Island 依赖。Service Worker 等 PWA 控制面请求仍计入浏览器总字节预算，并由独立 PWA 构建与浏览器门禁验证，不参与页面 bundle 集合对账。

v1.0 的 Operation Runtime 门禁包括：

- 十二个可序列化 manifest 与十二个 lazy adapter 一一对应，tool slug 必须覆盖全部已启用工具；
- 未知 ID、类型不匹配、危险或超过 64 KiB 的 options、输入/输出超限以及全局内存不足都在稳定错误码下失败；
- 调用方输入形成 data-only 快照，后续修改不影响任务，二进制输入 transfer 不 detach 调用方缓冲区；
- main 与 Worker 协议路径对同一核心输入产生一致结果；Worker 完成、失败、超时、取消、崩溃和 `pagehide` 均只结算一次并释放资源；
- Operation、adapter 与 Worker 源码静态 canary 禁止网络、持久化、剪贴板、history 写入和动态代码执行，序列化错误不得包含输入正文。
- 生产构建中的真实 module Worker 在三种浏览器引擎完成动态 adapter 加载、Transferable 往返与硬取消；测试期间不得产生业务网络请求或泄漏 canary。
- JSON、CSV 与 YAML 核心在建立大规模结构和输出前执行节点、行、单元格、别名展开与 16 MiB 输出门禁；`workingMemoryBytes` 作为全局 admission 预留，不表述为 JS heap 硬配额。

v1.1 的正则测试器在 v1.0 十二个 Operation 基线上增加第十三个 `regex.test` manifest 与 lazy adapter，并执行独立门禁：

- 工具页直接使用轻量专属 Worker 客户端，不导入中央 `OperationExecutor` 或其他工具核心；Operation adapter 只供工作流等组合入口按需加载；
- 页面与 Operation 两条执行路径都必须使用一次性 Worker，不允许主线程回退；取消、`pagehide`、异常和 2 秒硬超时立即 `terminate()`，晚到消息不得重复结算；
- pattern 最多 8 KiB、测试文本最多 256 KiB、匹配最多 1,000 项、序列化输出最多 2 MiB；flags、零宽 Unicode 推进、捕获数量和错误字段严格校验；
- 原生正则异常不得把用户 pattern 带入消息；输入、结果及其编码或哈希表示不得进入 URL/history、持久化状态、console、网络请求或 privacy canary 输出。

v1.1 的二维码工具增加第十四个 `qr.transform` manifest 与 lazy adapter，并执行独立门禁：

- 工具页直接使用专属一次性 Worker，生成和识别与 Operation adapter 共享纯核心，但不导入中央执行器或主线程算法回退；
- Unicode 文本生成覆盖 L/M/Q/H 纠错，SVG 仅含固定白底和数字路径，不含原文、元数据、活动内容或外部资源；
- JPEG、PNG、WebP 在完整解码前验证文件头、动画、尺寸、像素与文件预算，并在识别前降至最多 4 MP；
- 已提交的旋转 JPEG、反色 WebP、低分辨率 PNG、无码、损坏、真实两帧动画 WebP 和 16 MP 超限 PNG 夹具在三引擎通过；识别结果即使像网址也只显示为纯文本且不会请求或导航；
- 取消、`pagehide`、协议错误、异常与 8 秒超时统一终止 Worker，并释放 ImageBitmap、Canvas、RGBA 与 Blob URL。

v1.0 的 Workflow Runtime 门禁包括：

- recipe 最多 64 KiB、16 步、32 层和 10,000 个值节点；根与步骤使用 exact fields，危险键、accessor、循环、脚本/远程 URI、未知 Operation 与无效 options 在 adapter 加载前失败；
- Planner 只使用纯 manifest catalog 解析 semantic signature，六个内置模板的相邻步骤和初始 payload 类型全部可证明兼容；
- Payload Vault 默认限制 64 项、256 MiB，对文本和二进制做防御性复制，文本预览截断到 32 KiB，Blob URL 在 delete、clear、cancel、dispose 和 `pagehide` 统一撤销；
- Runner 串行执行并限制单一活动 run；硬取消会递增 generation、终止当前 Operation、清空 Vault，而且晚到 Promise 不得恢复 payload 或重复结算；
- canonical recipe 和最多八项的结构撤销历史只含版本、Operation ID 与规范化 options，不含正文、文件名、输入/输出、Vault ID、内容哈希或运行状态；
- 静态隐私扫描覆盖 `src/workflows` 与生产验收 probe，禁止网络、持久化、history 写入、远程模块和动态代码执行；真实 Chromium 在用户主动完成完整离线包后，通过六个公开模板页断网运行全部工作流；
- Vitest 全局 line/function 覆盖率不低于 90%、branch 不低于 85%；构建插件从真实 client bundle 的 adapter facade 出发递归统计静态 import 闭包，每个 lazy Operation gzip 不超过 80 KiB。

#35 的公开 Workflow Studio 与内容门禁继续增加：

- `/workflows/` 与六个模板 slug 均可静态直达、刷新，进入 sitemap 和完整离线包；Header、Footer 和全站搜索可以发现工作流，隐藏 `__runtime` 路由不得进入公开导航、sitemap 或离线包；
- 索引页输出 CollectionPage/ItemList，详情页输出 SoftwareApplication、HowTo 与 BreadcrumbList；每页有唯一 canonical、中文 title/description/keywords，且不得带 noindex；
- 360 px 下纵向步骤编辑、选项、输入、运行、取消、清空和配方导入导出无横向溢出，触控目标不小于 44 px，键盘顺序与屏幕阅读器名称完整；
- UI 只能把用户主动提供的 payload handle 交给 Runner；recipe 导入导出、URL、history、Local/Session Storage、IndexedDB、缓存和错误消息均不得出现正文、文件名或内容哈希；
- 取消和清空后中间预览、对象 URL、活动 Operation、Worker 与内存预留归零；页面离开时执行同一清理路径，晚到结果不能重新渲染；
- 图片和批处理入口必须在读取前执行数量、单项、总量、像素和输出预算，并逐项隔离失败；不支持的动画或输入类型明确拒绝，不得用普通 recipe 字段冒充文件传递。
- 公开批处理最多 12 项、合计 64 MiB 源文件，必须串行读取与执行，并提供逐项取消/重试、全部取消/清空、有界 ZIP 和隐私回执；序列化回执不得包含文件名、正文或内容哈希。

#38 的 PWA 与隐私能力门禁继续增加：

- Service Worker 安装只缓存不超过 2 MiB 的最小应用壳；完整离线包必须由用户主动下载，最多 512 项、64 MiB，并展示容量估算、条目/字节进度、取消、继续和删除；
- 每次 Cache Storage 写入只允许当前构建白名单内、同源、`GET`、无 query、无 `Range`/`Authorization` 的公开静态资源，并在写入前核对响应字节数和 SHA-256；用户正文、文件、Blob、POST 和程序化数据请求不得进入缓存；
- 带 query 的导航断网时只进入通用离线说明，不能移除 query 后命中缓存页面；完整包下载后，公开工具和六个工作流在 Chromium 中断网可执行；
- 发现更新时不自动刷新；确认按钮前必须说明未清空的输入、输出、文件、批处理队列和进度会丢失，完整离线包可能需要按新版本重新下载；
- `/privacy-manifest.json` 使用 exact-fields 校验；v1.0 发布基线覆盖 12 个工具、12 个 Operation 和 6 个工作流，当前构建必须自动覆盖全部 14 个工具、14 个 Operation、6 个工作流、允许状态、排除范围和 CSP；缺失、漂移或覆盖不完整必须使生产构建失败；
- `/privacy/` 的合成自检只由用户点击启动，明确区分通过、失败、无法检查和取消；canary 不得返回或渲染，自检结束后 Worker、Vault、Object URL 与监听器全部释放；
- 360 px、44 px 触控、键盘焦点、屏幕阅读器、reduced-motion 与 axe 覆盖离线包对话框、更新提示和隐私能力中心。

v1.1 的空白 Studio 与本地配方库门禁继续增加：

- `/workflows/new/` 必须从 0 步开始，不继承模板来源、输入、文件策略或提示；自定义 Operation 搜索、选项和排序继续经过同一 Planner；
- 用户主动保存的本地配方库最多 20 项，单项最多 64 KiB/16 步、合计 canonical recipe 最多 512 KiB；持久化前必须经 Planner 编译和 canonical export，名称只能从 Operation 链派生；
- 库外壳损坏、未来版本、未知 Operation、无效 options、重复 ID 或重复 canonical 条目整库失败且不覆盖有效内存视图；普通保存不得覆盖损坏状态，只有用户明确清空后才能恢复写入；
- Storage 不可用、读取失败或 quota 失败时仅降级为当前标签页并明确告知未持久化；跨标签并发明确采用 last-writer-wins、不承诺自动合并，每次保存、删除或清空前读取最新外壳并在写入后精确回读，已被覆盖的变更必须返回未持久化冲突且采用当前有效权威状态，不能误报成功；
- 跨标签事件、加载和复制均在消费前重新读取当前权威外壳；排队的旧事件不能回滚新状态，失败的删除或清空可以显式重试；
- 配方 JSON 文件导入在读取前后都执行 64 KiB 限制、严格 UTF-8 和完整 Planner 校验；导出仅为 canonical recipe v1，固定生成文件名，触发下载后以零延迟任务撤销 Blob URL；
- 刷新只能恢复用户主动保存的纯配方结构与公开元数据；正文、结果、文件名、内容哈希、Vault ID、运行态和导入导出草稿均为空；
- 配方保存、加载、复制、下载、删除、清空、文件失败关闭、跨标签同步、离线操作和 canary 在 Chromium、Firefox、WebKit 中验收；360 px、44 px 触控、键盘和 axe 覆盖展开后的完整配方库。

三套预算使用不同口径，不能直接比较：`verify-build` 对 HTML、CSS、Astro Island、静态/动态 import 和 Worker 传递依赖组成的完整页面图逐文件 gzip、按路径去重，内容/首页/工具上限分别为 120/160/180 KiB；#52 将 61.7 KiB 的二维码 Operation 拆成 59.5 KiB 的专属 Operation Worker 后，Workflow Studio 与会懒加载真实 Worker/Workflow 自检的隐私能力中心按实测 301.1 KiB 使用 320 KiB 上限。Operation 构建插件从单个 lazy adapter 的生产 facade 出发，只统计它和传递静态 JavaScript imports 的去重 gzip，单项上限 80 KiB；Playwright 则对真实浏览器记录按 URL 去重，并使用 `max(transferSize, encodedBodySize)` 作为本地预览和缓存场景下的稳定未压缩传输上界。

| Playwright 代表页面 | 浏览器记录上限 |
| ------------------- | -------------: |
| 知识中心内容页      |        352 KiB |
| 首页                |        520 KiB |
| JSON 工具页         |        400 KiB |
| YAML 工具页         |        520 KiB |

Lighthouse 对 performance、accessibility、best-practices 和 SEO 四项均要求移动端分数不低于 90。采样覆盖首页、十四个工具、知识中心、工作流目录、一个文本工作流、一个图片/批处理工作流、隐私能力中心和更新日志；其余工作流由统一模板的 SEO、移动端与 axe 门禁逐页覆盖。报告作为 Actions artifact 保留 14 天。

## 真实浏览器记录

`.github/workflows/release-candidate.yml` 不把 Playwright WebKit 当作 Safari 的替代品。它通过系统浏览器及其原生 WebDriver 完成：首页、十四个工具、六个工作流、知识中心、隐私能力中心与更新日志直达，JSON、正则与二维码专属 Worker 及真实 Worker 工作流实际交互；二维码记录会分别识别已提交的旋转 JPEG、反色 WebP 与不可信网址 PNG，并验证纯文本结果、零导航和零外源请求。门禁还覆盖清空释放、360px 无横向溢出和本地隐私标识检查。每个浏览器 Job 上传只含公开路径、版本和断言的 JSON 记录与移动端截图；聚合 Job 再校验两份记录属于同一 commit、没有执行/退出错误且关键断言全部为真，并生成 `summary.json`。原始记录与聚合后的 `release-evidence-v1-*` 保留 30 天。候选工作流只构建一次，Edge 与 Safari 复用同一产物。

## 本地复现

```bash
npm ci
npm run verify
npx playwright install --with-deps chromium
npm run test:e2e -- --project=chromium
npm run test:lighthouse
```

真实 Edge/Safari 脚本需要对应操作系统与已启用的系统 WebDriver：

```bash
node scripts/real-browser-smoke.mjs edge
node scripts/real-browser-smoke.mjs safari
node scripts/verify-release-evidence.mjs
```
