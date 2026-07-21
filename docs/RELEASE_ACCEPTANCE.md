# 发布验收与证据

Online Tools Hub 把“可以发布”定义为一组可重复验证的门禁，而不是一次人工浏览。

## Pull Request 分层门禁

- Draft PR：格式化、静态检查、类型检查、单元测试、覆盖率和生产构建。
- Ready for review：增加 Chromium、Firefox、WebKit 的完整 Playwright 套件，以及首页、十二个工具页和知识中心的移动端 Lighthouse 门禁。
- Ready for review：在 GitHub 托管的 `windows-2025` 和 `macos-15` 环境中，分别用真实 Microsoft Edge 与 Safari 完成候选发布冒烟测试。
- `main`：重跑全部门禁；只有 CI 整体成功后，Pages 工作流才部署同一已验证提交。

## 自动验收范围

Playwright 套件覆盖：

- 十二个工具的核心功能、错误路径和直达路由；
- 360px 布局、44px 触控目标和 `prefers-reduced-motion`；
- 独立标题、描述、canonical、Open Graph、robots 和结构化数据；
- 隐私 canary 的原文、URL 编码、Base64、Base64URL 与 SHA-256 表示；
- Cookie、URL/history、Local/Session Storage、IndexedDB、网络请求、控制台、剪贴板读取与 Blob URL 生命周期；其中 LocalStorage 只允许版本化的主题或快捷工具元数据，工具输入、输出及其编码或哈希表示均不得写入；
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
- `/privacy-manifest.json` 使用 exact-fields 校验，并覆盖 12 个工具、12 个 Operation、6 个工作流、允许状态、排除范围和 CSP；缺失、漂移或覆盖不完整必须使生产构建失败；
- `/privacy/` 的合成自检只由用户点击启动，明确区分通过、失败、无法检查和取消；canary 不得返回或渲染，自检结束后 Worker、Vault、Object URL 与监听器全部释放；
- 360 px、44 px 触控、键盘焦点、屏幕阅读器、reduced-motion 与 axe 覆盖离线包对话框、更新提示和隐私能力中心。

三套预算使用不同口径，不能直接比较：`verify-build` 对 HTML、CSS、Astro Island、静态/动态 import 和 Worker 传递依赖组成的完整页面图逐文件 gzip、按路径去重，内容/首页/工具上限分别为 120/160/180 KiB，Workflow Studio 与会懒加载真实 Worker/Workflow 自检的隐私能力中心使用 260 KiB；Operation 构建插件从单个 lazy adapter 的生产 facade 出发，只统计它和传递静态 JavaScript imports 的去重 gzip，单项上限 80 KiB；Playwright 则对真实浏览器记录按 URL 去重，并使用 `max(transferSize, encodedBodySize)` 作为本地预览和缓存场景下的稳定未压缩传输上界。

| Playwright 代表页面 | 浏览器记录上限 |
| ------------------- | -------------: |
| 知识中心内容页      |        352 KiB |
| 首页                |        520 KiB |
| JSON 工具页         |        400 KiB |
| YAML 工具页         |        520 KiB |

Lighthouse 对 performance、accessibility、best-practices 和 SEO 四项均要求移动端分数不低于 90。报告作为 Actions artifact 保留 14 天。

## 真实浏览器记录

`.github/workflows/release-candidate.yml` 不把 Playwright WebKit 当作 Safari 的替代品。它通过系统浏览器及其原生 WebDriver 完成：首页、十二个工具与知识中心直达、JSON 实际交互、360px 无横向溢出、本地隐私标识检查。每个 Job 上传 JSON 记录与截图，保留 30 天。候选工作流只构建一次，Edge 与 Safari 复用同一产物。

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
```
