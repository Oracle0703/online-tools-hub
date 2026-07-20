# 发布验收与证据

Online Tools Hub 把“可以发布”定义为一组可重复验证的门禁，而不是一次人工浏览。

## Pull Request 分层门禁

- Draft PR：格式化、静态检查、类型检查、单元测试、覆盖率和生产构建。
- Ready for review：增加 Chromium、Firefox、WebKit 的完整 Playwright 套件，以及七个核心页面的移动端 Lighthouse 门禁。
- Ready for review：在 GitHub 托管的 `windows-2025` 和 `macos-15` 环境中，分别用真实 Microsoft Edge 与 Safari 完成候选发布冒烟测试。
- `main`：重跑全部门禁；只有 CI 整体成功后，Pages 工作流才部署同一已验证提交。

## 自动验收范围

Playwright 套件覆盖：

- 六个工具的核心功能、错误路径和直达路由；
- 360px 布局、44px 触控目标和 `prefers-reduced-motion`；
- 独立标题、描述、canonical、Open Graph、robots 和结构化数据；
- 隐私 canary 的原文、URL 编码、Base64、Base64URL 与 SHA-256 表示；
- Cookie、URL/history、Local/Session Storage、IndexedDB、网络请求、控制台、剪贴板读取与 Blob URL 生命周期；其中 LocalStorage 只允许版本化的主题或快捷工具元数据，工具输入、输出及其编码或哈希表示均不得写入；
- axe WCAG A/AA 扫描，不允许 serious 或 critical 问题。

Lighthouse 对 performance、accessibility、best-practices 和 SEO 四项均要求移动端分数不低于 90。报告作为 Actions artifact 保留 14 天。

## 真实浏览器记录

`.github/workflows/release-candidate.yml` 不把 Playwright WebKit 当作 Safari 的替代品。它通过系统浏览器及其原生 WebDriver 完成：首页和六个工具直达、JSON 实际交互、360px 无横向溢出、本地隐私标识检查。每个 Job 上传 JSON 记录与截图，保留 30 天。

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
