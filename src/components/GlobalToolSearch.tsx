import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CategoryDefinition, ToolSummary } from "../lib/tool-registry";

type Props = {
  tools: ToolSummary[];
  categories: CategoryDefinition[];
  baseUrl: string;
};

const normalize = (value: string) => value.trim().toLocaleLowerCase("zh-CN");

export default function GlobalToolSearch({
  tools,
  categories,
  baseUrl,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const normalizedBase = baseUrl.replace(/\/$/u, "");

  const categoryNames = useMemo(
    () =>
      new Map(categories.map((category) => [category.slug, category.title])),
    [categories],
  );

  const results = useMemo(() => {
    const needle = normalize(query);
    if (!needle) return tools;

    return tools.filter((tool) =>
      normalize(
        [
          tool.title,
          tool.shortTitle,
          tool.description,
          categoryNames.get(tool.category) ?? "",
          ...tool.keywords,
        ].join(" "),
      ).includes(needle),
    );
  }, [categoryNames, query, tools]);

  const openSearch = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    setQuery("");
    dialog.showModal();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const closeSearch = useCallback(() => dialogRef.current?.close(), []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [openSearch]);

  return (
    <>
      <button
        type="button"
        className="global-search-trigger"
        aria-haspopup="dialog"
        aria-label="搜索工具"
        onClick={openSearch}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <span>搜索工具</span>
        <kbd>Ctrl/⌘ K</kbd>
      </button>

      <dialog
        ref={dialogRef}
        className="global-search-dialog"
        aria-labelledby="global-search-title"
        onClick={(event) => {
          if (event.target === event.currentTarget) closeSearch();
        }}
        onClose={() => setQuery("")}
      >
        <section className="global-search-panel">
          <header className="global-search-panel__head">
            <div>
              <p className="eyebrow">快速跳转</p>
              <h2 id="global-search-title">搜索全部工具</h2>
            </div>
            <button
              type="button"
              className="global-search-panel__close"
              onClick={closeSearch}
              aria-label="关闭工具搜索"
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>

          <label className="global-search-field">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4 4" />
            </svg>
            <span className="sr-only">搜索工具</span>
            <input
              ref={inputRef}
              type="search"
              aria-label="搜索工具"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="输入 JSON、Base64、图片压缩…"
              autoComplete="off"
              spellCheck={false}
            />
            <kbd>Esc</kbd>
          </label>

          <div className="global-search-results">
            <p
              className="global-search-results__summary"
              aria-live="polite"
              aria-atomic="true"
            >
              {results.length > 0
                ? `${query ? "匹配" : "当前可用"} ${results.length} 个工具`
                : "没有匹配的工具"}
            </p>
            {results.length > 0 ? (
              <nav aria-label="工具搜索结果">
                {results.map((tool) => (
                  <a
                    key={tool.id}
                    className="global-search-result"
                    href={`${normalizedBase}/tools/${tool.slug}/`}
                  >
                    <span className="tool-mark" aria-hidden="true">
                      {tool.mark}
                    </span>
                    <span className="global-search-result__copy">
                      <strong>{tool.shortTitle}</strong>
                      <small>{tool.description}</small>
                    </span>
                    <span className="global-search-result__meta">
                      {categoryNames.get(tool.category)}
                    </span>
                  </a>
                ))}
              </nav>
            ) : (
              <div className="global-search-empty">
                <strong>换个关键词试试</strong>
                <p>可以搜索工具名、格式或“图片”“编码”“时间”等用途。</p>
              </div>
            )}
          </div>
        </section>
      </dialog>
    </>
  );
}
