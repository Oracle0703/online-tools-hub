# v1.0 发布检查表与证据索引

> 版本主题：本地工作流操作系统  
> 适用范围：Epic [#32](https://github.com/Oracle0703/online-tools-hub/issues/32) 与发布验收 [#36](https://github.com/Oracle0703/online-tools-hub/issues/36)  
> 状态：v1.0 发布门禁索引；执行结论以对应提交的自动门禁与真实浏览器证据为准
> 更新日期：2026-07-21

这份文档不保存手工填写的“通过”结论。GitHub Checks、Actions 日志和带提交 SHA 的 artifact 才是一次候选发布的执行证据；本表负责把每项完成定义映射到可复现命令、测试和产物，避免用上一条提交的结果替代当前提交。

## 1. 证据矩阵

| 发布维度                                        | 可复现门禁                                                                                                                                                                                                                                            | GitHub Actions 证据                                                       | 通过条件                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 静态路由、canonical、sitemap 与工作流结构化数据 | `npm run build:site`；[`scripts/verify-build.mjs`](../scripts/verify-build.mjs)；[`tests/e2e/mobile-seo.spec.ts`](../tests/e2e/mobile-seo.spec.ts)                                                                                                    | `CI / Format, lint, types, unit tests and build` 与三引擎 Playwright      | 六个工作流均可直达并进入 sitemap；详情页同时具备 SoftwareApplication、HowTo、BreadcrumbList；隐藏运行时不被索引；不发布 `/en/` 半成品路由 |
| Operation 与真实 Worker                         | [`tests/unit/operation-*.test.ts`](../tests/unit)；[`tests/e2e/operation-runtime.spec.ts`](../tests/e2e/operation-runtime.spec.ts)；[`tests/e2e/workflow-runtime.spec.ts`](../tests/e2e/workflow-runtime.spec.ts)                                     | `CI / Playwright (Chromium / Firefox / WebKit)`                           | lazy adapter、Transferable、超时、崩溃、硬取消和资源释放通过；测试期间没有业务网络请求或 canary 泄漏                                      |
| 工作流 Planner、Vault 与 Runner                 | [`tests/unit/workflow-*.test.ts`](../tests/unit)；[`tests/e2e/workflow-runtime.spec.ts`](../tests/e2e/workflow-runtime.spec.ts)                                                                                                                       | 三引擎 Playwright；失败时的 `playwright-report-*`                         | 六个内置模板完成；类型、配方大小、内存、晚到结果和 `pagehide` 边界通过                                                                    |
| 文件入口与受限批处理                            | [`tests/unit/workflow-file-input.test.ts`](../tests/unit/workflow-file-input.test.ts)；[`tests/unit/workflow-batch.test.ts`](../tests/unit/workflow-batch.test.ts)；[`tests/e2e/workflow-studio.spec.ts`](../tests/e2e/workflow-studio.spec.ts)       | 三引擎 Playwright                                                         | 数量、单项、总量、像素和输出预算在读取前执行；串行处理、逐项失败、取消、重试、ZIP 与隐私回执通过                                          |
| 隐私 canary 与资源释放                          | [`tests/unit/operation-privacy.test.ts`](../tests/unit/operation-privacy.test.ts)；[`tests/e2e/privacy-canary.spec.ts`](../tests/e2e/privacy-canary.spec.ts)；[`tests/e2e/pwa.spec.ts`](../tests/e2e/pwa.spec.ts)                                     | 三引擎 Playwright                                                         | 原文及 URL/Base64/Base64URL/SHA-256 表示不进入网络、URL/history 或持久化；Worker、Vault、Blob URL 与监听器归零                            |
| 构建与浏览器资源图                              | [`scripts/build-resource-graph.mjs`](../scripts/build-resource-graph.mjs)；[`tests/unit/build-resource-graph.test.ts`](../tests/unit/build-resource-graph.test.ts)；[`tests/e2e/resource-isolation.spec.ts`](../tests/e2e/resource-isolation.spec.ts) | Fast gate 构建日志与三引擎 Playwright                                     | 构建 gzip 预算和真实浏览器传输预算分别通过；页面资源集合对账无缺失或额外工具资源                                                          |
| PWA 与完整离线工作流                            | [`scripts/verify-build.mjs`](../scripts/verify-build.mjs)；[`tests/unit/pwa*.test.ts`](../tests/unit)；[`tests/e2e/pwa.spec.ts`](../tests/e2e/pwa.spec.ts)；[`tests/e2e/workflow-runtime.spec.ts`](../tests/e2e/workflow-runtime.spec.ts)             | Fast gate 与三引擎 Playwright                                             | 最小壳、用户主动完整包、资源哈希、query 导航隔离和断网六模板通过                                                                          |
| 360 px、键盘与 axe                              | [`tests/e2e/mobile-seo.spec.ts`](../tests/e2e/mobile-seo.spec.ts)；[`tests/e2e/accessibility.spec.ts`](../tests/e2e/accessibility.spec.ts)                                                                                                            | 三引擎 Playwright                                                         | 无横向溢出；触控目标不小于 44 px；关键流程可用键盘完成；axe 无 serious/critical                                                           |
| 移动端 Lighthouse                               | [`.lighthouserc.cjs`](../.lighthouserc.cjs)                                                                                                                                                                                                           | `CI / Lighthouse mobile quality gate`；`lighthouse-reports-*`，保留 14 天 | 首页、代表工具、知识中心、工作流与隐私能力中心的 Performance、Accessibility、Best Practices、SEO 均不低于 90                              |
| 真实 Edge 与 Safari                             | [`scripts/real-browser-smoke.mjs`](../scripts/real-browser-smoke.mjs)；[`scripts/verify-release-evidence.mjs`](../scripts/verify-release-evidence.mjs)                                                                                                | `Real Browser Release Candidate`；`release-evidence-v1-*`，保留 30 天     | Edge/Windows 与 Safari/macOS 使用同一构建；公开路由、真实工作流、隐私入口与 360 px 布局通过；聚合记录的 commit SHA 与候选提交一致         |

## 2. 候选发布操作

### 2.1 本地、无浏览器门禁

```bash
npm ci
ASTRO_TELEMETRY_DISABLED=1 npm run verify
```

- [ ] 格式化、ESLint 与 Astro 类型检查通过。
- [ ] Vitest 全局 line/function 不低于 90%，branch 不低于 85%。
- [ ] 生产构建、CSP、隐私清单、离线包和完整页面资源图通过。
- [ ] 构建输出明确显示六个公开工作流，且没有公开 `/en/` 路由。

### 2.2 Ready for review PR

- [ ] `Format, lint, types, unit tests and build` 通过。
- [ ] `Playwright (chromium)`、`Playwright (firefox)`、`Playwright (webkit)` 全部通过。
- [ ] `Lighthouse mobile quality gate` 通过，四类得分均不低于 90。
- [ ] 如有失败，从该次运行的 Playwright/Lighthouse artifact 诊断，不引用旧运行结果。

### 2.3 真实浏览器候选验收

- [ ] `Microsoft Edge on Windows 2025` 通过。
- [ ] `Safari on macOS 15` 通过；不能用 Playwright WebKit 代替。
- [ ] `Aggregate and verify v1.0 release evidence` 通过。
- [ ] `release-evidence-v1-*` 中同时存在 `edge.json`、`safari.json`、移动端截图和 `summary.json`。
- [ ] `summary.json` 的 `commit` 等于候选提交 SHA，两个浏览器记录均无 `error` 或 `quitError`。

### 2.4 合并与 Pages（发布后核验）

- [ ] PR 描述同时关联 #36 和 #32，并说明实际运行的门禁。
- [ ] 合并提交在 `main` 的 CI 全部通过。
- [ ] Pages 部署来自该次成功的 `main` CI `verified-site`，没有重新构建另一份产物。
- [ ] 生产地址可打开首页、`/workflows/`、一个文本工作流、图片工作流、`/privacy/` 与 `/sitemap.xml`。
- [ ] 在 Search Console / Bing Webmaster Tools 提交项目站 sitemap；GitHub 项目页不能从子目录控制主机根 `/robots.txt`。

## 3. 证据记录规则

1. 执行证据必须能定位到 commit SHA；分支名称、截图文字或“曾经通过”不足以替代。
2. GitHub Checks 页面保存结论，artifact 保存 Lighthouse 报告、失败上下文、真实浏览器 JSON 与截图；仓库不提交临时报告或用户输入。
3. 真实浏览器 JSON 只记录公开路径、标题、浏览器版本、断言布尔值与时间，不记录工具或工作流正文。
4. 如果候选提交在验收后发生变化，至少重跑受影响的门禁；发布 PR 的最终提交必须有完整绿灯。
5. 发现 Sev-0/Sev-1、隐私 canary、资源泄漏、严重/致命 axe 问题或任一 Lighthouse 类别低于 90 时，停止发布并修复，不能用文档豁免。

## 4. v1.0 收官条件

合并前，第 2.1 至 2.3 节必须全部通过，且 #36 的验收证据必须对应 PR 最终提交；收官 PR 用 `Closes #36` 与 `Closes #32` 在合并时关闭阶段任务和总 Epic。第 2.4 节只能在 `main` 部署后核验，若失败应立即停止发布并重新打开阻塞 Issue，不能把 PR 分支上的旧证据当作生产通过。
