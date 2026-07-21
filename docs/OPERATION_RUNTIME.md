# Operation Runtime 架构

Online Tools Hub v1.0 把十二个现有工具的纯核心包装为同一套可组合执行单元。Operation Runtime 只负责本地计算，不负责界面状态、正文持久化、网络请求或工作流编排。

## 1. 模块边界

```text
纯 Operation catalog
  → 执行前契约校验
  → 按 Operation ID 动态加载 adapter
  → 小型确定性任务：受控主线程执行
  → 大型或复杂度不可预测任务：独占 Worker
  → 输出预算复核
  → 结果返回调用方
  → terminate / release
```

- `src/operations/catalog.ts` 只包含可 JSON 序列化的 manifest，不导入工具算法或界面代码；
- `src/operations/runtime-registry.ts` 使用构建期白名单动态加载单个 adapter，不接受远程模块或任意脚本；
- `src/operations/adapters/` 只复用 `src/tools/*/core.ts` 的既有算法，并把结果映射为统一 payload；
- `src/operations/executor.ts` 决定执行位置、跟踪内存、处理取消、超时和 Worker 崩溃；
- `src/workers/operation.worker.ts` 在独立执行域内再次校验请求与输出。

纯 catalog 与 runtime 分离是强制边界。首页、内容页以及单工具页不会因为列出 Operation 而下载其他工具实现。

## 2. 契约

每个 manifest 至少声明：

- 稳定 Operation ID 与所属工具 slug；
- 接受的输入和输出 payload 类型；
- 最大输入、最大输出与估算工作内存；
- `main`、`adaptive` 或 `worker` 执行策略；
- Worker 阈值与超时时间；
- 使用 Web Crypto、安全随机数等能力的显式清单；
- 网络和持久化均为 `forbidden` 的隐私声明。

当前 payload 仅允许空输入、文本、文本对、二进制和 RGBA 图片；输出仅允许文本或二进制。选项必须由普通 JSON 值组成，危险键、循环引用、函数和不可克隆对象在加载算法前即被拒绝，序列化后还要通过 64 KiB 独立上限。

## 3. 调度与取消

- `worker` 操作始终进入 Worker；
- `adaptive` 操作在输入超过 128 KiB 时进入 Worker；
- `main` 只用于有严格上限、能够在主线程预算内完成的操作；
- 每个 Worker 只执行一个任务，避免取消一个任务时污染其他任务；
- 调用 `cancel()` 会同步 `terminate()` Worker，并把任务稳定地结算为 `cancelled`；
- 超时、消息协议错误、Worker 异常和 executor 销毁都走同一清理路径；
- 二进制输入先复制再 transfer，调用方持有的源缓冲区不会被意外 detach；二进制输出 transfer 回主线程后立即终止 Worker。

所有 executor 实例共享 512 MiB 保守 admission 预算、4 个活动任务和 2 个活动 Worker 上限；资源门禁发生在大对象快照之前。`workingMemoryBytes` 是为输入、输出、中间树和算法副本预留的调度额度，不是浏览器 JS heap 的精确测量或硬配额。无论成功、失败或取消，请求快照、事件监听、Worker 引用和预留额度都会在同一清理路径释放。

主线程任务只能在同步核心返回后复核 deadline；JavaScript 无法从外部硬中断正在运行的同步函数。因此只有严格有界的小任务可以使用 `main`，不可预测任务必须使用 Worker，Worker 超时和取消则会立即 `terminate()`。

## 4. 隐私与安全

Operation 层禁止使用：

- `fetch`、XHR、WebSocket、EventSource 或 Beacon；
- Local/Session Storage、IndexedDB、Cache Storage 或 Cookie；
- URL/history 写入；
- 远程模块、动态代码执行和用户脚本。

这些限制由四层共同保障：CSP `connect-src 'none'`、构建期白名单注册表、adapter 加载前安装的 Worker fail-closed 能力 guard，以及扫描 Operation、Worker、工具核心和生产依赖源码的隐私 canary。manifest 的隐私字段是可审计声明，不用于绕过任何门禁。

## 5. 错误模型

调用方只需要处理稳定错误码：未知操作、类型不匹配、输入或输出超限、内存预算不足、选项无效、超时、取消、Worker 崩溃、执行失败和环境不支持。错误详情不得包含完整输入、输出、文件名或内容哈希。

## 6. 验收

- 十二个 manifest 可序列化，并与十二个动态 adapter 一一对应；
- adapter 结果与现有纯核心公开向量一致；
- 未知 ID、错误类型、危险选项和超限请求在算法加载前失败；
- Worker 完成、失败、超时、取消和崩溃都只结算一次并释放资源；
- 输出在 Worker 内和主线程接收后均执行预算复核；
- Operation/Worker 源码不包含联网、持久化或 history 写入原语；
- 生产构建中的真实 module Worker 在 Chromium、Firefox 与 WebKit 完成执行、transfer、硬取消和隐私 canary；
- 全部类型检查、单元测试、覆盖率、生产构建和现有浏览器门禁继续通过。

## 7. v1 后续扩展点

#34 只建立安全执行基线。供 Workflow Studio 静态发现和表单生成使用的 option schema、语义 content type 与 determinism 元数据在 #37 扩展 manifest；图片文件解码、完整压缩参数和批处理体验在 #35 接入。当前图片 Operation 明确只负责已验证 RGBA 像素到 PNG 的本地 Worker 编码，不宣称已经覆盖完整图片工具流程。
