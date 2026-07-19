import { useMemo, useState, type SubmitEvent } from "react";
import type { CategoryDefinition, ToolSummary } from "../lib/tool-registry";

type Props = {
  tools: ToolSummary[];
  categories: CategoryDefinition[];
  baseUrl: string;
  compact?: boolean;
};

const normalize = (value: string) => value.trim().toLocaleLowerCase("zh-CN");

export default function ToolDirectory({
  tools,
  categories,
  baseUrl,
  compact = false,
}: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const normalizedBase = baseUrl.replace(/\/$/, "");

  const visibleTools = useMemo(() => {
    const needle = normalize(query);

    return tools.filter((tool) => {
      const categoryMatches = category === "all" || tool.category === category;
      const textMatches =
        needle.length === 0 ||
        normalize(
          [tool.title, tool.description, ...tool.keywords].join(" "),
        ).includes(needle);

      return categoryMatches && textMatches;
    });
  }, [category, query, tools]);

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
  };

  return (
    <section
      className={compact ? "directory directory--compact" : "directory"}
      aria-label="工具搜索与筛选"
    >
      <form
        className="directory__controls"
        role="search"
        onSubmit={handleSubmit}
      >
        <label className="search-field">
          <span className="sr-only">搜索工具</span>
          <span className="search-field__icon" aria-hidden="true">
            ⌕
          </span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 JSON、Base64、时间戳…"
            autoComplete="off"
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              className="search-field__clear"
              onClick={() => setQuery("")}
            >
              清除
            </button>
          ) : null}
        </label>

        {!compact ? (
          <label className="select-field">
            <span className="sr-only">按分类筛选</span>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="all">全部分类</option>
              {categories.map((item) => (
                <option key={item.id} value={item.slug}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </form>

      <p className="directory__summary" aria-live="polite">
        {visibleTools.length > 0
          ? `找到 ${visibleTools.length} 个工具`
          : "没有找到匹配的工具"}
      </p>

      {visibleTools.length > 0 ? (
        <div className="tool-grid">
          {visibleTools.map((tool) => {
            const categoryTitle = categories.find(
              (item) => item.slug === tool.category,
            )?.title;
            return (
              <article className="tool-card" key={tool.id}>
                <a
                  className="tool-card__link"
                  href={`${normalizedBase}/tools/${tool.slug}/`}
                >
                  <div className="tool-card__topline">
                    <span className="tool-mark" aria-hidden="true">
                      {tool.mark}
                    </span>
                    <span className="local-badge local-badge--compact">
                      <span className="local-badge__dot" aria-hidden="true" />
                      本地处理
                    </span>
                  </div>
                  <div>
                    <p className="eyebrow">{categoryTitle}</p>
                    <h3>{tool.shortTitle}</h3>
                    <p>{tool.description}</p>
                  </div>
                  <div className="tool-card__footer">
                    <span
                      className={`status-pill${tool.status === "available" ? " status-pill--ready" : ""}`}
                    >
                      {tool.status === "available" ? "可立即使用" : "开发中"}
                    </span>
                    <span className="text-link">
                      打开工具 <span aria-hidden="true">→</span>
                    </span>
                  </div>
                </a>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">
          <span aria-hidden="true">⌕</span>
          <h3>换个关键词试试</h3>
          <p>可以搜索工具名、用途或 “编码”“日期” 这样的关键词。</p>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => {
              setQuery("");
              setCategory("all");
            }}
          >
            查看全部工具
          </button>
        </div>
      )}
    </section>
  );
}
