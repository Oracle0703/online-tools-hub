import type { TaskRecipe } from "./experience-content";
import type { GuideDefinition } from "./guide-content";
import type { CategoryDefinition, ToolSummary } from "./tool-registry";
import type { ToolMemoryState } from "./tool-memory";
import type { WorkflowContentDefinition } from "./workflow-content";

export type GlobalSearchGuide = Pick<
  GuideDefinition,
  | "slug"
  | "title"
  | "summary"
  | "eyebrow"
  | "mark"
  | "readingMinutes"
  | "keywords"
  | "relatedToolSlugs"
>;

export type GlobalSearchTask = Pick<
  TaskRecipe,
  "id" | "title" | "problem" | "outcome" | "tip" | "toolSlug" | "relatedSlug"
> &
  Readonly<{
    path?: string;
    mark?: string;
    meta?: string;
    aliases?: readonly string[];
    keywords?: readonly string[];
    singleTokenScoreAdjustments?: Readonly<Record<string, number>>;
  }>;

export type GlobalSearchGroupId = "shortcut" | "tool" | "guide" | "task";
export type GlobalSearchResultKind = "tool" | "guide" | "task";

export type GlobalSearchResult = {
  id: string;
  kind: GlobalSearchResultKind;
  title: string;
  description: string;
  mark: string;
  meta: string;
  path: string;
  toolSlugs: readonly string[];
};

export type GlobalSearchGroup = {
  id: GlobalSearchGroupId;
  label: string;
  results: GlobalSearchResult[];
};

export type GlobalSearchInput = {
  tools: readonly ToolSummary[];
  categories: readonly CategoryDefinition[];
  guides: readonly GlobalSearchGuide[];
  tasks: readonly GlobalSearchTask[];
  memory: ToolMemoryState;
  query: string;
};

type SearchCandidate = GlobalSearchResult & {
  aliases: readonly string[];
  keywords: readonly string[];
  singleTokenScoreAdjustments?: Readonly<Record<string, number>>;
};

type ScoredCandidate = {
  candidate: SearchCandidate;
  score: number;
  sourceIndex: number;
};

const GROUP_LABELS: Record<GlobalSearchGroupId, string> = {
  shortcut: "收藏 / 最近",
  tool: "工具",
  guide: "指南",
  task: "工作流 / 常见任务",
};

/**
 * 中文任务表达与工具名之间的补充映射。注册表关键词仍是主要数据源；
 * 这里只保留用户可能会直接输入、但通常不会出现在产品名称里的说法。
 */
export const TOOL_SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> =
  {
    "json-formatter": [
      "美化 JSON",
      "整理接口返回",
      "格式化接口响应",
      "检查 JSON 报错",
      "一行 JSON 换行",
    ],
    "base64-codec": [
      "字符串转 Base64",
      "Base64 转中文",
      "还原编码文本",
      "Data URL 编码",
    ],
    "url-codec": ["网址编码", "链接解码", "中文转百分号", "参数值转义"],
    "unix-timestamp": [
      "时间戳转日期",
      "日期转时间戳",
      "秒和毫秒",
      "对齐日志时间",
    ],
    "uuid-generator": ["批量生成 ID", "随机标识符", "测试数据 ID", "生成 GUID"],
    "image-compressor": ["缩小照片", "压缩截图", "图片体积太大", "图片转 WebP"],
    "text-diff": ["比较两段文字", "代码改了什么", "配置差异", "版本内容对比"],
    "hash-generator": [
      "核对下载文件",
      "文件是否完整",
      "计算校验和",
      "摘要比对",
    ],
    "yaml-json-converter": [
      "配置转 JSON",
      "JSON 转 YAML",
      "YML 转换",
      "Kubernetes 配置",
    ],
    "jwt-decoder": ["令牌过期", "查看 Token", "检查登录令牌", "JWT 验签区别"],
    "csv-json-converter": [
      "表格转接口数据",
      "Excel 导出转 JSON",
      "JSON 导出表格",
      "保留前导零",
    ],
    "query-params": [
      "拆解链接参数",
      "编辑 Query String",
      "重复 URL 参数",
      "重建查询字符串",
    ],
  };

export function toGlobalSearchGuide(guide: GuideDefinition): GlobalSearchGuide {
  return {
    slug: guide.slug,
    title: guide.title,
    summary: guide.summary,
    eyebrow: guide.eyebrow,
    mark: guide.mark,
    readingMinutes: guide.readingMinutes,
    keywords: guide.keywords,
    relatedToolSlugs: guide.relatedToolSlugs,
  };
}

export function toGlobalSearchTask(task: TaskRecipe): GlobalSearchTask {
  return {
    id: task.id,
    title: task.title,
    problem: task.problem,
    outcome: task.outcome,
    tip: task.tip,
    toolSlug: task.toolSlug,
    relatedSlug: task.relatedSlug,
  };
}

