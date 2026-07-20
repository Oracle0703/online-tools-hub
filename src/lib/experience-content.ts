export const experienceToolSlugs = [
  "json-formatter",
  "base64-codec",
  "url-codec",
  "unix-timestamp",
  "uuid-generator",
  "image-compressor",
] as const;

export type ExperienceToolSlug = (typeof experienceToolSlugs)[number];

export type TaskRecipe = {
  id: string;
  title: string;
  problem: string;
  outcome: string;
  tip: string;
  toolSlug: ExperienceToolSlug;
  relatedSlug?: ExperienceToolSlug;
};

export type ReleaseEntry = {
  version: string;
  date: `${number}-${number}-${number}`;
  theme: string;
  title: string;
  summary: string;
  changes: readonly string[];
};

type RecipeCollection = readonly [TaskRecipe, TaskRecipe, ...TaskRecipe[]];

/** 首页上的六个任务入口；每个入口只指向一个可以立即完成任务的现有工具。 */
export const homeTaskRecipes = [
  {
    id: "read-api-response",
    title: "把一整行接口响应整理到能读",
    problem:
      "从日志里复制出的 JSON 没有换行，订单、用户和错误字段挤在一起，很难判断层级。",
    outcome: "先确认语法是否完整，再展开嵌套结构，快速找到真正需要排查的字段。",
    tip: "准备发给同事前，先删掉令牌、邮箱和业务数据；格式化不会替你脱敏。",
    toolSlug: "json-formatter",
  },
  {
    id: "inspect-base64-field",
    title: "读懂配置里的 Base64 字段",
    problem:
      "配置或回调载荷里只有一段看不懂的编码文本，还可能包含中文或 Emoji。",
    outcome: "按 UTF-8 还原原文，并在标准 Base64 与 Base64URL 之间选对格式。",
    tip: "Base64 只是可逆编码。看到凭据或令牌时，不要把解码结果贴进工单。",
    toolSlug: "base64-codec",
  },
  {
    id: "safe-query-parameter",
    title: "把搜索词安全放进查询参数",
    problem:
      "关键词里有中文、空格、& 或 #，直接拼到链接后会截断参数或改变链接结构。",
    outcome:
      "只编码参数值，保留 ?、= 和 & 的结构，得到可以复制测试的完整链接。",
    tip: "每个参数值分别编码一次；看到 %25 时，先检查是不是重复编码。",
    toolSlug: "url-codec",
  },
  {
    id: "match-log-times",
    title: "对齐前端报错和服务器日志时间",
    problem:
      "监控里只有一串时间戳，不确定它是秒还是毫秒，也不确定日志使用哪个时区。",
    outcome:
      "把本地时间、UTC 与 ISO 8601 放在一起核对，缩小要检索的日志时间段。",
    tip: "把原始数值和单位一起记进工单，避免下一位排查者再次猜测。",
    toolSlug: "unix-timestamp",
  },
  {
    id: "seed-test-records",
    title: "给一批测试记录补上 UUID",
    problem:
      "导入样例数据前需要多个格式正确的随机 ID，逐个手写既慢又容易重复。",
    outcome: "一次生成所需数量，整批复制或下载，再粘贴到本地种子数据中。",
    tip: "UUID 适合做记录标识，不要把它当作密码、API 密钥或权限校验。",
    toolSlug: "uuid-generator",
  },
  {
    id: "shrink-screenshots",
    title: "把一批截图压到适合上传的大小",
    problem:
      "高分辨率截图超过文档、工单或 CMS 的文件限制，逐张调整尺寸很费时间。",
    outcome: "统一限制最长边和输出格式，比较压缩前后体积后批量取回。",
    tip: "先保留原图；带透明背景的素材转换为 JPEG 前要特别检查预览。",
    toolSlug: "image-compressor",
  },
] as const satisfies readonly TaskRecipe[];

/**
 * 工具页场景。它们描述何时使用与完成后的判断标准，不复述页面上的操作步骤。
 */
