export type ToolGuideStep = {
  title: string;
  description: string;
};

export type ToolFaq = {
  question: string;
  answer: string;
};

export type ToolPageContent = {
  guideTitle: string;
  steps: [ToolGuideStep, ToolGuideStep, ToolGuideStep];
  notice: string;
  faqs: [ToolFaq, ToolFaq, ToolFaq];
};

export const toolPageContent: Record<string, ToolPageContent> = {
  "json-formatter": {
    guideTitle: "三步整理并校验 JSON",
    steps: [
      {
        title: "粘贴 JSON",
        description: "输入对象、数组或任意合法 JSON 值。",
      },
      {
        title: "选择处理方式",
        description: "选择缩进后格式化，或压缩为单行文本。",
      },
      {
        title: "检查并取回",
        description: "查看错误位置，复制结果或下载 JSON 文件。",
      },
    ],
    notice:
      "超出 JavaScript 安全整数范围的数字会保留原始词法，不会被静默改写。",
    faqs: [
      {
        question: "格式化会改变超大整数吗？",
        answer:
          "不会。解析器不会把数字转换为 JavaScript Number，因此超大整数、指数写法和小数尾零都会保留。",
      },
      {
        question: "如何定位 JSON 语法错误？",
        answer:
          "校验失败时会显示从 1 开始计算的行号、列号、附近文本和指针，便于直接回到问题位置。",
      },
      {
        question: "输入的 JSON 会上传吗？",
        answer:
          "不会。格式化、压缩和校验都在当前浏览器标签页内完成，刷新后也不会恢复输入。",
      },
    ],
  },
  "base64-codec": {
    guideTitle: "三步完成 Base64 转换",
    steps: [
      {
        title: "选择标准",
        description: "按使用场景选择标准 Base64 或 Base64URL。",
      },
      {
        title: "输入并转换",
        description: "输入 UTF-8 文本进行编码，或粘贴 Base64 进行解码。",
      },
      {
        title: "取回结果",
        description: "交换输入输出，或复制、下载转换结果。",
      },
    ],
    notice: "Base64 是编码，不是加密。请勿用它保护密码、令牌或其他机密信息。",
    faqs: [
      {
        question: "Base64 和 Base64URL 有什么区别？",
        answer:
          "Base64URL 会把 + 和 / 替换为 - 和 _，并通常省略末尾填充，更适合 URL、Cookie 和令牌字段。",
      },
      {
        question: "可以正确处理中文和 Emoji 吗？",
        answer:
          "可以。文本会先按 UTF-8 转换为字节再编码，解码时也会严格检查 UTF-8 是否有效。",
      },
      {
        question: "Base64 能保护敏感内容吗？",
        answer:
          "不能。任何人都能轻易还原 Base64；需要保密时应使用经过审计的加密方案。",
      },
    ],
  },
  "url-codec": {
    guideTitle: "三步安全处理 URL 文本",
    steps: [
      {
        title: "选择编码范围",
        description: "组件模式处理参数值，完整 URL 模式保留网址结构。",
      },
      {
        title: "编码或解码",
        description: "输入文本后选择操作，无效百分号转义会明确报错。",
      },
      {
        title: "复制结果",
        description: "核对 +、空格和保留字符后复制或交换结果。",
      },
    ],
    notice: "本工具只转换文本，不会访问、预览或验证你输入的网址。",
    faqs: [
      {
        question: "什么时候使用组件模式？",
        answer:
          "编码查询参数值、路径片段或表单字段时使用组件模式，它会转义更多具有结构含义的字符。",
      },
      {
        question: "加号会被当作空格吗？",
        answer:
          "本工具按 URI 规则处理，普通解码不会把 + 自动改为空格，避免混淆 URL 与表单编码。",
      },
      {
        question: "工具会打开我输入的网址吗？",
        answer:
          "不会。输入只作为本地文本进行转换，页面不会发起对该网址的网络请求。",
      },
    ],
  },
  "unix-timestamp": {
    guideTitle: "三步转换 Unix 时间戳",
    steps: [
      {
        title: "输入时间",
        description: "输入秒或毫秒时间戳，也可以选择日期和时间。",
      },
      {
        title: "确认单位与时区",
        description: "使用自动识别或手动指定单位，并核对当前时区。",
      },
      {
        title: "读取结果",
        description: "同时查看本地时间、UTC、ISO 8601 和双单位时间戳。",
      },
    ],
    notice: "转换结果会同时标明本地时区和 UTC，避免时区含义不清。",
    faqs: [
      {
        question: "如何判断时间戳是秒还是毫秒？",
        answer:
          "自动模式会根据数值位数和可表示范围推断；不确定时可以手动选择秒或毫秒覆盖结果。",
      },
      {
        question: "支持 1970 年以前的日期吗？",
        answer:
          "支持。Unix 纪元以前的时间会使用负数表示，只要日期处于浏览器可表示范围内即可转换。",
      },
      {
        question: "为什么本地时间与 UTC 不同？",
        answer:
          "它们表示同一时刻，但使用不同的时区格式。页面会显示浏览器当前时区，方便核对。",
      },
    ],
  },
  "uuid-generator": {
    guideTitle: "三步生成 UUID v4",
    steps: [
      {
        title: "设置数量",
        description: "输入 1 到 1000 之间的批量生成数量。",
      },
      {
        title: "安全生成",
        description: "浏览器使用密码学安全随机源在本地创建 UUID v4。",
      },
      {
        title: "复制或下载",
        description: "复制单项或全部结果，也可以下载文本文件。",
      },
    ],
    notice: "UUID 适合生成随机标识符，但它不是密码、访问令牌或数据库权限控制。",
    faqs: [
      {
        question: "生成器使用普通随机数吗？",
        answer:
          "不会。它优先使用 crypto.randomUUID，并在兼容回退中使用 crypto.getRandomValues。",
      },
      {
        question: "一次最多可以生成多少个？",
        answer:
          "一次最多生成 1000 个。页面会在返回结果前检查格式，并阻止当前批次出现重复值。",
      },
      {
        question: "UUID v4 会包含时间或设备信息吗？",
        answer:
          "不会。v4 的主体来自安全随机字节，不编码创建时间、网络地址或设备身份。",
      },
    ],
  },
  "image-compressor": {
    guideTitle: "三步压缩或转换图片",
    steps: [
      {
        title: "添加图片",
        description: "拖放或选择 JPEG、PNG、WebP 图片，可一次加入多个文件。",
      },
      {
        title: "调整并压缩",
        description: "设置质量、最长边和输出格式，在当前浏览器中依次处理。",
      },
      {
        title: "比较并下载",
        description: "核对尺寸与节省空间，单独下载或打包取回全部结果。",
      },
    ],
    notice:
      "本工具采用浏览器编码与 PNG 色彩量化，不使用也不声称复现 TinyPNG 的专有算法；不同浏览器和图片内容可能得到不同结果。",
    faqs: [
      {
        question: "图片会上传到服务器吗？",
        answer:
          "不会。所选文件、像素数据和压缩结果完全保留在当前页面内存中，预览也使用浏览器生成的本地 Blob URL；页面不会上传或持久化这些内容。",
      },
      {
        question: "压缩后会保留 EXIF 或动画吗？",
        answer:
          "实际重编码会移除大多数 EXIF、拍摄位置等元数据；若工具明确保留了更小的原文件，其原有元数据仍会存在。APNG、动画 WebP 等动画图片不受支持，会在处理前被拒绝。",
      },
      {
        question: "为什么压缩率与其他网站不同？",
        answer:
          "结果取决于图片内容、质量与尺寸设置，以及当前浏览器使用的编码器。某些图片已经很小，重新编码后未必继续变小，因此页面会如实显示结果而不承诺固定压缩率。",
      },
    ],
  },
  "qr-code": {
    guideTitle: "三步本地生成或识别二维码",
    steps: [
      {
        title: "选择生成或识别",
        description:
          "生成模式接收 Unicode 文本；识别模式只接受 JPEG、PNG 或 WebP 图片。",
      },
      {
        title: "主动开始处理",
        description:
          "设置纠错级别与尺寸，或核对图片信息后，再明确点击生成或识别。",
      },
      {
        title: "安全取回结果",
        description: "下载固定几何 SVG，或把识别内容作为纯文本检查和复制。",
      },
    ],
    notice:
      "识别结果不会被验证或自动打开；即使内容看起来像网址，也请先按不可信文本检查。",
    faqs: [
      {
        question: "识别出的链接会自动打开吗？",
        answer:
          "不会。识别结果始终显示为纯文本，页面不会导航、预取或请求其中的网址；只有你主动复制后才能在别处使用。",
      },
      {
        question: "纠错级别应该怎么选择？",
        answer:
          "M 级适合多数场景；Q 或 H 能容忍更多污损，但二维码会更密。内容较长或展示空间较小时，可以选择 L 或 M。",
      },
      {
        question: "图片和二维码内容会上传吗？",
        answer:
          "不会。文件头校验、图片解码与缩放在当前浏览器临时内存中完成，二维码生成和识别算法在一次性 Worker 中执行；清空或离开页面后不会恢复。",
      },
    ],
  },
  "text-diff": {
    guideTitle: "三步看清两版文本的变化",
    steps: [
      {
        title: "放入两个版本",
        description: "把原始文本和修改后文本分别粘贴到左右输入区。",
      },
      {
        title: "选择比较规则",
        description: "按需要忽略大小写或空白，再执行逐行比较。",
      },
      {
        title: "审阅并导出",
        description: "在并排与统一视图间切换，复制或下载差异结果。",
      },
    ],
    notice:
      "比较只发生在当前浏览器中。忽略空白或大小写会影响匹配判断，但不会改写你输入的原文。",
    faqs: [
      {
        question: "文本差异按字符还是按行比较？",
        answer:
          "本工具以行为基本单位，适合配置、日志、代码片段和文档草稿。相邻的删除与新增行会在并排视图中组合为修改。",
      },
      {
        question: "为什么较大的文本可能无法比较？",
        answer:
          "差异计算需要保留中间路径。页面会限制单侧字节数、行数与比较复杂度，避免极端输入长时间占用浏览器。",
      },
      {
        question: "输入内容会被保存或上传吗？",
        answer:
          "不会。两个版本和差异结果只存在于当前页面内存，站点不会上传或持久化这些文本。",
      },
    ],
  },
  "regex-tester": {
    guideTitle: "三步安全测试 JavaScript 正则",
    steps: [
      {
        title: "填写 pattern 与 flags",
        description:
          "输入 JavaScript RegExp pattern，并明确选择全局、Unicode、粘滞等标志。",
      },
      {
        title: "主动运行测试",
        description:
          "放入测试文本后手动运行；计算只在一次性 Worker 中进行，最长 2 秒。",
      },
      {
        title: "核对匹配与捕获",
        description: "查看 UTF-16 索引、捕获组和命名捕获组，再复制结构化结果。",
      },
    ],
    notice:
      "2 秒硬超时只保护当前页面不被灾难性回溯锁死，并不能证明该表达式在生产环境对任意输入都安全。",
    faqs: [
      {
        question: "如何阻止 ReDoS 卡住页面？",
        answer:
          "每次测试都会创建独立 Worker。运行超过 2 秒、用户取消或页面离开时，主线程会直接 terminate Worker，不会回退到主线程继续执行。",
      },
      {
        question: "为什么索引按 UTF-16 位置显示？",
        answer:
          "JavaScript RegExp 的 match.index 与 lastIndex 使用 UTF-16 code unit。页面按原生索引显示，同时对零宽匹配按完整 Unicode code point 推进，避免 Emoji 被拆开后无限循环。",
      },
      {
        question: "pattern 和测试文本会被保存吗？",
        answer:
          "不会。pattern、flags、测试文本、匹配项和捕获组都只存在于当前标签页内存；配方、网址、浏览器存储和网络请求不会携带这些内容。",
      },
    ],
  },
  "hash-generator": {
    guideTitle: "三步生成并核对 SHA 摘要",
    steps: [
      {
        title: "选择算法与输入",
        description: "选择 SHA-256 或 SHA-512，再输入文本或选择本地文件。",
      },
      {
        title: "在本地计算",
        description: "浏览器使用 Web Crypto 读取字节并生成十六进制摘要。",
      },
      {
        title: "复制或核对",
        description: "复制、下载结果，或粘贴预期哈希检查是否完全一致。",
      },
    ],
    notice:
      "哈希摘要用于完整性核对，不是加密，也不能把低强度密码安全地变成可存储凭据。",
    faqs: [
      {
        question: "SHA-256 和 SHA-512 应该选哪个？",
        answer:
          "应与摘要发布方或目标系统指定的算法保持一致。两者输出长度不同，不能直接互相比较。",
      },
      {
        question: "文件会上传到服务器吗？",
        answer:
          "不会。文件大小会先在本地检查，随后由当前浏览器读取并通过 Web Crypto 一次性计算摘要。",
      },
      {
        question: "可以用 SHA 哈希保存密码吗？",
        answer:
          "不建议。密码需要带盐且专门设计为缓慢的算法，例如 Argon2id、scrypt 或 bcrypt；普通 SHA 摘要不具备这种防护。",
      },
    ],
  },
  "yaml-json-converter": {
    guideTitle: "三步在 YAML 与 JSON 间转换",
    steps: [
      {
        title: "确认转换方向",
        description: "选择 YAML 转 JSON 或 JSON 转 YAML，并粘贴源内容。",
      },
      {
        title: "转换并检查",
        description: "执行严格解析，根据行列提示修正语法或不兼容值。",
      },
      {
        title: "取回结果",
        description: "核对类型和层级后复制、下载，或交换方向继续编辑。",
      },
    ],
    notice:
      "转换面向 JSON 兼容的数据模型；注释、锚点写法和某些 YAML 专有类型无法原样往返保留。",
    faqs: [
      {
        question: "YAML 注释会保留到 JSON 吗？",
        answer:
          "不会。JSON 没有注释语法，转换只保留可表达的数据值和结构，因此不要用往返转换编辑必须保留注释的配置文件。",
      },
      {
        question: "为什么只支持一个 YAML 文档？",
        answer:
          "单个 JSON 值没有直接对应的多文档表示。为避免隐式包裹或丢失内容，页面会明确拒绝第二个 YAML 文档。",
      },
      {
        question: "转换会把内容上传吗？",
        answer:
          "不会。YAML 与 JSON 的解析、校验和生成都在当前浏览器标签页内完成。",
      },
    ],
  },
  "jwt-decoder": {
    guideTitle: "三步查看 JWT 的公开声明",
    steps: [
      {
        title: "粘贴完整令牌",
        description: "输入由三个点号分隔的 JWT compact 字符串。",
      },
      {
        title: "本地解码",
        description:
          "严格解析 Header、Payload，并检查 exp、nbf 与 iat 时间声明。",
      },
      {
        title: "判断下一步",
        description: "复制解码结果用于调试，再由可信服务端完成签名与业务校验。",
      },
    ],
    notice:
      "解码不等于验证。页面不校验签名、签发者、受众或权限，不应据此信任令牌或授予访问权。",
    faqs: [
      {
        question: "能解码是否就说明 JWT 有效？",
        answer:
          "不能。Header 和 Payload 本来就是可读的 Base64URL 数据；只有持有可信密钥并验证签名及声明约束后，系统才能判断令牌是否可信。",
      },
      {
        question: "页面会验证 exp 和 nbf 吗？",
        answer:
          "页面会把数值日期转成可读时间，并根据当前浏览器时间提示已过期或尚未生效，但这只是调试信息，不替代服务端校验。",
      },
      {
        question: "可以粘贴生产环境的访问令牌吗？",
        answer:
          "页面不会上传或保存输入，但访问令牌仍属于敏感凭据。优先使用脱敏样例；若令牌已意外泄露，应立即撤销或轮换。",
      },
    ],
  },
  "csv-json-converter": {
    guideTitle: "三步完成 CSV 与 JSON 转换",
    steps: [
      {
        title: "选择方向与分隔符",
        description:
          "选择 CSV 转 JSON 或 JSON 转 CSV，并使用自动识别、逗号、分号或 Tab。",
      },
      {
        title: "严格转换并检查",
        description:
          "解析引号与换行，遇到重复表头、列数不一致或不安全数字时明确提示。",
      },
      {
        title: "取回结构化结果",
        description: "核对字段后复制、下载，或交换方向继续编辑。",
      },
    ],
    notice:
      "CSV 单元格默认保留为字符串，避免前导零、长编号和日期被静默改写；JSON 中无法用 Number 精确保留的数字需要先改为字符串。",
    faqs: [
      {
        question: "为什么 CSV 中的 00123 不会自动变成数字？",
        answer:
          "CSV 没有统一类型系统。邮编、账号和 SKU 常包含前导零，默认保留字符串可以避免不可逆的数据损失。",
      },
      {
        question: "支持字段里的逗号、双引号和换行吗？",
        answer:
          "支持。解析器遵循带引号字段规则，也兼容 UTF-8 BOM 与 CRLF；未闭合引号或列数不一致会指出具体位置。",
      },
      {
        question: "表格内容会被上传或保存吗？",
        answer:
          "不会。输入、转换和下载文件都只在当前标签页中生成，刷新后不会恢复内容。",
      },
    ],
  },
  "query-params": {
    guideTitle: "三步解析并重建查询参数",
    steps: [
      {
        title: "粘贴地址或查询串",
        description: "可输入完整 URL、以问号开头的查询串，或不带问号的裸参数。",
      },
      {
        title: "检查并编辑参数",
        description:
          "保留顺序、重复键、空键值和无等号项，再按需要添加、删除或排序。",
      },
      {
        title: "重建并导出",
        description: "选择百分号或表单编码规则，复制重建结果、查询串或 JSON。",
      },
    ],
    notice:
      "网址可能进入浏览器历史、服务器日志和截图。不要把密码、访问令牌或其他机密内容放进查询参数。",
    faqs: [
      {
        question: "重复出现的同名参数会被覆盖吗？",
        answer:
          "不会。参数按有序列表保存，每个重复键都可以独立编辑，并在重建时保持其位置。",
      },
      {
        question: "flag 和 flag= 有区别吗？",
        answer:
          "可能有。前者没有等号，后者明确包含空值；工具会保留这项差异，不会自动统一。",
      },
      {
        question: "+ 号为什么有时会变成空格？",
        answer:
          "HTML 表单编码通常用 + 表示空格，而一般百分号编码可把 + 当作普通字符。页面会让你明确选择规则。",
      },
    ],
  },
};

export function getToolPageContent(slug: string): ToolPageContent {
  const content = toolPageContent[slug];

  if (!content) {
    throw new Error(`Missing page content for tool: ${slug}`);
  }

  return content;
}
