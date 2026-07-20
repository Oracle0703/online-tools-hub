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
};

export function getToolPageContent(slug: string): ToolPageContent {
  const content = toolPageContent[slug];

  if (!content) {
    throw new Error(`Missing page content for tool: ${slug}`);
  }

  return content;
}
