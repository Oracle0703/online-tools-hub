export type GuideSection = {
  id: string;
  title: string;
  paragraphs: readonly string[];
  points?: readonly string[];
  callout?: string;
};

export type GuideDefinition = {
  slug: string;
  title: string;
  summary: string;
  description: string;
  eyebrow: string;
  mark: string;
  readingMinutes: number;
  published: string;
  updated: string;
  keywords: readonly string[];
  relatedToolSlugs: readonly string[];
  sections: readonly GuideSection[];
};

export const guides = [
  {
    slug: "base64-is-not-encryption",
    title: "Base64 不是加密：什么时候该用，什么时候不该用",
    summary:
      "弄清 Base64 解决的是字节传输问题，而不是机密性问题，避免把可还原内容误当作安全保护。",
    description:
      "解释 Base64 与加密的区别、常见风险，以及在接口、Data URL 和令牌中的正确使用边界。",
    eyebrow: "编码基础",
    mark: "B64",
    readingMinutes: 3,
    published: "2026-07-20",
    updated: "2026-07-20",
    keywords: ["Base64", "Base64URL", "编码", "加密", "数据安全"],
    relatedToolSlugs: ["base64-codec", "jwt-decoder"],
    sections: [
      {
        id: "what-it-does",
        title: "Base64 实际做了什么",
        paragraphs: [
          "Base64 把任意字节表示为一组便于在文本协议中传输的字符。编码前后的信息完全等价，只要拿到结果，任何人都能按公开规则还原原始字节。",
          "Base64URL 只是把容易影响 URL 结构的字符替换掉，并常常省略末尾填充。它更适合网址和令牌字段，但安全属性并没有因此改变。",
        ],
      },
      {
        id: "risk-boundary",
        title: "最常见的误区",
        paragraphs: [
          "把密码、访问令牌或个人信息编码后写进日志、网址和配置文件，并不会阻止他人读取。网址还可能进入浏览器历史、代理日志和截图。",
        ],
        points: [
          "不要把 Base64 当作密码存储方案；",
          "不要因为内容看起来不可读，就把它当作脱敏；",
          "不要把生产凭据粘贴到不可信页面或分享给他人。",
        ],
        callout:
          "判断标准很简单：如果接收方不应该看到原文，Base64 就不是答案。",
      },
      {
        id: "right-use",
        title: "适合的使用场景",
        paragraphs: [
          "Base64 适合把小段二进制内容放进只接受文本的字段、生成 Data URL、检查接口示例，或处理 JWT 的编码片段。需要保密时，应使用经过审计的加密协议；需要存储密码时，应使用专门的带盐密码哈希方案。",
          "转换时还要确认文本字符集。本站按 UTF-8 处理中文与 Emoji，并对无效输入给出错误，而不是静默替换字节。",
        ],
      },
    ],
  },
  {
    slug: "jwt-decode-vs-verify",
    title: "JWT 解码不等于验签：调试令牌时要检查什么",
    summary:
      "能读出 Header 和 Payload，只说明格式可解析；令牌是否可信，仍取决于签名、签发者、受众和时间约束。",
    description:
      "说明 JWT 解码与签名验证的差异，并给出检查 exp、nbf、iss、aud 等声明的安全清单。",
    eyebrow: "令牌安全",
    mark: "JWT",
    readingMinutes: 3,
    published: "2026-07-20",
    updated: "2026-07-20",
    keywords: ["JWT", "验签", "解码", "exp", "iss", "aud"],
    relatedToolSlugs: ["jwt-decoder", "base64-codec"],
    sections: [
      {
        id: "readable-by-design",
        title: "Payload 本来就是可读的",
        paragraphs: [
          "常见 JWT 由 Header、Payload 和 Signature 三段组成。前两段使用 Base64URL 表示，任何拿到令牌的人都能解码；因此不要在 Payload 中放密码或不应暴露的机密。",
          "本地解码适合查看字段、排查时间和格式问题，但它不会证明第三段签名有效。攻击者也可以自行构造前两段。",
        ],
      },
      {
        id: "verification-checklist",
        title: "可信系统必须完成的检查",
        paragraphs: [
          "服务端应从可信配置选择允许的算法和密钥，再验证签名。不要根据令牌自报的算法或密钥位置直接放宽验证规则。",
        ],
        points: [
          "验证签名，并限制允许的算法；",
          "核对 iss（签发者）与 aud（受众）；",
          "检查 exp、nbf，并为时钟误差设置明确容差；",
          "按业务规则检查权限、会话状态与令牌撤销。",
        ],
      },
      {
        id: "safe-debugging",
        title: "更安全的调试方式",
        paragraphs: [
          "优先使用脱敏样例。即使工具声明本地处理，生产访问令牌仍可能被屏幕共享、剪贴板历史或浏览器扩展读取。若令牌已经进入不可信位置，应按凭据泄露处理并尽快撤销或轮换。",
        ],
        callout:
          "页面给出的“已过期”或“尚未生效”只是基于本机时间的调试提示，不替代服务端验证。",
      },
    ],
  },
  {
    slug: "verify-file-sha256",
    title: "如何用 SHA-256 核对下载文件是否完整",
    summary:
      "从可信渠道取得预期摘要，在本地计算文件 SHA-256，并进行完整、逐字符的比较。",
    description:
      "一步步使用 SHA-256 校验下载文件完整性，并说明摘要来源、比较方式与哈希能力边界。",
    eyebrow: "文件完整性",
    mark: "SHA",
    readingMinutes: 3,
    published: "2026-07-20",
    updated: "2026-07-20",
    keywords: ["SHA-256", "文件校验", "checksum", "哈希", "完整性"],
    relatedToolSlugs: ["hash-generator"],
    sections: [
      {
        id: "trusted-digest",
        title: "先确认预期摘要来自哪里",
        paragraphs: [
          "哈希比较只有在预期摘要可信时才有意义。优先从软件作者的官方网站、签名发布页或独立可信渠道取得 SHA-256；不要只使用与下载文件来自同一条可疑消息的摘要。",
          "复制时保留完整的十六进制字符串。SHA-256 通常显示为 64 个十六进制字符，大小写不影响含义，但缺字、空格和其他算法的摘要都不能混用。",
        ],
      },
      {
        id: "local-check",
        title: "在本地计算并比较",
        paragraphs: [
          "选择文件后，浏览器读取字节并计算摘要。将结果与发布方提供的值完整比较；只看开头或结尾几个字符无法提供同等把握。本站的文件内容不会为了计算哈希而上传。",
        ],
        points: [
          "确认算法同为 SHA-256；",
          "确认文件名、版本和平台与发布说明一致；",
          "使用完整摘要比较，并检查工具明确显示“匹配”。",
        ],
      },
      {
        id: "limits",
        title: "匹配与不匹配分别意味着什么",
        paragraphs: [
          "摘要不匹配时，不要运行文件；它可能下载不完整、版本不同或已被修改。摘要匹配说明当前文件字节与发布方计算时一致，但单独的哈希不能证明发布方本身可信，也不能扫描恶意行为。",
        ],
        callout: "哈希用于完整性核对，不是加密，也不适合直接存储密码。",
      },
    ],
  },
  {
    slug: "csv-json-data-safety",
    title: "CSV 与 JSON 互转：如何避免列错位和数字失真",
    summary:
      "先明确分隔符、表头和字符串语义，再处理引号、换行、重复列名与超大数字。",
    description:
      "介绍 CSV 与 JSON 转换中的分隔符、引号、重复表头、列数不一致和数字精度风险。",
    eyebrow: "数据转换",
    mark: "CSV",
    readingMinutes: 3,
    published: "2026-07-20",
    updated: "2026-07-20",
    keywords: ["CSV 转 JSON", "JSON 转 CSV", "分隔符", "表头", "数字精度"],
    relatedToolSlugs: ["csv-json-converter", "json-formatter"],
    sections: [
      {
        id: "csv-is-contextual",
        title: "CSV 不只有一种写法",
        paragraphs: [
          "逗号最常见，但分号和 Tab 也经常用作分隔符。字段内部可以包含分隔符、双引号甚至换行，只要按照引号规则转义；简单地按行和逗号拆分，很容易让数据错列。",
          "自动识别只能提供安全的起点。若来源系统已经说明分隔符，应手动选择，并在转换后检查列数和关键行。",
        ],
      },
      {
        id: "headers-and-shape",
        title: "表头和列数必须明确",
        paragraphs: [
          "空表头、重复表头会让对象属性含义不清；某行多一列或少一列也不应被静默截断或补齐。可靠的转换器应该指出具体行和问题，让你先决定正确结构。",
        ],
        points: [
          "保留 UTF-8 BOM 和 CRLF 的兼容处理；",
          "拒绝重复或空白表头；",
          "对每行列数做一致性检查；",
          "导出时为包含分隔符、引号或换行的字段正确加引号。",
        ],
      },
      {
        id: "string-semantics",
        title: "默认保留字符串最稳妥",
        paragraphs: [
          "CSV 本身没有统一的数字、日期或布尔类型。把 00123 自动转成数字会丢失前导零，把长订单号转成 JavaScript Number 还可能失去精度。因此本站默认把单元格保留为字符串。",
          "JSON 转 CSV 时，如果数值已经超出安全整数边界，工具应拒绝隐式改写并要求先把它表示成字符串。转换完成后，再由了解业务含义的人决定字段类型。",
        ],
        callout:
          "邮编、电话、账号、SKU 和长 ID 看起来像数字，但通常应该继续作为字符串。下载 CSV 后，还要检查以 =、+、-、@ 开头的单元格，表格软件可能把它们当作公式。",
      },
    ],
  },
  {
    slug: "image-compression-quality-size",
    title: "图片压缩怎么选质量、尺寸和格式",
    summary:
      "先缩减不需要的像素，再根据照片、图形和透明度选择 JPEG、PNG 或 WebP。",
    description:
      "讲清图片压缩中的质量、分辨率、格式、透明度和元数据取舍，并给出可复查的工作流。",
    eyebrow: "图片优化",
    mark: "IMG",
    readingMinutes: 3,
    published: "2026-07-20",
    updated: "2026-07-20",
    keywords: ["图片压缩", "JPEG", "PNG", "WebP", "图片质量"],
    relatedToolSlugs: ["image-compressor"],
    sections: [
      {
        id: "pixels-first",
        title: "尺寸通常比质量滑块更重要",
        paragraphs: [
          "如果页面只以 1200 像素宽展示图片，保留 5000 像素原图会浪费下载体积和解码内存。先把最长边缩到实际需要，再微调质量，通常更容易得到稳定结果。",
          "保留一份原图作为源文件，不要反复对同一张有损图片压缩；每次重新编码都可能继续累积细节损失。",
        ],
      },
      {
        id: "format-choice",
        title: "按内容选择输出格式",
        paragraphs: [
          "JPEG 适合照片且兼容广泛；PNG 适合需要透明度、锐利边缘或无损保存的图形；WebP 常能兼顾照片、透明度和较小体积，但仍要按目标环境验证兼容性。",
        ],
        points: [
          "照片：先尝试 WebP 或 JPEG；",
          "Logo、界面截图：比较 PNG 与 WebP 的边缘清晰度；",
          "需要透明背景：不要输出为 JPEG；",
          "动画图片：使用明确支持动画的专门流程。",
        ],
      },
      {
        id: "review-result",
        title: "不要只看节省百分比",
        paragraphs: [
          "并排检查文字边缘、渐变、肤色和透明区域，再在真实页面尺寸下预览。重新编码后的文件偶尔会更大，可靠工具应保留更小的原文件或明确显示没有节省。",
          "浏览器本地压缩会占用内存。超大像素图片在移动设备上应限制处理尺寸和批量结果体积，避免标签页崩溃。",
        ],
        callout:
          "最合适的结果，是在目标显示尺寸下看不出有意义差异的最小文件，而不是最低质量数值。",
      },
    ],
  },
  {
    slug: "yaml-json-differences",
    title: "YAML 与 JSON 的差异：为什么互转不一定能原样往返",
    summary:
      "两者都能表示常见数据结构，但注释、锚点、类型解析和多文档语义并不对等。",
    description:
      "比较 YAML 1.2 与 JSON 的数据模型，并解释注释、锚点、重复键、数字和多文档转换边界。",
    eyebrow: "配置格式",
    mark: "YML",
    readingMinutes: 3,
    published: "2026-07-20",
    updated: "2026-07-20",
    keywords: ["YAML", "JSON", "YAML 转 JSON", "配置文件", "数据模型"],
    relatedToolSlugs: ["yaml-json-converter", "json-formatter"],
    sections: [
      {
        id: "shared-model",
        title: "共同部分与语法差异",
        paragraphs: [
          "对象、数组、字符串、数字、布尔值和 null 可以在两种格式间自然对应。JSON 语法更严格；YAML 更适合手写，但缩进、隐式类型和多种字符串写法也会增加解释空间。",
          "转换工具应使用明确版本和严格错误提示。重复键不应被静默覆盖，因为你无法确认哪个值才是作者本意。",
        ],
      },
      {
        id: "not-round-trip",
        title: "无法原样保留的内容",
        paragraphs: [
          "JSON 没有注释、锚点、别名、标签或多文档流的直接等价物。YAML 转成 JSON 后，这些写法可能被展开或丢失；再转回 YAML，得到的是等价数据，不是原文件。",
        ],
        points: [
          "必须保留注释时，不要用 JSON 往返编辑；",
          "先展开并检查锚点、合并键带来的最终值；",
          "将多文档 YAML 拆分处理，或选择明确的包裹结构；",
          "核对日期、长整数和特殊浮点值是否属于目标数据模型。",
        ],
      },
      {
        id: "safe-workflow",
        title: "转换后的检查清单",
        paragraphs: [
          "先通过严格解析消除语法和重复键问题，再比较关键路径和值类型。用于部署配置时，还应让目标程序自己读取一次结果，因为不同程序支持的 YAML 特性可能不同。",
        ],
        callout:
          "互转工具适合迁移 JSON 兼容数据，不适合无损格式化包含 YAML 专有语义的文档。",
      },
    ],
  },
  {
    slug: "url-query-parameters",
    title: "URL 查询参数详解：重复键、空值和加号意味着什么",
    summary:
      "查询字符串看似简单，但顺序、重复参数、空键值、百分号编码和表单加号都可能影响语义。",
    description:
      "解释 URL 查询参数的解析与重建规则，包括重复键、无等号参数、空值、百分号编码和 + 号。",
    eyebrow: "Web 基础",
    mark: "?=",
    readingMinutes: 3,
    published: "2026-07-20",
    updated: "2026-07-20",
    keywords: [
      "URL 参数",
      "query string",
      "百分号编码",
      "重复参数",
      "URLSearchParams",
    ],
    relatedToolSlugs: ["query-params", "url-codec"],
    sections: [
      {
        id: "ordered-list",
        title: "把查询参数看成有序列表",
        paragraphs: [
          "同一个键可以出现多次，例如 tag=css&tag=html。把参数直接转换成普通对象会丢失重复项和原始顺序，因此解析器应保留每一项。",
          "flag、flag=、=value 和单独的等号也可能具有不同语义。重建时如果统一补上等号，就无法做到准确往返。",
        ],
      },
      {
        id: "encoding-rules",
        title: "百分号编码与 + 号",
        paragraphs: [
          "查询组件中的非安全字节通常使用 %HH 表示。无效百分号序列应明确报错，避免一半解码、一半保留造成歧义。",
          "在 HTML 表单编码中，+ 常代表空格；在一般 URI 文本中，它也可能就是加号。解析前要确认上下文，工具则应明确展示所采用的规则。",
        ],
        callout:
          "对参数值做编码时使用组件规则，不要对已经包含完整结构的 URL 重复编码。",
      },
      {
        id: "editing-safely",
        title: "安全编辑和分享",
        paragraphs: [
          "排序参数有助于阅读和生成稳定缓存键，但可能改变依赖原顺序的应用行为。编辑后应比较重建结果，并在目标系统中验证。",
        ],
        points: [
          "保留重复键和空值；",
          "区分完整 URL、以 ? 开头的查询和裸查询字符串；",
          "不要把访问令牌、密码或个人信息放进 URL；",
          "分享前检查参数是否会进入历史记录、日志和分析系统。",
        ],
      },
    ],
  },
  {
    slug: "local-browser-tools-privacy",
    title: "浏览器本地工具如何保护隐私，以及它不能保护什么",
    summary:
      "本地处理可以避免把输入发送给应用服务器，但浏览器扩展、剪贴板、设备安全和第三方资源仍需单独考虑。",
    description:
      "说明浏览器本地处理、内存、离线缓存与网络边界，并提供处理敏感数据前的检查清单。",
    eyebrow: "隐私实践",
    mark: "0 B",
    readingMinutes: 3,
    published: "2026-07-20",
    updated: "2026-07-20",
    keywords: ["本地处理", "在线工具隐私", "离线工具", "浏览器安全", "PWA"],
    relatedToolSlugs: ["json-formatter", "hash-generator", "image-compressor"],
    sections: [
      {
        id: "what-local-means",
        title: "“本地处理”应当可以被验证",
        paragraphs: [
          "对本站工具而言，本地处理表示输入、文件和结果留在当前标签页内存，不写入网址、应用服务器、分析服务或持久化浏览器存储。页面刷新后，工作区内容不会自动恢复。",
          "站点可以缓存程序代码和静态页面以支持离线使用；这与缓存你的输入是两件事。可靠的离线实现只缓存公开应用外壳，不缓存用户生成的 Blob、POST 请求或工具内容。",
        ],
      },
      {
        id: "remaining-boundaries",
        title: "本地处理不是完整安全边界",
        paragraphs: [
          "操作系统、浏览器、扩展、输入法、剪贴板管理器和屏幕共享仍可能接触数据。设备已被恶意软件控制时，网页是否上传并不是唯一风险。",
        ],
        points: [
          "使用可信、及时更新的浏览器；",
          "为敏感任务停用不必要的扩展；",
          "优先使用脱敏样例和最少数据；",
          "检查开发者工具的网络面板和站点开源代码；",
          "完成后清空页面与剪贴板。",
        ],
      },
      {
        id: "offline-and-updates",
        title: "离线使用与更新",
        paragraphs: [
          "安装 PWA 后，已经缓存的公开页面和工具可在网络中断时继续打开。首次访问未缓存页面仍可能需要网络；有新版本时，应由用户明确刷新，而不是在编辑过程中突然替换页面。",
          "处理高敏感内容前，可以先加载工具、断开网络，再开始操作。不过离线并不能消除设备本身的安全风险。",
        ],
        callout:
          "隐私承诺应覆盖数据流、存储位置、缓存内容和错误日志，而不只是页面上的一句“不会上传”。",
      },
    ],
  },
] as const satisfies readonly GuideDefinition[];

export function getGuideStaticPaths() {
  return guides.map((guide) => ({
    params: { slug: guide.slug },
    props: { guide },
  }));
}

export function getGuidesForTool(toolSlug: string): readonly GuideDefinition[] {
  return guides.filter((guide) =>
    (guide.relatedToolSlugs as readonly string[]).includes(toolSlug),
  );
}
