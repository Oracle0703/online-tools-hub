# Online Tools Hub v1.0 路线图

> 版本主题：本地工作流操作系统  
> 总 Epic：[#32](https://github.com/Oracle0703/online-tools-hub/issues/32)  
> 状态：已完成；发布证据以对应提交的 GitHub Checks 与 artifact 为准
> 更新日期：2026-07-21

## 1. 产品跃迁

v1.0 不以增加工具数量为目标。它把现有十二个高质量本地工具升级为一个可组合、可取消、可离线、可验证隐私的本地数据工作台。

用户只需主动输入一次，即可在同一工作台完成多个受控步骤、查看中间结果、处理一批文件，并导出不含正文的工作流配方。桌面端可以使用清晰的节点连线视觉；移动端、键盘和屏幕阅读器的权威交互始终是纵向步骤编辑器。

一句话定位：**敏感数据不离开设备的中文开发者工作台——不仅提供工具，还解释该用哪个、为什么，以及下一步如何安全处理。**

## 2. v1.0 明确交付

- 类型化 Operation 协议：输入/输出类型、大小限制、执行位置、能力与隐私清单；
- 线性工作流：步骤增删、排序、配置、中间预览、运行、硬取消和一键清空；
- 六个策划模板，覆盖 JSON、Base64、URL、YAML、CSV、JWT、哈希与图片场景；
- Payload Vault：正文、文件、Blob 与 ArrayBuffer 只存在当前标签页内存，界面状态只引用 opaque ID；
- Worker 执行器：重任务超时、硬取消、崩溃恢复、输出预算和资源释放；
- 移动端优先 Workflow Studio、受限批处理、逐项失败隔离与显式下载；
- 不含正文、文件名或内容哈希的运行摘要与隐私收据；
- 最小 PWA 应用壳、按需静态缓存和用户主动下载的完整离线包；
- 工作流模板静态页面、命令面板、首页、指南、HowTo 与 Breadcrumb SEO；
- 覆盖真实浏览器资源图、Worker、取消、批处理和隐私边界的自动验收。

## 3. 不进入 v1.0

- 任意节点图、循环、条件分支和任意用户脚本；
- 自动读取剪贴板、自动把正文注入下一个工具；
- 把输入、输出、文件名或接力内容写进 URL、history 或持久化存储；
- 第三方扩展市场、远程模块、云端 AI、账号同步或远程 URL 抓取；
- 依赖 SharedArrayBuffer、多线程 WASM 或 WebContainer 的能力；
- 为追求数量而新增 Markdown、正则、二维码、PDF、音视频或联网查询工具。

这些能力如有明确用户需求，必须在 v1.1 以后单独通过性能、隐私、安全和维护评估。

## 4. 技术边界

### 4.1 数据生命周期

```text
用户主动输入
  → 当前标签页 Payload Vault
  → 白名单 Operation 执行计划
  → Worker / Web Crypto / 受控主线程能力
  → Payload Vault 中的新输出
  → 截断预览
  → 用户主动复制或下载
  → clear / cancel / unmount / pagehide 统一释放
```

主题、收藏、最近工具或最近模板只允许保存公开 ID 与时间戳。工作流配方只允许保存版本、Operation ID 和经过白名单校验的选项，不包含正文。

### 4.2 GitHub Pages 能力

继续保持 Astro 静态构建、React Islands、Web Worker、Web Crypto、Service Worker 与 CSP `connect-src 'none'`。File System Access、OPFS、Web Share、OffscreenCanvas 等只能作为 feature-detect 后的渐进增强，必须保留标准文件选择和下载回退。

### 4.3 性能预算

构建门禁按页面完整初始资源图去重统计：页面 HTML、直链与传递 CSS、Astro Island `component-url` / `renderer-url`、JavaScript 静态和动态 import，以及 Worker 和它的传递依赖。每个构建文件在同一页面图中只计算一次，表内数值均为构建产物逐文件 gzip 后的总和；它不是浏览器本地预览时的未压缩传输量。

| 页面类型                       | 完整初始资源图上限（gzip） |
| ------------------------------ | -------------------------: |
| 内容与指南页                   |                    120 KiB |
| 首页                           |                    160 KiB |
| 单工具页                       |                    180 KiB |
| Workflow Studio / 隐私能力中心 |                    320 KiB |
| 单个懒加载 Operation chunk     |                     80 KiB |

#33 基线构建中，首页为 122.1 KiB，内容类页面中位值为 88.6 KiB、最大值为 93.2 KiB，工具页中位值为 103.1 KiB、最大值为 133.1 KiB。#35 将默认 Workflow Runner 收敛到 Worker-only 执行闭包后，包含文件与批处理入口的六个公开 Studio 页实测最大为 219.3 KiB。#38 的隐私能力中心按点击懒加载真实 Operation Worker 与 Workflow 自检闭包，完整资源图为 212.2 KiB。#52 加入 61.7 KiB 的 `qr.transform` 生产闭包后，把二维码 Operation 拆到独立 Worker，使公共 Worker 与二维码 Worker 分别为 80.7/59.5 KiB，并按仍会完整统计两份可达 Worker 的页面图把交互工作台预算校准为 320 KiB；当前 Studio 实测最大 301.1 KiB，保留约 19 KiB 余量。浏览器 `Performance Resource Timing` 使用另一组未压缩传输上限，并在发布验收文档中单独说明。

现有 Lighthouse 四项不低于 90、LCP 不高于 2.5 秒、INP 不高于 200 毫秒、CLS 不高于 0.1。工具计算不得在主线程制造超过 50 毫秒的长任务；取消反馈应在 100 毫秒内可见。

### 4.4 Operation Runtime 基线

#34 把十二个现有工具映射为十二个构建期白名单 Operation。Catalog 只包含深冻结、可序列化的 manifest；adapter 通过显式 dynamic import 按需加载，不允许远程模块或任意脚本。

执行前后分别验证输入、选项、输出和工作内存。超过 128 KiB 的 adaptive 任务以及图片、YAML、文本差异等复杂度不可预测的任务进入独占 Worker；成功、失败、超时、取消、崩溃、`pagehide` 和 executor 销毁都必须终止 Worker、释放引用并归还全局内存预留。调用方数据先形成稳定快照，二进制输入复制后再 transfer，不能 detach 或受后续修改影响。

完整协议、模块边界、错误模型和隐私门禁见 [Operation Runtime 架构](OPERATION_RUNTIME.md)。

### 4.5 Workflow Runtime 基线

#37 把配方处理拆为两阶段。Planner 先用纯 catalog 校验配方结构、Operation ID、规范化 options 和相邻 semantic signature，不加载 adapter、不读取正文；Runner 再从当前标签页的 Payload Vault 取出防御性副本，串行调用 OperationExecutor，并把中间输出重新存入 Vault。

配方最多 64 KiB、16 步，只含版本、Operation ID 与白名单 options。Vault 默认最多 64 项、256 MiB，预览默认截断到 32 KiB；Runner 以 768 MiB 组合 resident budget 覆盖 Vault 与最大 Operation 工作预留。cancel 会同步使运行 generation 失效、硬取消当前 Operation、清空 Vault 并阻止晚到 Promise 复活结果；clear、dispose 与 `pagehide` 走同一释放边界。

本阶段提供六个深冻结模板：Base64 JSON 检查、YAML→Base64URL、CSV→SHA-256、编码回调参数审计、编码 JWT 声明报告、RGBA→PNG→SHA-256。它们可以在无网络、无持久化条件下执行；#35 已接入完整 Studio、文件解码、受限批处理与主动下载。详细契约、限制和验收见 [Workflow Runtime 架构](WORKFLOW_RUNTIME.md)。

### 4.6 Workflow Studio 界面边界

#35 在底层 runtime 之上接入公开 `/workflows/` 索引、六个静态模板详情页和移动端优先的纵向编辑器。模板页提供唯一 canonical、中文 SEO 元数据，以及 CollectionPage/ItemList、SoftwareApplication/HowTo/Breadcrumb 结构化数据；隐藏的 `__runtime` 验收路由继续 noindex，不能作为公开入口。

Studio 只提交 Operation ID、白名单 options 和用户主动提供的输入，支持步骤增删、排序、选项编辑、中间预览、运行、硬取消、清空与纯配方导入导出。桌面视觉可以增强，但纵向步骤列表始终是键盘、屏幕阅读器和 360 px 移动端的权威交互。文件解码与批处理通过独立、受限入口把已验证 payload 交给 Runner，不把 File、Blob、正文或结果塞进 recipe、URL 或持久化状态。公开 UI 一次最多接收 12 个文件、合计 64 MiB，串行读取和运行，支持逐项取消、失败重试、通用结果名的有界 ZIP 及不含文件名、正文和哈希的隐私回执。

### 4.7 离线与隐私能力边界

#38 把旧的整站安装期预缓存拆为两级：安装时只保存不超过 2 MiB 的最小应用壳；用户在线访问时，只允许当前构建清单内、同源、无 query 的浏览器静态资源在字节数和 SHA-256 校验后进入缓存。完整离线包最多 512 项、64 MiB，必须由用户主动下载，并提供容量提示、进度、取消、继续和删除。

`/privacy/` 升级为隐私与能力中心。生产构建从十二个工具、十二个 Operation 和六个工作流注册表生成 `/privacy-manifest.json`，清单缺失、字段漂移、覆盖不完整或 CSP 不满足时构建失败。用户可以主动运行一次合成数据自检；它只观察当前版本本站代码在本标签页本次执行中的网络、URL、浏览器状态和资源释放，不检查浏览器扩展、浏览器实现、操作系统、网络设备、托管平台日志或其他标签页，也不构成第三方安全认证。

详细缓存谓词、消息协议、更新边界和发布证据见 [PWA 离线包与隐私能力中心](PWA_PRIVACY_CENTER.md)。

## 5. 阶段交付

1. [x] [#33 拆分工具 catalog/runtime 并建立真实资源预算](https://github.com/Oracle0703/online-tools-hub/issues/33)
2. [x] [#34 建立 Operation 契约、Worker 执行器与硬取消](https://github.com/Oracle0703/online-tools-hub/issues/34)
3. [x] [#37 实现线性工作流、Payload Vault 与内置模板](https://github.com/Oracle0703/online-tools-hub/issues/37)
4. [x] [#35 构建移动端优先 Workflow Studio 与批处理](https://github.com/Oracle0703/online-tools-hub/issues/35)（公开模板页、纵向 Studio、文件批处理、ZIP 与隐私回执）
5. [x] [#38 升级 PWA 按需离线包与隐私能力中心](https://github.com/Oracle0703/online-tools-hub/issues/38)（最小应用壳、主动完整离线包、机器隐私清单与合成自检）
6. [x] [#36 完成工作流 SEO、内容体系与发布验收](https://github.com/Oracle0703/online-tools-hub/issues/36)（首页、搜索、指南、结构化数据与可复现发布证据）

每个阶段使用独立 PR，保持 `main` 始终可发布。#33 合并后，运行时、体验、PWA/隐私与内容验收可以在清晰的模块边界上并行推进。
最终阶段的逐项门禁、artifact 和合并后 Pages 检查见 [v1.0 发布检查表与证据索引](V1_RELEASE_CHECKLIST.md)。后续每个发布候选仍须对其实际提交重新执行同一套门禁，不能复用旧提交结论。

## 6. v1.0 完成定义

- 十二个现有工具能力均可注册为类型化 Operation；
- 六个策划工作流可在断网状态完成；
- 相比 v0.9，代表任务的页面跳转与手动复制次数至少减少一半；
- 正文和文件产生零网络发送、零 URL 泄露、零内容持久化；
- 配方、运行摘要和隐私收据不包含正文、文件名或内容哈希；
- 类型不匹配、超限、超时、取消与 Worker 崩溃均可定位并恢复；
- 360 px、键盘和屏幕阅读器可以完成完整工作流；
- Chromium、Firefox、WebKit、真实 Edge/Windows 与 Safari/macOS 全绿；
- Lighthouse、axe、PWA、CSP、SEO、真实资源图和隐私 canary 全部通过。
