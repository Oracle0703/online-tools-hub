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
- 构建期 gzip 预算与浏览器传输预算分别验收，并逐项比对两侧去重后的 `.css`、`.js` 路径集合；差异会报告构建图中缺失的请求和浏览器额外请求，避免任一门禁遗漏动态 Island 依赖。

两套预算使用不同口径，不能直接比较：`verify-build` 对 HTML、CSS、Astro Island、静态/动态 import 和 Worker 传递依赖组成的完整页面图逐文件 gzip、按路径去重，内容/首页/工具/未来 Studio 上限分别为 120/160/180/260 KiB；Playwright 则对真实浏览器记录按 URL 去重，并使用 `max(transferSize, encodedBodySize)` 作为本地预览和缓存场景下的稳定未压缩传输上界。

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
