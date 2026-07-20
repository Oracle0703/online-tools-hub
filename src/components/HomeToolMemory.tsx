import { useEffect, useId, useMemo, useState } from "react";
import type { ToolSummary } from "../lib/tool-registry";
import {
  clearRecentTools,
  createEmptyToolMemory,
  readToolMemory,
  setToolFavorite,
  subscribeToolMemory,
  type ToolMemoryEntry,
  type ToolMemoryState,
} from "../lib/tool-memory";
import "./HomeToolMemory.css";

export type HomeToolMemoryProps = {
  tools: ToolSummary[];
  baseUrl: string;
  maxFavorites?: number;
  maxRecent?: number;
};

type RememberedTool = {
  memory: ToolMemoryEntry;
  tool: ToolSummary;
};

function toolPath(baseUrl: string, slug: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return `${normalizedBase}/tools/${slug}/`;
}

function rememberedTools(
  entries: ToolMemoryEntry[],
  toolsBySlug: Map<string, ToolSummary>,
  limit: number,
): RememberedTool[] {
  return entries
    .flatMap((memory) => {
      const tool = toolsBySlug.get(memory.slug);
      return tool ? [{ memory, tool }] : [];
    })
    .slice(0, Math.max(0, limit));
}

export default function HomeToolMemory({
  tools,
  baseUrl,
  maxFavorites = 6,
  maxRecent = 4,
}: HomeToolMemoryProps) {
  const headingId = useId();
  const favoritesHeadingId = useId();
  const recentHeadingId = useId();
  const [memory, setMemory] = useState<ToolMemoryState>(createEmptyToolMemory);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const unsubscribe = subscribeToolMemory(setMemory);
    const frame = window.requestAnimationFrame(() => {
      setMemory(readToolMemory());
    });

    return () => {
      window.cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, []);

  const toolsBySlug = useMemo(
    () => new Map(tools.map((tool) => [tool.slug, tool])),
    [tools],
  );
  const favoriteTools = rememberedTools(
    memory.favorites,
    toolsBySlug,
    maxFavorites,
  );
  const recentTools = rememberedTools(memory.recent, toolsBySlug, maxRecent);
  const isEmpty = favoriteTools.length === 0 && recentTools.length === 0;

  const removeFavorite = (tool: ToolSummary) => {
    setMemory(setToolFavorite(tool.slug, false));
    setAnnouncement(`已取消收藏${tool.shortTitle}`);
  };

  const clearRecent = () => {
    setMemory(clearRecentTools());
    setAnnouncement("已清除最近使用记录");
  };

  return (
    <section className="home-tool-memory" aria-labelledby={headingId}>
      <div className="home-tool-memory__heading">
        <div>
          <p className="eyebrow">留在此浏览器</p>
          <h2 id={headingId}>你的快捷工具</h2>
        </div>
        {!isEmpty ? <p>只保存工具标识和时间，不保存输入或处理结果。</p> : null}
      </div>

      {isEmpty ? (
        <div className="home-tool-memory__empty">
          <span aria-hidden="true">☆</span>
          <p>
            收藏或打开工具后，快捷入口会出现在这里。记录仅保存在此浏览器，
            不包含你的输入和处理结果。
          </p>
        </div>
      ) : (
        <div className="home-tool-memory__groups">
          {favoriteTools.length > 0 ? (
            <section
              className="home-tool-memory__group"
              aria-labelledby={favoritesHeadingId}
            >
              <div className="home-tool-memory__group-heading">
                <h3 id={favoritesHeadingId}>已收藏</h3>
                <span>{favoriteTools.length}</span>
              </div>
              <ul className="home-tool-memory__list">
                {favoriteTools.map(({ tool }) => (
                  <li key={tool.slug} className="home-tool-memory__item">
                    <a href={toolPath(baseUrl, tool.slug)}>
                      <span
                        className="home-tool-memory__mark"
                        aria-hidden="true"
                      >
                        {tool.mark}
                      </span>
                      <span className="home-tool-memory__copy">
                        <strong>{tool.shortTitle}</strong>
                        <small>打开工具</small>
                      </span>
                    </a>
                    <button
                      type="button"
                      onClick={() => removeFavorite(tool)}
                      aria-label={`取消收藏${tool.shortTitle}`}
                      title={`取消收藏${tool.shortTitle}`}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {recentTools.length > 0 ? (
            <section
              className="home-tool-memory__group"
              aria-labelledby={recentHeadingId}
            >
              <div className="home-tool-memory__group-heading">
                <h3 id={recentHeadingId}>最近使用</h3>
                <button type="button" onClick={clearRecent}>
                  清除记录
                </button>
              </div>
              <ul className="home-tool-memory__list">
                {recentTools.map(({ tool }) => (
                  <li key={tool.slug} className="home-tool-memory__item">
                    <a href={toolPath(baseUrl, tool.slug)}>
                      <span
                        className="home-tool-memory__mark"
                        aria-hidden="true"
                      >
                        {tool.mark}
                      </span>
                      <span className="home-tool-memory__copy">
                        <strong>{tool.shortTitle}</strong>
                        <small>再次打开</small>
                      </span>
                      <span
                        className="home-tool-memory__arrow"
                        aria-hidden="true"
                      >
                        →
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}