export function toGlobalSearchWorkflow(
  workflow: WorkflowContentDefinition,
): GlobalSearchTask {
  const toolSlug = workflow.relatedToolSlugs.at(-1);
  const relatedSlug = workflow.relatedToolSlugs.find(
    (candidate) => candidate !== toolSlug,
  );
  if (toolSlug === undefined) {
    throw new Error(`Workflow '${workflow.id}' needs a related tool.`);
  }

  return {
    id: `workflow-${workflow.id}`,
    title: workflow.title,
    problem: workflow.summary,
    outcome: `${workflow.inputLabel} → ${workflow.outputLabel}`,
    tip: "全程浏览器本地处理，配方不包含正文。",
    toolSlug,
    ...(relatedSlug === undefined ? {} : { relatedSlug }),
    path: `/workflows/${workflow.slug}/`,
    mark: workflow.mark,
    meta: `${workflow.steps.length} 步本地工作流`,
    aliases: [workflow.eyebrow, workflow.inputLabel, workflow.outputLabel],
    keywords: workflow.keywords,
    // "URL" is also a substring of Base64URL. Keep that broad query focused on
    // a user's favorite URL tools/tasks without hiding JWT or "工作流" queries.
    singleTokenScoreAdjustments: { url: -160 },
  };
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function compact(value: string): string {
  return normalizeSearchText(value).replace(/\s+/gu, "");
}

function candidateScore(candidate: SearchCandidate, query: string): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const queryTokens = normalizedQuery.split(/\s+/u).filter(Boolean);
  const compactQuery = queryTokens.join("");
  const normalizedTitle = normalizeSearchText(candidate.title);
  const compactTitle = compact(candidate.title);
  const normalizedAliases = candidate.aliases.map(normalizeSearchText);
  const normalizedKeywords = candidate.keywords.map(normalizeSearchText);
  const normalizedDescription = normalizeSearchText(candidate.description);
  const searchableFields = [
    normalizedTitle,
    ...normalizedAliases,
    ...normalizedKeywords,
    normalizedDescription,
    normalizeSearchText(candidate.meta),
  ];
  const compactFields = searchableFields.map((field) =>
    field.replace(/\s+/gu, ""),
  );

  if (
    queryTokens.some(
      (token) => !compactFields.some((field) => field.includes(compact(token))),
    )
  ) {
    return -1;
  }

  let score = 0;
  if (compactTitle === compactQuery) score += 180;
  else if (compactTitle.startsWith(compactQuery)) score += 130;
  else if (compactTitle.includes(compactQuery)) score += 100;

  if (
    normalizedAliases.some(
      (alias) => alias.replace(/\s+/gu, "") === compactQuery,
    )
  ) {
    score += 110;
  } else if (
    normalizedAliases.some((alias) =>
      alias.replace(/\s+/gu, "").includes(compactQuery),
    )
  ) {
    score += 75;
  }

  if (
    normalizedKeywords.some(
      (keyword) => keyword.replace(/\s+/gu, "") === compactQuery,
    )
  ) {
    score += 80;
  } else if (
    normalizedKeywords.some((keyword) =>
      keyword.replace(/\s+/gu, "").includes(compactQuery),
    )
  ) {
    score += 55;
  }

  if (compact(normalizedDescription).includes(compactQuery)) score += 35;

  for (const token of queryTokens) {
    const compactToken = compact(token);
    if (compactTitle.includes(compactToken)) score += 18;
    else if (
      normalizedAliases.some((alias) => compact(alias).includes(compactToken))
    ) {
      score += 13;
    } else if (
      normalizedKeywords.some((keyword) =>
        compact(keyword).includes(compactToken),
      )
    ) {
      score += 10;
    } else {
      score += 4;
    }
  }

  return score;
}

function memoryAffinity(
  candidate: SearchCandidate,
  memory: ToolMemoryState,
): number {
  let affinity = 0;

  for (const slug of candidate.toolSlugs) {
    const favoriteIndex = memory.favorites.findIndex(
      (entry) => entry.slug === slug,
    );
    const recentIndex = memory.recent.findIndex((entry) => entry.slug === slug);

    if (favoriteIndex >= 0) affinity = Math.max(affinity, 40 - favoriteIndex);
    if (recentIndex >= 0) affinity = Math.max(affinity, 20 - recentIndex);
  }

  return affinity;
}

function scoreAndSort(
  candidates: readonly SearchCandidate[],
  query: string,
  memory: ToolMemoryState,
): SearchCandidate[] {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokenCount = normalizedQuery.split(/\s+/u).filter(Boolean).length;
  return candidates
    .map((candidate, sourceIndex): ScoredCandidate => {
      const matchScore = candidateScore(candidate, query);
      return {
        candidate,
        sourceIndex,
        score:
          matchScore < 0
            ? matchScore
            : matchScore +
              memoryAffinity(candidate, memory) +
              (queryTokenCount === 1
                ? (candidate.singleTokenScoreAdjustments?.[normalizedQuery] ??
                  0)
                : 0),
      };
    })
    .filter(({ score }) => score >= 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.sourceIndex - right.sourceIndex,
    )
    .map(({ candidate }) => candidate);
}

function publicResult(candidate: SearchCandidate): GlobalSearchResult {
  return {
    id: candidate.id,
    kind: candidate.kind,
    title: candidate.title,
    description: candidate.description,
    mark: candidate.mark,
    meta: candidate.meta,
    path: candidate.path,
    toolSlugs: candidate.toolSlugs,
  };
}