export const toolUseCases = {
  "json-formatter": [
    {
      id: "json-review-webhook",
      title: "检查第三方 Webhook 的嵌套载荷",
      problem:
        "事件类型、对象快照和变更列表混在一段紧凑 JSON 中，肉眼很难确认字段属于哪一层。",
      outcome: "展开结构后能沿着对象与数组逐层核对，并截取一段最小复现载荷。",
      tip: "签名头和原始请求体要另行保留；重新排版后的文本不能用于验签。",
      toolSlug: "json-formatter",
      relatedSlug: "base64-codec",
    },
    {
      id: "json-stable-fixture",
      title: "整理可审查的接口测试夹具",
      problem:
        "测试样例的缩进各不相同，代码评审里充满与数据变化无关的空白差异。",
      outcome: "统一排版后，版本差异更集中在新增、删除或改动的字段上。",
      tip: "先约定项目使用 2 空格还是 4 空格，再把整理后的文件纳入版本控制。",
      toolSlug: "json-formatter",
    },
    {
      id: "json-compact-config",
      title: "压缩要嵌入测试请求的 JSON",
      problem:
        "多行配置需要放进单行环境变量或命令参数，换行和多余空白会妨碍粘贴。",
      outcome: "得到语义不变的单行 JSON，便于放进临时测试配置。",
      tip: "单行化不会减小敏感性；进入 URL 前还需要按所在参数单独编码。",
      toolSlug: "json-formatter",
      relatedSlug: "url-codec",
    },
  ],
  "base64-codec": [
    {
      id: "base64-inspect-token-part",
      title: "查看令牌中 Base64URL 编码的载荷片段",
      problem:
        "调试时需要确认一个点号分隔令牌里声明了哪些字段，但片段省略了填充。",
      outcome: "使用 Base64URL 还原可读文本，再把 JSON 字段整理出来检查。",
      tip: "读到载荷不代表令牌可信；签名、有效期和受众仍应由服务端验证。",
      toolSlug: "base64-codec",
      relatedSlug: "json-formatter",
    },
    {
      id: "base64-ci-config",
      title: "把含中文的测试配置变成单行文本",
      problem: "临时 CI 参数不便直接携带换行、引号和非 ASCII 字符。",
      outcome: "按 UTF-8 编码成一行 Base64，并能在接收端无损还原测试内容。",
      tip: "如果配置含密钥，应改用 CI 的机密变量；Base64 不提供保密能力。",
      toolSlug: "base64-codec",
    },
    {
      id: "base64-debug-callback",
      title: "确认回调字段究竟是文本还是损坏字节",
      problem:
        "回调中的编码字段在另一套系统里出现乱码，不清楚问题发生在 Base64 还是字符集。",
      outcome:
        "严格按 UTF-8 解码后，可区分无效 Base64、无效 UTF-8 与正常多语言文本。",
      tip: "记录原始编码串和发送方声明的字符集，避免用乱码结果覆盖原始证据。",
      toolSlug: "base64-codec",
    },
  ],
  "url-codec": [
    {
      id: "url-build-search-link",
      title: "组装不会串参数的搜索链接",
      problem:
        "搜索词包含 &、= 或 # 时，直接拼接会被浏览器解释为新参数或片段。",
      outcome: "参数值被单独转义，链接结构与用户输入各自保持清楚。",
      tip: "先编码值再拼接 URL，不要对已经组装好的整条链接重复使用组件编码。",
      toolSlug: "url-codec",
    },
    {
      id: "url-find-double-encoding",
      title: "排查重定向里的重复编码",
      problem:
        "回跳地址里出现 %252F 或 %253F，服务端解码一次后仍不是预期路径。",
      outcome: "逐层解码并比较每一层结果，确认是哪一跳多做了一次编码。",
      tip: "一次只解码一层并保留原串；不要把未知链接直接打开验证。",
      toolSlug: "url-codec",
    },
    {
      id: "url-safe-path-segment",
      title: "把用户提供的文件名放进路径片段",
      problem: "文件名含空格、中文、? 或 /，直接插入路径会改变路由含义。",
      outcome: "仅转义这个路径片段，同时保留域名与其他路径分隔符。",
      tip: "编码不能代替服务端路径校验；仍要拒绝越权目录和不允许的文件名。",
      toolSlug: "url-codec",
    },
  ],
  "unix-timestamp": [
    {
      id: "timestamp-correlate-incident",
      title: "把浏览器报错对齐到 UTC 日志",
      problem: "用户给的是本地发生时间，服务端日志却只记录 UTC 或 Unix 数值。",
      outcome:
        "把同一时刻转换为本地、UTC 与 ISO 表示，得到明确的日志检索窗口。",
      tip: "夏令时切换附近要同时记录时区名称和 UTC 偏移，不要只写“下午三点”。",
      toolSlug: "unix-timestamp",
    },
    {
      id: "timestamp-audit-units",
      title: "核对数据迁移中的秒与毫秒",
      problem:
        "新旧表的时间字段位数不同，误把毫秒当秒会生成远超合理范围的日期。",
      outcome: "用已知记录交叉转换，确认每个字段的单位后再编写迁移规则。",
      tip: "不要只凭位数下结论；把单位写进字段名、模式说明和测试断言。",
      toolSlug: "unix-timestamp",
    },
    {
      id: "timestamp-fixed-test-date",
      title: "为到期逻辑准备固定测试时刻",
      problem: "测试依赖“现在”会在不同电脑和时区得到不一致结果。",
      outcome: "从一个明确日期生成固定的秒或毫秒值，让测试夹具可重复。",
      tip: "优先保存带 Z 或明确偏移的 ISO 时间，并在断言旁注明使用的时间戳单位。",
      toolSlug: "unix-timestamp",
      relatedSlug: "json-formatter",
    },
  ],
  "uuid-generator": [
    {
      id: "uuid-seed-database",
      title: "为本地数据库种子生成主键",
      problem:
        "一组互相关联的测试记录需要格式正确的 UUID，手写占位值容易漏位或重复。",
      outcome: "批量取得可直接放入种子文件的 v4 标识符，再明确分配给每条记录。",
      tip: "先建立 ID 与记录的对应表，避免复制后打乱外键关系。",
      toolSlug: "uuid-generator",
      relatedSlug: "json-formatter",
    },
    {
      id: "uuid-request-samples",
      title: "准备接口文档里的请求示例",
      problem:
        "示例中的 123 或 abc 不符合真实字段格式，读者复制后会先撞上校验错误。",
      outcome: "用结构合法但不对应生产对象的 UUID，让示例更接近真实请求。",
      tip: "在文档中明确标注它们是样例值，避免被误认为可访问的真实资源。",
      toolSlug: "uuid-generator",
    },
    {
      id: "uuid-replace-sample-keys",
      title: "替换演示数据里的内部记录号",
      problem:
        "共享数据结构时不想暴露内部 ID，但多张记录之间仍需保持引用关系。",
      outcome: "生成一批新 UUID，按映射表一致替换主键与外键。",
      tip: "这只是标识符替换，不是完整匿名化；姓名、时间和自由文本仍可能识别人。",
      toolSlug: "uuid-generator",
      relatedSlug: "json-formatter",
    },
  ],
  "image-compressor": [
    {
      id: "image-cms-limit",
      title: "让内容图片符合 CMS 上传限制",
      problem:
        "相机或设计稿导出的图片尺寸远大于页面展示区域，也超过后台单文件上限。",
      outcome: "限制最长边并选择合适质量，在上传前看到每张图片的体积变化。",
      tip: "先按实际展示尺寸缩放，再微调质量，通常比只降低质量更有效。",
      toolSlug: "image-compressor",
    },
    {
      id: "image-bug-report",
      title: "压缩一组仍需看清文字的报错截图",
      problem: "工单附件很多且体积大，但堆栈、提示文字和界面状态必须保持可读。",
      outcome: "批量输出较小文件，并逐张预览确认关键文字没有糊掉。",
      tip: "包含小字号文字时不要过度缩小最长边；先试较高质量再比较结果。",
      toolSlug: "image-compressor",
      relatedSlug: "unix-timestamp",
    },
    {
      id: "image-prototype-webp",
      title: "为网页原型准备轻量 WebP 素材",
      problem: "原型目录里混有大体积 JPEG 和 PNG，加载缓慢且不便统一管理。",
      outcome: "在本地统一转为 WebP、约束尺寸，并保留可回退的原始素材。",
      tip: "转换后检查透明区域与细线；品牌主视觉应由设计源文件导出最终版本。",
      toolSlug: "image-compressor",
    },
  ],
} as const satisfies Record<ExperienceToolSlug, RecipeCollection>;

