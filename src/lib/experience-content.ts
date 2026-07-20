export const experienceToolSlugs = [
  "json-formatter",
  "base64-codec",
  "url-codec",
  "unix-timestamp",
  "uuid-generator",
  "image-compressor",
  "text-diff",
  "hash-generator",
  "yaml-json-converter",
  "jwt-decoder",
  "csv-json-converter",
  "query-params",
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

/** 首页上的任务入口；每个入口只指向一个可以立即完成任务的现有工具。 */
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
  {
    id: "review-config-change",
    title: "看清两版配置到底改了什么",
    problem:
      "上线前拿到两段很像的配置文本，只靠来回切换很容易漏掉一行新增或删除。",
    outcome: "把两版内容并排比较，集中审阅新增、删除与相邻修改行。",
    tip: "忽略空白适合排除排版噪声；正式提交前仍要用项目自己的差异工具复核。",
    toolSlug: "text-diff",
  },
  {
    id: "verify-download-checksum",
    title: "核对下载文件是否完整",
    problem:
      "发布页给出一串 SHA-256，但不知道本地文件是否在下载或传递时发生变化。",
    outcome: "在浏览器本地计算文件摘要，并与发布方提供的哈希逐位比较。",
    tip: "只从可信渠道取得预期哈希；文件和哈希若来自同一个被篡改来源，核对也无法证明可信。",
    toolSlug: "hash-generator",
  },
  {
    id: "move-config-between-formats",
    title: "把 YAML 配置转成接口需要的 JSON",
    problem:
      "本地配置以 YAML 编写，调试接口却只接受 JSON，还需要提前发现重复键和类型问题。",
    outcome: "严格解析单个 YAML 文档，得到可复制的 JSON 并明确提示不兼容内容。",
    tip: "JSON 不支持注释；转换前保留原始 YAML，避免覆盖有说明文字的源文件。",
    toolSlug: "yaml-json-converter",
    relatedSlug: "json-formatter",
  },
  {
    id: "inspect-jwt-claims",
    title: "查看 JWT 为什么看起来已经过期",
    problem:
      "调试请求返回 401，需要确认令牌里的算法、签发信息和 exp 时间是否符合预期。",
    outcome: "本地查看 Header、Payload 和时间声明，快速形成下一步排查线索。",
    tip: "能读到声明不等于签名有效；最终结论必须来自持有可信密钥的服务端验证。",
    toolSlug: "jwt-decoder",
    relatedSlug: "unix-timestamp",
  },
  {
    id: "convert-csv-api-data",
    title: "把表格导出的 CSV 变成接口样例",
    problem:
      "从表格系统导出的数据包含前导零、逗号和换行，需要转成可以审查的 JSON。",
    outcome:
      "严格检查表头与列数，把单元格保留为字符串，并得到结构清楚的对象数组。",
    tip: "先确认分隔符；订单号、邮编和长 ID 通常不应该自动推断成数字。",
    toolSlug: "csv-json-converter",
    relatedSlug: "json-formatter",
  },
  {
    id: "inspect-query-parameters",
    title: "看清一条复杂链接究竟带了哪些参数",
    problem:
      "链接包含重复键、空值和编码字符，直接阅读很难确认服务端最终会收到什么。",
    outcome:
      "按顺序展开每个参数，编辑后重建完整地址，并保留重复项与无等号差异。",
    tip: "分享链接前移除令牌和个人信息；URL 可能进入历史记录与服务器日志。",
    toolSlug: "query-params",
    relatedSlug: "url-codec",
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
  "text-diff": [
    {
      id: "diff-review-config",
      title: "审阅部署配置的两次修改",
      problem:
        "两个环境的配置大体相同，但一个端口、开关或域名的差别就可能改变上线结果。",
      outcome: "按行集中查看增删和相邻修改，整理出需要确认的最小变更清单。",
      tip: "密钥、连接串和内部地址应先脱敏；差异工具不会自动识别敏感字段。",
      toolSlug: "text-diff",
      relatedSlug: "yaml-json-converter",
    },
    {
      id: "diff-clean-copy-edit",
      title: "比较文案修改而不被排版干扰",
      problem:
        "内容评审需要关注文字变化，但复制来源带来的大小写或行尾空白制造了大量噪声。",
      outcome: "按需忽略大小写或空白，把注意力放回真实的句子增删。",
      tip: "忽略规则只影响匹配；最终采用哪版标点和空白仍要回到原文确认。",
      toolSlug: "text-diff",
    },
    {
      id: "diff-log-sequences",
      title: "对比成功与失败请求的日志片段",
      problem:
        "两次调用路径相近，只有少数状态行或返回字段不同，手动滚动难以定位分叉点。",
      outcome: "把两段日志对齐，快速看到失败流程多出、少掉或改变的步骤。",
      tip: "先移除令牌、用户数据和随机请求 ID，减少噪声也避免调试内容外泄。",
      toolSlug: "text-diff",
      relatedSlug: "unix-timestamp",
    },
  ],
  "hash-generator": [
    {
      id: "hash-verify-release",
      title: "核对软件包与发布摘要",
      problem:
        "下载完成后需要确认文件字节与发布者给出的 SHA-256 或 SHA-512 完全一致。",
      outcome: "本地生成相同算法的摘要并逐位核对，发现传输损坏或意外变化。",
      tip: "预期哈希必须来自可信且独立的渠道；摘要匹配本身不证明发布者身份。",
      toolSlug: "hash-generator",
    },
    {
      id: "hash-compare-export",
      title: "确认两次导出得到相同内容",
      problem: "大文件不便逐行检查，只想快速判断两份导出物的原始字节是否一致。",
      outcome: "分别计算摘要；值完全相同可作为内容一致的高可信检查。",
      tip: "文本换行、编码或元数据的细微变化都会改变摘要，这正是哈希核对的目的。",
      toolSlug: "hash-generator",
      relatedSlug: "text-diff",
    },
    {
      id: "hash-api-fixture",
      title: "准备接口签名调试中的消息摘要",
      problem:
        "需要确认某一步 SHA 计算是否正确，但不想把请求正文发送到第三方服务。",
      outcome:
        "按 UTF-8 对本地文本生成明确算法的十六进制摘要，用于对照中间结果。",
      tip: "完整的消息认证通常还需要 HMAC 或数字签名；普通 SHA 不能证明发送者身份。",
      toolSlug: "hash-generator",
    },
  ],
  "yaml-json-converter": [
    {
      id: "yaml-api-payload",
      title: "把 YAML 样例变成接口 JSON",
      problem:
        "文档或配置仓库提供 YAML 示例，调试客户端却需要一个严格的 JSON 请求体。",
      outcome:
        "转换为 JSON 后继续格式化核对，避免手动改引号和缩进造成语法错误。",
      tip: "转换不会保留注释；把 JSON 当作派生结果，原始说明仍留在 YAML 中。",
      toolSlug: "yaml-json-converter",
      relatedSlug: "json-formatter",
    },
    {
      id: "yaml-detect-config-error",
      title: "上线前发现 YAML 重复键和语法错误",
      problem:
        "看似正常的配置可能重复声明同名字段，解析器最终采用哪个值并不直观。",
      outcome: "通过严格解析获得行列提示，在部署工具接手前修正歧义。",
      tip: "不同系统采用的 YAML 模式可能不同；最终还要运行目标应用自己的配置校验。",
      toolSlug: "yaml-json-converter",
      relatedSlug: "text-diff",
    },
    {
      id: "yaml-share-readable-config",
      title: "把 JSON 配置整理为易读 YAML",
      problem: "嵌套 JSON 适合机器处理，但在内部说明中不便阅读和手动讨论。",
      outcome: "生成结构清楚的 YAML 草稿，再补上项目需要的说明与注释。",
      tip: "往返结果以数据等价为目标，不保证原字段样式、引号选择或空白完全一致。",
      toolSlug: "yaml-json-converter",
      relatedSlug: "text-diff",
    },
  ],
  "jwt-decoder": [
    {
      id: "jwt-debug-expiry",
      title: "排查访问令牌何时过期",
      problem:
        "接口突然返回未授权，需要确认 exp、nbf 与当前时间的关系是否符合预期。",
      outcome: "把数值日期转换为 ISO 时间，判断令牌看起来已过期还是尚未生效。",
      tip: "客户端时钟可能不准；生产系统仍应由验证方按允许的时钟偏差处理。",
      toolSlug: "jwt-decoder",
      relatedSlug: "unix-timestamp",
    },
    {
      id: "jwt-check-environment",
      title: "确认令牌来自哪个环境",
      problem:
        "测试与生产令牌外观相似，需要查看 iss、aud 或自定义环境声明来排查误用。",
      outcome:
        "读取公开 Payload 后形成线索，再回到服务端配置核对预期签发者和受众。",
      tip: "声明内容可以被任意伪造；未验证签名前不能据此认定令牌来源。",
      toolSlug: "jwt-decoder",
    },
    {
      id: "jwt-review-algorithm",
      title: "检查令牌头声明的算法",
      problem:
        "集成双方对签名算法或 key id 的约定不一致，验证端只返回模糊错误。",
      outcome:
        "查看 alg、typ 和 kid 后，与验证服务的允许列表和密钥配置逐项核对。",
      tip: "验证端必须自行固定允许的算法，绝不能因为令牌 Header 声明了某算法就直接信任。",
      toolSlug: "jwt-decoder",
      relatedSlug: "base64-codec",
    },
  ],
  "csv-json-converter": [
    {
      id: "csv-import-api-fixture",
      title: "把运营表格整理成接口测试数据",
      problem:
        "表格导出的 CSV 含中文、前导零和带逗号备注，简单拆分后字段发生错位。",
      outcome:
        "按引号规则解析并检查每行列数，得到可继续格式化的 JSON 对象数组。",
      tip: "转换后抽查首行、末行和包含换行的字段，确认来源文件使用的分隔符。",
      toolSlug: "csv-json-converter",
      relatedSlug: "json-formatter",
    },
    {
      id: "csv-export-review",
      title: "把 JSON 记录导出给表格软件",
      problem:
        "一组结构一致的对象需要交给非开发同事查看，但手动拼 CSV 容易漏掉转义。",
      outcome: "使用统一表头导出 CSV，为逗号、引号和换行字段自动添加正确引号。",
      tip: "对象字段必须保持一致；嵌套对象需要先决定扁平化规则，而不是让工具猜测。",
      toolSlug: "csv-json-converter",
    },
    {
      id: "csv-preserve-identifiers",
      title: "迁移不能丢前导零的编号",
      problem:
        "邮编、工号或 SKU 看起来像数字，导入后却被自动改写，无法还原原值。",
      outcome: "单元格以字符串进入 JSON，00123 与长编号都保持原样。",
      tip: "JSON 来源里的超大数值若已经失真无法恢复；应从源头改成带引号字符串。",
      toolSlug: "csv-json-converter",
    },
  ],
  "query-params": [
    {
      id: "query-debug-duplicates",
      title: "排查同名参数为什么只生效一个",
      problem: "请求中多次出现 tag 或 filter，但普通对象视图覆盖了前面的值。",
      outcome: "以有序列表查看每一项，确认重复键的顺序和值是否符合接口约定。",
      tip: "不要在未确认服务端规则前去重；不同框架可能选择首项、末项或全部值。",
      toolSlug: "query-params",
    },
    {
      id: "query-rebuild-callback",
      title: "调整回调地址中的参数而不破坏片段",
      problem:
        "完整 URL 同时包含查询串和 # 片段，手动修改时容易重复问号或丢失结构。",
      outcome: "分别编辑参数后重建完整 URL，保留原有路径与片段。",
      tip: "回调地址本身作为另一个参数时，需要对它单独做组件编码。",
      toolSlug: "query-params",
      relatedSlug: "url-codec",
    },
    {
      id: "query-audit-empty-values",
      title: "区分空值、空键和无等号开关",
      problem:
        "flag、flag= 与 =value 在测试环境表现不同，但常见解析器把它们显示成同一种结果。",
      outcome: "保留每项是否带等号的语义，构造可重复的边界测试 URL。",
      tip: "排序会改变参数顺序；只有确认目标系统不依赖顺序时再使用。",
      toolSlug: "query-params",
    },
  ],
} as const satisfies Record<ExperienceToolSlug, RecipeCollection>;

/** 更新日志的唯一数据源，按发布时间从新到旧排列。 */
export const releases = [
  {
    version: "0.9.0",
    date: "2026-07-20",
    theme: "智能本地工作流",
    title: "从内容识别到跨工具处理，更快完成任务",
    summary:
      "新增本地智能入口、覆盖工具与知识内容的命令面板，以及由用户主动触发的安全跨工具接力。",
    changes: [
      "首页新增智能入口，可在当前标签页识别 JSON、JWT、URL、查询串、Base64、时间戳、CSV、TSV、YAML 和图片，并推荐最多三个合适工具；",
      "全站命令面板统一搜索工具、指南和常见任务，支持中文任务表达、键盘操作，并优先展示收藏与最近使用；",
      "为 CSV、Base64、URL 和 JWT 的常见后续步骤加入安全接力：仅在点击后复制结果并打开目标工具，正文不进入 URL 或持久化存储；",
      "智能识别不自动读取剪贴板，识别建议不复述原文，文本限制为 2 MiB，图片只检查必要的文件信息与签名字节；",
      "同步完善 360 px 移动端布局、无障碍状态、SEO、隐私 canary 与端到端验收。",
    ],
  },
  {
    version: "0.8.0",
    date: "2026-07-20",
    theme: "离线数据工作台",
    title: "可安装、可离线，并把数据转换讲清楚",
    summary:
      "新增两个严格的数据工具、离线应用能力和知识中心，同时补强图片内存、CSP 与发布流水线。",
    changes: [
      "上线 CSV / JSON 双向转换，兼容 BOM、CRLF、引号换行与多种分隔符，并默认保留字符串语义；",
      "上线 URL 查询参数解析与构建，保留顺序、重复键、空值和无等号项；",
      "加入可安装 PWA、版本化静态预缓存、离线回退和用户确认式更新，不缓存输入、文件或运行期请求；",
      "发布八篇数据、编码、安全与隐私指南，并与工具页、首页、导航和结构化数据互联；",
      "图片压缩新增设备分级像素、结果与 ZIP 内存保护，移动端默认限制最长边；",
      "修正 meta CSP 生效顺序，并让浏览器测试和 Pages 部署复用同一份已验证构建产物；",
      "工具总数扩展至十二个，同步完善移动端、无障碍、SEO、站点地图与多浏览器验收。",
    ],
  },
  {
    version: "0.7.0",
    date: "2026-07-20",
    theme: "常用开发工具扩展",
    title: "文本对比、哈希、格式转换与 JWT 检查",
    summary:
      "新增四个浏览器本地工具，把内容比较、完整性校验、配置转换和令牌调试纳入统一体验。",
    changes: [
      "上线文本差异对比，提供并排与统一视图、比较规则和结果导出；",
      "上线 SHA-256 / SHA-512 文本与文件哈希，并支持预期摘要核对；",
      "上线 YAML 1.2 与 JSON 双向转换，严格提示语法、重复键和不兼容数据；",
      "上线 JWT Header、Payload 与时间声明解码，并持续强调解码不等于验签；",
      "工具总数扩展至十个，同步完善任务入口、场景说明、移动端、可访问性、SEO 与隐私回归。",
    ],
  },
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

/** 当前发布版本，供结构化数据与版本说明复用。 */
export const currentRelease: ReleaseEntry = releases[0];

/** 首页默认展示的三个最近版本。 */
export const recentReleases: readonly ReleaseEntry[] = releases.slice(0, 3);

export function isExperienceToolSlug(slug: string): slug is ExperienceToolSlug {
  return (experienceToolSlugs as readonly string[]).includes(slug);
}

export function getToolUseCases(slug: string): readonly TaskRecipe[] {
  return isExperienceToolSlug(slug) ? toolUseCases[slug] : [];
}
