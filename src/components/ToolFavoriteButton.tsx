import { useEffect, useState } from "react";
import {
  createEmptyToolMemory,
  isToolFavorite,
  readToolMemory,
  subscribeToolMemory,
  toggleToolFavorite,
} from "../lib/tool-memory";
import "./HomeToolMemory.css";

export type ToolFavoriteButtonProps = {
  slug: string;
  toolName: string;
  compact?: boolean;
  className?: string;
  onChange?: (favorite: boolean) => void;
};

export default function ToolFavoriteButton({
  slug,
  toolName,
  compact = false,
  className,
  onChange,
}: ToolFavoriteButtonProps) {
  const [favorite, setFavorite] = useState(() =>
    isToolFavorite(slug, createEmptyToolMemory()),
  );
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const syncFavorite = (memory: ReturnType<typeof readToolMemory>) => {
      setFavorite(isToolFavorite(slug, memory));
    };

    const unsubscribe = subscribeToolMemory(syncFavorite);
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      syncFavorite(readToolMemory());
      setReady(true);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [slug]);

  const label = favorite ? `取消收藏${toolName}` : `收藏${toolName}`;
  const classes = [
    "tool-favorite-button",
    compact ? "tool-favorite-button--compact" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const handleClick = () => {
    const memory = toggleToolFavorite(slug);
    const nextFavorite = isToolFavorite(slug, memory);
    setFavorite(nextFavorite);
    onChange?.(nextFavorite);
  };

  return (
    <button
      type="button"
      className={classes}
      aria-label={label}
      aria-pressed={favorite}
      title={label}
      data-favorite={favorite ? "true" : "false"}
      data-memory-ready={ready ? "true" : "false"}
      disabled={!ready}
      onClick={handleClick}
    >
      <span className="tool-favorite-button__icon" aria-hidden="true">
        {favorite ? "★" : "☆"}
      </span>
      {!compact ? (
        <span className="tool-favorite-button__label">
          {favorite ? "已收藏" : "收藏"}
        </span>
      ) : null}
    </button>
  );
}
