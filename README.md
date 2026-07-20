# Online Tools Hub

隐私优先、无需登录、在浏览器本地运行的综合在线工具站。

当前已提供十个可直接使用的工具：

- JSON 格式化与校验
- Base64 / Base64URL 编解码
- URL 编解码
- Unix 时间戳转换
- UUID v4 生成
- JPEG、PNG、WebP 图片压缩与格式转换
- 文本差异对比
- SHA-256 / SHA-512 文本与文件哈希
- YAML 1.2 与 JSON 双向转换
- JWT Header、Payload 与时间声明检查（不验证签名）

0.7.0 新增上述四项开发与数据处理能力；十个工具均保持浏览器本地处理、无需登录和静态部署。

## 核心原则

- 用户输入默认只存在于当前页面内存；
- 本地工具不会把输入发送到应用服务器；
- 不把输入写入 URL、Cookie 或浏览器持久化存储；
- 主题、收藏与最近使用保存在当前浏览器；快捷记录仅包含工具标识和时间戳，不包含输入、输出或文件内容；
- 工具页面统一说明处理位置、输入限制和安全边界。

完整范围、架构、验收标准和路线图见 [产品与技术设计文档](docs/PROJECT_PLAN.md)。实施任务见 [GitHub Issues](https://github.com/Oracle0703/online-tools-hub/issues)。
站点所用运行时开源组件及许可证见 [第三方声明](THIRD_PARTY_NOTICES.md)。
分层 CI、Lighthouse 与真实浏览器验收见 [发布验收与证据](docs/RELEASE_ACCEPTANCE.md)。

## 本地开发

需要 Node.js 22.22.3（或兼容的新版本）与 npm 9 或更高版本。

```bash
npm install
npm run dev
```

## 质量检查

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run test:lighthouse
```

安装 Playwright 浏览器后可运行端到端测试：

```bash
npx playwright install
npm run test:e2e
```

`npm run verify` 会一次执行格式、代码规范、类型、覆盖率和生产构建门禁。Ready for review 的 PR 还会在 GitHub Actions 中运行三引擎 Playwright、axe、移动端 Lighthouse，以及真实 Edge/Windows 与 Safari/macOS 冒烟验收。

## 部署

生产构建采用 Astro Static Build，并通过 GitHub Actions 发布到：

`https://oracle0703.github.io/online-tools-hub/`

仓库已使用 **Settings → Pages → Build and deployment → GitHub Actions** 自动部署。

## SEO 发布检查

站点地图发布在 `https://oracle0703.github.io/online-tools-hub/sitemap.xml`。
GitHub 项目页无法从子目录控制主机根 `/robots.txt`，因此发布后应在 Google
Search Console 和 Bing Webmaster Tools 中直接提交上述站点地图；如需自定义
robots 规则，应由 `Oracle0703.github.io` 根站或自定义域提供。
