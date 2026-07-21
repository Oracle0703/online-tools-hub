# Workflow Runtime 架构

Workflow Runtime 在 Operation Runtime 之上提供线性、内存内的数据处理流水线。核心模块只负责编译和执行配方；#35 的公开模板页与 Workflow Studio 通过稳定接口消费它，界面状态、文件选择、批处理和下载不会反向扩充 recipe wire format。

## 1. 两阶段执行

```text
不可信 recipe JSON
  → 结构、大小与安全值检查
  → Operation ID / option schema 校验与默认值补齐
  → semantic signature 相邻类型检查
  → 深冻结 WorkflowPlan（此时尚未加载 adapter）
  → 用户主动提供 Payload Vault handle
  → 串行 OperationExecutor 执行
  → 每步输出回到 Payload Vault
  → 截断预览或用户主动复制 / 下载
```

第一阶段由 `recipe-codec.ts` 与 `planner.ts` 完成。配方最多 64 KiB、16 步、32 层和 10,000 个值节点；只接受版本、Operation ID 和白名单 options。未知 Operation、危险键、accessor、循环、脚本/远程 URI、额外字段、选项错误或语义类型不兼容都会在 adapter 动态加载前失败。

第二阶段由 `runner.ts` 串行调度。Runner 同时只允许一个活动运行，按已编译计划把 Vault 中的防御性副本交给 OperationExecutor，并把每一步结果重新存入 Vault。执行快照只暴露步骤 ID、状态、错误码和 opaque payload ID，不包含正文。默认 Runner 使用 Worker-only executor：主 realm 只依赖 client 协议和类型，adapter registry 及算法闭包只进入专用 Worker，不在 Studio 首页重复打包。

## 2. 配方边界

v1 配方的稳定 wire format 是：

```json
{
  "format": "online-tools-hub/workflow",
  "version": 1,
  "steps": [
    {
      "operationId": "json.transform",
      "options": { "mode": "format", "indent": 2 }
    }
  ]
}
```

根对象只能包含 `format`、`version`、`steps`；步骤只能包含 `operationId`、`options`。正文、文件名、输入、输出、结果、状态、Vault ID 和内容哈希都不是配方字段。导入走严格验证，导出使用递归稳定键序的 canonical JSON。v1 不猜测或伪造 v0 迁移，未来格式必须有显式版本迁移。

结构撤销历史最多保留八份深冻结配方，只记录 canonical recipe，不读取 Payload Vault，也不能在取消或清空后复活数据。

## 3. 语义类型与计划

每个 Operation manifest 通过声明式 options 解析出 semantic signature：structured-clone payload `kind` 与 MIME 风格 `contentType`。Planner 使用构建期 catalog 检查首尾和相邻步骤，支持显式媒体类型通配符，但不会加载 adapter 或接触 payload。

编译结果包含规范化 options、确定性标记、每步内存预留和仅供运行时使用的稳定 step ID。导出的 recipe 会重新投影为公开字段，因此内部运行元数据不会进入分享文件。

## 4. Payload Vault

`PayloadVault` 是当前标签页内存中的正文所有权边界：

- 支持 empty、text、text-pair、binary 与 RGBA payload；
- `put()` 和 `materialize()` 都做防御性复制，调用方不能通过原 buffer 改写 Vault；
- 默认最多 64 项、256 MiB；文本按 UTF-8 与 JavaScript UTF-16 表示的较大值计费；
- 文本预览默认最多 32 KiB；二进制和图片预览只返回元数据；
- UI 和运行快照只持有随机 opaque ID；
- Blob URL 统一登记，并在单项删除、clear、cancel、dispose 或 `pagehide` 时撤销。

Runner 的默认组合 resident budget 是 768 MiB，用于覆盖 256 MiB Vault 与最大 512 MiB Operation 工作预留。每一步执行前再次做 admission 检查，避免先复制大对象再发现超限。

## 5. 取消、失败与清理

取消是同步的生命周期边界：Runner 先递增 generation，使任何晚到结果失效，再调用当前 Operation 的硬取消、移除所有步骤 payload 引用、清空 Vault，并以稳定 `cancelled` 错误只结算一次。Worker 由 OperationExecutor 立即 `terminate()`；已经在途的 Promise 即使之后完成，也不能把数据重新写回 Vault。

Operation 失败保留此前成功的内存中间结果，便于后续 Studio 展示和重试；用户主动 clear、再次取消、页面 `pagehide` 和 dispose 则统一释放正文、对象 URL、Worker、监听器和执行预留。公开 WorkflowError 只包含稳定错误码、步骤索引与 Operation ID，不序列化 cause、正文或底层异常细节。

## 6. 六个内置模板