function createToolCandidates(
  tools: readonly ToolSummary[],
  categories: readonly CategoryDefinition[],
): SearchCandidate[] {
  const categoryNames = new Map(
    categories.map((category) => [category.slug, category.title]),
  );

  return tools.map((tool) => ({
    id: `tool:${tool.slug}`,
    kind: "tool",
    title: tool.shortTitle,
    description: tool.description,
    mark: tool.mark,
    meta: categoryNames.get(tool.category) ?? "工具",
    path: `/tools/${tool.slug}/`,
    toolSlugs: [tool.slug],
    aliases: [tool.title, ...(TOOL_SEARCH_ALIASES[tool.slug] ?? [])],
    keywords: tool.keywords,
  }));
}

function createGuideCandidates(
  guides: readonly GlobalSearchGuide[],
): SearchCandidate[] {
  return guides.map((guide) => ({
    id: `guide:${guide.slug}`,
    kind: "guide",
    title: guide.title,
    description: guide.summary,
    mark: guide.mark,
    meta: `${guide.eyebrow} · ${guide.readingMinutes} 分钟`,
    path: `/guides/${guide.slug}/`,
    toolSlugs: guide.relatedToolSlugs,
    aliases: [guide.eyebrow],
    keywords: guide.keywords,
  }));
}

function createTaskCandidates(
  tasks: readonly GlobalSearchTask[],
  toolsBySlug: ReadonlyMap<string, ToolSummary>,
): SearchCandidate[] {
  return tasks.flatMap((task) => {
    const tool = toolsBySlug.get(task.toolSlug);
    if (!tool) return [];

    return [
      {
        id: `task:${task.id}`,
        kind: "task" as const,
        title: task.title,
        description: task.problem,
        mark: task.mark ?? tool.mark,
        meta: task.meta ?? `打开${tool.shortTitle}`,
        path: task.path ?? `/tools/${tool.slug}/`,
        toolSlugs: [
          task.toolSlug,
          ...(task.relatedSlug ? [task.relatedSlug] : []),
        ],
        aliases: [
          task.outcome,
          task.tip,
          tool.title,
          tool.shortTitle,
          ...(task.aliases ?? []),
          ...(TOOL_SEARCH_ALIASES[tool.slug] ?? []),
        ],
        keywords: [...tool.keywords, ...(task.keywords ?? [])],
        singleTokenScoreAdjustments: task.singleTokenScoreAdjustments,
      },
    ];
  });
}

function createShortcutResults(
  matchingTools: readonly SearchCandidate[],
  memory: ToolMemoryState,
): GlobalSearchResult[] {
  const matchingBySlug = new Map(
    matchingTools.map((tool) => [tool.toolSlugs[0], tool]),
  );
  const favoriteSlugs = new Set(memory.favorites.map((entry) => entry.slug));
  const recentSlugs = new Set(memory.recent.map((entry) => entry.slug));
  const orderedSlugs = [
    ...memory.favorites.map((entry) => entry.slug),
    ...memory.recent.map((entry) => entry.slug),
  ];
  const seen = new Set<string>();

  return orderedSlugs.flatMap((slug) => {
    if (seen.has(slug)) return [];
    seen.add(slug);

    const candidate = matchingBySlug.get(slug);
    if (!candidate) return [];

    const isFavorite = favoriteSlugs.has(slug);
    const isRecent = recentSlugs.has(slug);
    const meta =
      isFavorite && isRecent
        ? "已收藏 · 最近使用"
        : isFavorite
          ? "已收藏"
          : "最近使用";

    return [{ ...publicResult(candidate), id: `shortcut:${slug}`, meta }];
  });
}

export function getGlobalSearchGroups({
  tools,
  categories,
  guides,
  tasks,
  memory,
  query,
}: GlobalSearchInput): GlobalSearchGroup[] {
  const toolsBySlug = new Map(tools.map((tool) => [tool.slug, tool]));
  const toolCandidates = createToolCandidates(tools, categories);
  const matchingTools = scoreAndSort(toolCandidates, query, memory);
  const shortcutResults = createShortcutResults(matchingTools, memory);
  const shortcutSlugs = new Set(
    shortcutResults.flatMap((result) => result.toolSlugs),
  );
  const remainingTools = matchingTools
    .filter((candidate) => !shortcutSlugs.has(candidate.toolSlugs[0] ?? ""))
    .map(publicResult);
  const guideResults = scoreAndSort(
    createGuideCandidates(guides),
    query,
    memory,
  ).map(publicResult);
  const taskResults = scoreAndSort(
    createTaskCandidates(tasks, toolsBySlug),
    query,
    memory,
  ).map(publicResult);

  const groups: Array<[GlobalSearchGroupId, GlobalSearchResult[]]> = [
    ["shortcut", shortcutResults],
    ["tool", remainingTools],
    ["guide", guideResults],
    ["task", taskResults],
  ];

  return groups.flatMap(([id, results]) =>
    results.length > 0 ? [{ id, label: GROUP_LABELS[id], results }] : [],
  );
}