/** 更新日志的唯一数据源，按发布时间从新到旧排列。 */
export const releases = [
  {
    version: "0.6.0",
    date: "2026-07-20",
    theme: "内容与场景增强",
    title: "从真实任务更快找到合适工具",
    summary:
      "补足任务入口、工具专属场景和最近更新，让用户在操作前就能判断工具是否适合手头问题。",
    changes: [
      "首页新增六个真实任务入口，分别连接现有 JSON、Base64、URL、时间戳、UUID 和图片工具；",
      "为每个工具补充专属使用场景，说明问题、预期结果、经验提示与自然的后续工具；",
      "首页最近更新与完整更新日志改用同一份版本数据，减少内容不同步；",
      "场景卡片与更新列表采用语义化结构，并完善窄屏阅读和键盘焦点体验。",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-07-19",
    theme: "全站体验统一",
    title: "更简洁、更一致的工具工作区",
    summary:
      "统一站点视觉与交互语言，并让搜索、本地处理状态和移动端体验更容易理解。",
    changes: [
      "统一浅色与深色主题的色彩、边框、圆角、间距和交互反馈；",
      "精简导航、首页、工具卡片、分类页和页脚的信息层级；",
      "新增全站工具搜索，并支持 Ctrl / Command + K 快速打开；",
      "重构图片压缩工作区，移除冗余装饰与重复状态，保留清晰的设置和结果流程；",
      "将本地处理声明前置到所有工具工作区，并继续完善移动端、无障碍和 SEO 契约。",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-07-19",
    theme: "本地图片处理",
    title: "图片压缩与格式转换",
    summary:
      "上线浏览器本地图片压缩、缩放与格式转换，并明确不同格式和编码器的能力边界。",
    changes: [
      "上线 JPEG、PNG、WebP 批量压缩与格式转换；",
      "支持调整质量与最长边，并单独下载或打包取回结果；",
      "文件只在浏览器内存处理，补充 Blob URL、元数据和动画格式边界说明；",
      "采用浏览器编码与 PNG 色彩量化，不宣称复现第三方专有算法；",
      "扩展为六个工具，并同步更新移动端目录、SEO 和站点地图。",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-07-19",
    theme: "MVP 工具集",
    title: "四个新工具与全站移动端、SEO 完善",
    summary:
      "补齐常用编解码、时间和标识符工具，并完善每个工具的独立说明与发现入口。",
    changes: [
      "上线 Base64 / Base64URL 与 URL 编解码工具；",
      "上线 Unix 时间戳转换与 UUID v4 批量生成器；",
      "完善工具页独立指南、常见问题和结构化数据；",
      "加强 360px 移动端布局、社交分享信息和站点地图。",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-07-19",
    theme: "首个可用工具",
    title: "JSON 格式化与校验",
    summary:
      "交付首个完整工具，并把精确错误、本地处理和数值保真作为后续工具的基础标准。",
    changes: [
      "支持 2 空格、4 空格、Tab 缩进和压缩模式；",
      "无效输入会显示行、列和附近上下文；",
      "超出安全整数范围的数字保持原始词法，不会被静默改写；",
      "加入示例、复制、下载、清空、大小与处理耗时状态。",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-07-19",
    theme: "项目基础",
    title: "站点骨架与设计系统",
    summary:
      "建立可静态部署的站点基础、统一工具注册表，以及浏览器本地处理的产品原则。",
    changes: [
      "建立 Astro + React + TypeScript 静态应用；",
      "完成首页、目录、分类、工具外壳和信息页面；",
      "加入 GitHub Pages 子路径支持与统一工具注册表；",
      "发布本地处理原则和隐私说明。",
    ],
  },
] as const satisfies readonly ReleaseEntry[];

/** 首页默认展示的三个最近版本。 */
export const recentReleases: readonly ReleaseEntry[] = releases.slice(0, 3);

export function isExperienceToolSlug(slug: string): slug is ExperienceToolSlug {
  return (experienceToolSlugs as readonly string[]).includes(slug);
}

export function getToolUseCases(slug: string): readonly TaskRecipe[] {
  return isExperienceToolSlug(slug) ? toolUseCases[slug] : [];
}