| 模板                     | 线性步骤                          | 初始类型                  |
| ------------------------ | --------------------------------- | ------------------------- |
| 解开 Base64 JSON         | Base64 解码 → JSON 格式化         | `application/base64` 文本 |
| YAML 配置转 Base64URL    | YAML→JSON → JSON 压缩 → Base64URL | `application/yaml` 文本   |
| CSV 测试夹具与 SHA-256   | CSV→JSON → JSON 压缩 → SHA-256    | `text/csv` 文本           |
| 回调地址参数审计         | URL component 解码 → 查询参数检查 | form-urlencoded 文本      |
| URL 编码 JWT 声明报告    | URL component 解码 → JWT 声明检查 | form-urlencoded 文本      |
| PNG 调色板编码与 SHA-256 | 已验证 RGBA→PNG → SHA-256         | `image/x-rgba`            |

模板、配方和 notices 均深冻结。它们只组合已有白名单 Operation，不包含远程 URL、动态模块或用户脚本。#37 的图片模板从已验证 RGBA 开始；#35 只能通过显式、受限的文件输入组件完成浏览器解码，再把已验证像素交给同一 Runner，不能让 recipe 自动读取路径或文件。

## 7. 离线、隐私与资源门禁

工作流执行不使用 fetch、XHR、WebSocket、Beacon、Cookie、Local/Session Storage、IndexedDB、Cache Storage 或 history 写入。生产 CSP 继续使用 `connect-src 'none'`，静态扫描覆盖 `src/workflows`、Operation、工具核心、Worker 和浏览器验收 probe；配方 canary 还断言导出结构不含 payload/result/runtime 字段。

构建门禁直接读取真实 Vite client bundle：以每个 adapter 源模块对应的 lazy facade chunk 为入口，递归跟随全部静态 import，逐文件 gzip、去重后断言每个 Operation JavaScript 闭包不超过 80 KiB。该检查不依赖哈希文件名，也不会用源文件大小冒充生产产物。

隐藏的 noindex 生产验收路由只暴露六个固定模板的窄接口，用于真实浏览器验证 Worker、取消、配方 canary、零持久化、零外部请求及 Service Worker 缓存后的断网执行；它不接受任意模块或远程 URL。

## 8. 当前限制

- 只支持最长 16 步的线性链；没有分支、循环、任意节点图或用户脚本；
- 单个 Runner 每次只运行一个 workflow；#35 的公开批处理一次最多 12 项、合计 64 MiB 源文件，串行提交并逐项隔离失败；
- Payload 只存在当前标签页，刷新、关闭、clear 或 cancel 后不能恢复；
- 配方可以导入导出，但不含输入、输出、文件名或运行记录；
- 主线程同步 Operation 无法被 JavaScript 从外部硬中断；不可预测任务必须继续使用 Worker；
- 底层 runtime 与 Studio UI 保持分层；公开页面存在不代表任意本地文件格式、动画或远程 URL 已被支持。

## 9. Studio 消费接口

公开详情页只用 `templateId` 选择六个构建期模板，并把部署 `baseUrl` 交给 Workflow Studio。Studio 可以把纵向编辑器状态编译为计划、把用户主动输入写入 Vault、启动/取消 Runner、读取截断预览，并导入导出 canonical recipe；它不能接收任意模块 URL、把正文放入 Astro props，或绕过 Planner 直接调用 adapter。

静态内容层在 `workflow-content.ts` 维护标题、输入/结果说明、HowTo 步骤和相关工具，并在测试中与 runtime template 的 ID、标题、Operation 顺序一一核对。公开 `/workflows/` 页面可索引；`/__runtime/workflows/` 仍是 noindex、无 canonical 的自动验收面。

文件入口在读取前检查模板语义类型、数量、字节和图片像素预算；队列每次只解码和执行一项。通用协调器的上限为 64 项、单项 64 MiB、合计 256 MiB，构造参数只能进一步下调；公开 UI 收紧到 12 项和 64 MiB 总源文件。成功结果可以单项下载，也可用通用结果名打包成最多 48 MiB 的有界 ZIP；隐私回执只保留配方、状态和计数，不包含文件名、正文或哈希。

## 10. 验收

- 六个模板在真实 Operation 上可编译，并在离线浏览器中完成；
- 恶意或类型不兼容配方在 adapter 加载前失败；
- cancel 后 Vault、对象 URL、活动 run、Operation task、Worker 与内存预留归零，晚到结果不能复活；
- canonical recipe 不包含 payload、结果或运行态字段；
- Workflow/Operation 源码隐私扫描为零违规；
- Workflow 代码进入覆盖率统计，全局 line/function 不低于 90%、branch 不低于 85%；
- 每个 lazy Operation 生产 JavaScript 闭包 gzip 不超过 80 KiB。
