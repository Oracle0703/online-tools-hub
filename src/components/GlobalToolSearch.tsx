import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getGlobalSearchGroups,
  type GlobalSearchGuide,
  type GlobalSearchResult,
  type GlobalSearchTask,
} from "../lib/global-search";
import {
  createEmptyToolMemory,
  readToolMemory,
  subscribeToolMemory,
  type ToolMemoryState,
} from "../lib/tool-memory";
import type { CategoryDefinition, ToolSummary } from "../lib/tool-registry";

type Props = {
  tools: readonly ToolSummary[];
  categories: readonly CategoryDefinition[];
  guides: readonly GlobalSearchGuide[];
  tasks: readonly GlobalSearchTask[];
  baseUrl: string;
};

function optionId(result: GlobalSearchResult): string {
  return `global-search-option-${result.id.replace(/[^a-z0-9-]+/giu, "-")}`;
}

export default function GlobalToolSearch({
  tools,
  categories,
  guides,
  tasks,
  baseUrl,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [memory, setMemory] = useState<ToolMemoryState>(createEmptyToolMemory);
  const normalizedBase = baseUrl.replace(/\/+$/u, "");

  const groups = useMemo(
    () =>
      getGlobalSearchGroups({
        tools,
        categories,
        guides,
        tasks,
        memory,
        query,
      }),
    [categories, guides, memory, query, tasks, tools],
  );
  const flatResults = useMemo(
    () => groups.flatMap((group) => group.results),
    [groups],
  );
  const resolvedActiveIndex =
    flatResults.length > 0 ? Math.min(activeIndex, flatResults.length - 1) : -1;
  const activeResult =
    resolvedActiveIndex >= 0 ? flatResults[resolvedActiveIndex] : undefined;
  const resultCount = flatResults.length;

  const hrefFor = useCallback(
    (result: GlobalSearchResult) => `${normalizedBase}${result.path}`,
    [normalizedBase],
  );

  const openSearch = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    setQuery("");
    setActiveIndex(0);
    dialog.showModal();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const closeSearch = useCallback(() => dialogRef.current?.close(), []);

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      if (flatResults.length === 0) return;

      setActiveIndex((current) => {
        const normalizedCurrent = Math.min(current, flatResults.length - 1);
        const next =
          (normalizedCurrent + direction + flatResults.length) %
          flatResults.length;

        requestAnimationFrame(() => {
          document
            .getElementById(optionId(flatResults[next]!))
            ?.scrollIntoView({ block: "nearest" });
        });
        return next;
      });
    },
    [flatResults],
  );

  const handleResultKeys = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveActive(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveActive(-1);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearch();
        return;
      }
      if (event.key === "Enter" && activeResult) {
        event.preventDefault();
        window.location.assign(hrefFor(activeResult));
      }
    },
    [activeResult, closeSearch, hrefFor, moveActive],
  );

  useEffect(() => {
    const unsubscribe = subscribeToolMemory(setMemory);
    let active = true;

    queueMicrotask(() => {
      if (active) setMemory(readToolMemory());
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

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
        aria-keyshortcuts="Control+K Meta+K"
        aria-label="搜索工具、工作流、指南和常见任务"
        onClick={openSearch}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <span>搜索全站</span>
        <kbd>Ctrl/⌘ K</kbd>
      </button>

      <dialog
        ref={dialogRef}
        className="global-search-dialog"
        aria-labelledby="global-search-title"
        onClick={(event) => {
          if (event.target === event.currentTarget) closeSearch();
        }}
        onClose={() => {
          setQuery("");
          setActiveIndex(0);
        }}
      >
        <section className="global-search-panel">
          <header className="global-search-panel__head">
            <div>
              <p className="eyebrow">命令面板</p>
              <h2 id="global-search-title">搜索工具、工作流、指南与任务</h2>
            </div>
            <button
              type="button"
              className="global-search-panel__close"
              onClick={closeSearch}
              aria-label="关闭全站搜索"
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>

          <label className="global-search-field">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4 4" />
            </svg>
            <span className="sr-only">搜索工具、工作流、指南和常见任务</span>
            <input
              ref={inputRef}
              type="search"
              role="combobox"
              aria-label="搜索工具、工作流、指南和常见任务"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls="global-search-listbox"
              aria-describedby="global-search-summary"
              aria-activedescendant={
                activeResult ? optionId(activeResult) : undefined
              }
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleResultKeys}
              placeholder="试试“令牌过期”“表格转接口数据”…"
              autoComplete="off"
              spellCheck={false}
            />
            <kbd>Esc</kbd>
          </label>

          <div className="global-search-results">
            <p
              id="global-search-summary"
              className="global-search-results__summary"
              aria-live="polite"
              aria-atomic="true"
            >
              {resultCount > 0
                ? `${query ? "匹配" : "当前可用"} ${resultCount} 项内容`
                : "没有匹配的工具、工作流、指南或任务"}
            </p>
            {resultCount > 0 ? (
              <div
                id="global-search-listbox"
                className="global-search-listbox"
                role="listbox"
                aria-label="全站搜索结果"
              >
                {groups.map((group) => (
                  <section
                    key={group.id}
                    className="global-search-group"
                    role="group"
                    aria-labelledby={`global-search-group-${group.id}`}
                  >
                    <header className="global-search-group__heading">
                      <h3 id={`global-search-group-${group.id}`}>
                        {group.label}
                      </h3>
                      <span aria-hidden="true">{group.results.length}</span>
                    </header>
                    <div className="global-search-group__items">
                      {group.results.map((result) => {
                        const resultIndex = flatResults.findIndex(
                          (candidate) => candidate.id === result.id,
                        );
                        const isActive = resultIndex === resolvedActiveIndex;

                        return (
                          <a
                            key={result.id}
                            id={optionId(result)}
                            className="global-search-result"
                            href={hrefFor(result)}
                            role="option"
                            aria-selected={isActive}
                            data-active={isActive ? "true" : "false"}
                            data-kind={result.kind}
                            tabIndex={-1}
                            onMouseEnter={() => setActiveIndex(resultIndex)}
                            onClick={closeSearch}
                          >
                            <span className="tool-mark" aria-hidden="true">
                              {result.mark}
                            </span>
                            <span className="global-search-result__copy">
                              <strong>{result.title}</strong>
                              <small>{result.description}</small>
                            </span>
                            <span className="global-search-result__meta">
                              {result.meta}
                            </span>
                          </a>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <>
                <div
                  id="global-search-listbox"
                  className="global-search-listbox global-search-listbox--empty"
                  role="listbox"
                  aria-label="全站搜索结果"
                />
                <div className="global-search-empty">
                  <strong>换个说法试试</strong>
                  <p>
                    可以输入格式名称，也可以描述任务，例如“压缩截图”“令牌过期”或“核对下载文件”。
                  </p>
                </div>
              </>
            )}
          </div>

          <footer className="global-search-panel__hint" aria-hidden="true">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> 选择
            </span>
            <span>
              <kbd>Enter</kbd> 打开
            </span>
            <span>
              <kbd>Esc</kbd> 关闭
            </span>
          </footer>
        </section>
      </dialog>
    </>
  );
}
