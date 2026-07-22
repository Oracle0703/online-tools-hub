import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";

import {
  MAX_WORKFLOW_RECIPE_LIBRARY_ENTRIES,
  WorkflowRecipeLibraryStore,
  type WorkflowRecipeLibrarySnapshot,
} from "../../lib/workflow-recipe-library";
import type { WorkflowRecipeV1 } from "../../workflows/contract";
import {
  downloadWorkflowRecipeFile,
  readWorkflowRecipeFile,
} from "../../workflows/recipe-file";
import "./WorkflowRecipeLibraryPanel.css";

type LibraryFeedback = Readonly<{
  kind: "idle" | "success" | "warning" | "error";
  message: string;
}>;

interface WorkflowRecipeLibraryPanelProps {
  readonly recipe?: WorkflowRecipeV1;
  readonly disabled: boolean;
  readonly operationLabel: (operationId: string) => string;
  readonly onLoadRecipe: (recipe: WorkflowRecipeV1) => void;
  readonly onCopyCanonical: (canonical: string) => Promise<boolean>;
}

const updatedAtFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatUpdatedAt(value: number): string {
  try {
    return updatedAtFormatter.format(new Date(value));
  } catch {
    return "刚刚更新";
  }
}

function persistenceMessage(persisted: boolean): string {
  return persisted
    ? "配方结构已保存在此浏览器。"
    : "浏览器存储不可用；本次仅保存在当前标签页内存中。";
}

const STORAGE_WRITE_CONFLICT_MESSAGE =
  "检测到另一标签页同时更新；本次操作未生效，已刷新最新配方列表，请重试。";

function localizedRecipeName(
  recipe: WorkflowRecipeV1,
  operationLabel: (operationId: string) => string,
): string {
  return recipe.steps
    .map((step) => operationLabel(step.operationId))
    .join(" → ");
}

export default function WorkflowRecipeLibraryPanel({
  recipe,
  disabled,
  operationLabel,
  onLoadRecipe,
  onCopyCanonical,
}: WorkflowRecipeLibraryPanelProps) {
  const feedbackId = useId();
  const storeRef = useRef<WorkflowRecipeLibraryStore | null>(null);
  const [snapshot, setSnapshot] =
    useState<WorkflowRecipeLibrarySnapshot | null>(null);
  const [clearArmed, setClearArmed] = useState(false);
  const [feedback, setFeedback] = useState<LibraryFeedback>({
    kind: "idle",
    message: "只保存操作顺序与规范化选项，不保存正文、结果或文件名。",
  });

  useEffect(() => {
    const store = new WorkflowRecipeLibraryStore();
    storeRef.current = store;
    const syncSnapshot = () => setSnapshot(store.getSnapshot());
    const unsubscribe = store.subscribe(syncSnapshot);
    syncSnapshot();
    store.refresh();

    return () => {
      unsubscribe();
      store.destroy();
      if (storeRef.current === store) storeRef.current = null;
    };
  }, []);

  const entries = snapshot?.entries ?? [];
  const controlsDisabled = disabled || snapshot === null;
  const canClearLibrary =
    entries.length > 0 ||
    snapshot?.reason === "invalid-storage" ||
    snapshot?.reason === "storage-read-failed" ||
    snapshot?.reason === "storage-write-failed";

  function saveCurrentRecipe(): void {
    const store = storeRef.current;
    if (store === null || recipe === undefined || controlsDisabled) return;
    try {
      const result = store.save(recipe);
      setClearArmed(false);
      if (result.reason === "storage-write-conflict") {
        setFeedback({
          kind: "warning",
          message: STORAGE_WRITE_CONFLICT_MESSAGE,
        });
        return;
      }
      setFeedback({
        kind: result.persisted ? "success" : "warning",
        message: `已保存纯配方；${persistenceMessage(result.persisted)}`,
      });
    } catch {
      setFeedback({
        kind: "error",
        message: `无法保存配方；请确认配方有效且配方库未超过 ${MAX_WORKFLOW_RECIPE_LIBRARY_ENTRIES} 项。`,
      });
    }
  }

  function loadRecipe(id: string): void {
    const store = storeRef.current;
    if (store === null || controlsDisabled) return;
    const storedRecipe = store.load(id);
    if (storedRecipe === undefined) {
      setFeedback({
        kind: "error",
        message: "这条配方已不可用，请刷新配方库后重试。",
      });
      return;
    }
    setClearArmed(false);
    onLoadRecipe(storedRecipe);
    setFeedback({
      kind: "success",
      message:
        "纯配方已载入；正文、结果与批处理队列均已清空，请按需重新输入后运行。",
    });
  }

  async function copyRecipe(id: string): Promise<void> {
    const canonical = storeRef.current?.copyCanonical(id);
    if (canonical === undefined || controlsDisabled) return;
    if (await onCopyCanonical(canonical)) {
      setClearArmed(false);
      setFeedback({ kind: "success", message: "规范化纯配方已复制。" });
    } else {
      setFeedback({
        kind: "warning",
        message: "无法访问剪贴板，请改用下载纯配方。",
      });
    }
  }

  function downloadRecipe(id: string): void {
    const storedRecipe = storeRef.current?.load(id);
    if (storedRecipe === undefined || controlsDisabled) return;
    try {
      downloadWorkflowRecipeFile(storedRecipe);
      setClearArmed(false);
      setFeedback({
        kind: "success",
        message: "纯配方下载已开始；下载文件使用固定安全名称。",
      });
    } catch {
      setFeedback({
        kind: "error",
        message: "当前浏览器无法安全下载此配方。",
      });
    }
  }

  function deleteRecipe(id: string): void {
    const store = storeRef.current;
    if (store === null || controlsDisabled) return;
    try {
      const result = store.delete(id);
      setClearArmed(false);
      if (result.reason === "storage-write-conflict") {
        setFeedback({
          kind: "warning",
          message: STORAGE_WRITE_CONFLICT_MESSAGE,
        });
        return;
      }
      setFeedback({
        kind: result.persisted ? "success" : "warning",
        message: result.persisted
          ? "配方已从此浏览器删除。"
          : "当前视图已删除配方，但未能更新浏览器存储；刷新后旧配方可能重新出现。",
      });
    } catch {
      setFeedback({ kind: "error", message: "无法删除这条配方。" });
    }
  }

  function clearLibrary(): void {
    const store = storeRef.current;
    if (store === null || controlsDisabled || !canClearLibrary) return;
    if (!clearArmed) {
      setClearArmed(true);
      setFeedback({
        kind: "warning",
        message: "再次点击“确认清空”才会删除全部本地纯配方。",
      });
      return;
    }
    try {
      const result = store.clear();
      setClearArmed(false);
      if (result.reason === "storage-write-conflict") {
        setFeedback({
          kind: "warning",
          message: STORAGE_WRITE_CONFLICT_MESSAGE,
        });
        return;
      }
      setFeedback({
        kind: result.persisted ? "success" : "warning",
        message: result.persisted
          ? "本地配方库已从此浏览器清空。"
          : "当前视图已清空，但未能更新浏览器存储；刷新后旧配方可能重新出现。",
      });
    } catch {
      setFeedback({ kind: "error", message: "无法清空本地配方库。" });
    }
  }

  async function importRecipeFile(
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.item(0);
    input.value = "";
    const store = storeRef.current;
    if (file === undefined || file === null || store === null || disabled) {
      return;
    }

    try {
      const imported = await readWorkflowRecipeFile(file);
      if (storeRef.current !== store) return;
      const result = store.save(imported.recipe);
      setClearArmed(false);
      if (result.reason === "storage-write-conflict") {
        setFeedback({
          kind: "warning",
          message: STORAGE_WRITE_CONFLICT_MESSAGE,
        });
        return;
      }
      setFeedback({
        kind: result.persisted ? "success" : "warning",
        message: `纯配方文件已安全导入；${persistenceMessage(result.persisted)}`,
      });
    } catch {
      setFeedback({
        kind: "error",
        message: "文件未导入；请确认它是 64 KiB 以内的有效 v1 纯配方 JSON。",
      });
    }
  }

  return (
    <details className="workflow-recipe-library" data-workflow-recipe-library>
      <summary>
        <span className="workflow-recipe-library__mark" aria-hidden="true">
          ◫
        </span>
        <span className="workflow-recipe-library__heading">
          <strong>本地配方库</strong>
          <small>保存可复用的操作链，不保存处理正文</small>
        </span>
        <span className="workflow-recipe-library__count">
          {snapshot === null
            ? "读取中"
            : `${entries.length}/${MAX_WORKFLOW_RECIPE_LIBRARY_ENTRIES}`}
        </span>
        <span className="workflow-recipe-library__chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>

      <div className="workflow-recipe-library__body">
        <div className="workflow-recipe-library__toolbar">
          <button
            type="button"
            className="workflow-recipe-library__save"
            disabled={controlsDisabled || recipe === undefined}
            data-action="save-library-recipe"
            onClick={saveCurrentRecipe}
          >
            <span aria-hidden="true">＋</span> 保存当前纯配方
          </button>

          <label className="workflow-recipe-library__file-picker">
            <span>导入 .json</span>
            <input
              type="file"
              accept=".json,application/json"
              disabled={controlsDisabled}
              aria-describedby={feedbackId}
              data-library-file-input
              onChange={(event) => void importRecipeFile(event)}
            />
          </label>

          <button
            type="button"
            className={clearArmed ? "is-danger" : undefined}
            disabled={controlsDisabled || !canClearLibrary}
            aria-pressed={clearArmed}
            data-action="clear-library-recipes"
            data-library-action="clear"
            onClick={clearLibrary}
          >
            {clearArmed ? "确认清空" : "清空全部"}
          </button>
        </div>

        {snapshot !== null && !snapshot.persisted ? (
          <p className="workflow-recipe-library__memory" role="status">
            <span aria-hidden="true">!</span>
            当前为内存模式：配方只在此标签页有效，刷新或关闭后会消失。
          </p>
        ) : null}

        {entries.length > 0 ? (
          <ul className="workflow-recipe-library__entries">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="workflow-recipe-library__entry"
                data-library-entry
                data-library-entry-id={entry.id}
              >
                <div className="workflow-recipe-library__entry-copy">
                  <strong>
                    {localizedRecipeName(entry.recipe, operationLabel)}
                  </strong>
                  <span>
                    {entry.recipe.steps.length} 步 · 更新于{" "}
                    {formatUpdatedAt(entry.updatedAt)}
                  </span>
                </div>
                <div className="workflow-recipe-library__entry-actions">
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    data-action="load-library-recipe"
                    data-library-action="load"
                    onClick={() => loadRecipe(entry.id)}
                  >
                    载入
                  </button>
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    data-action="copy-library-recipe"
                    data-library-action="copy"
                    onClick={() => void copyRecipe(entry.id)}
                  >
                    复制
                  </button>
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    data-action="download-library-recipe"
                    data-library-action="download"
                    onClick={() => downloadRecipe(entry.id)}
                  >
                    下载
                  </button>
                  <button
                    type="button"
                    className="is-danger"
                    disabled={controlsDisabled}
                    aria-label={`删除纯配方：${localizedRecipeName(entry.recipe, operationLabel)}`}
                    data-action="delete-library-recipe"
                    data-library-action="delete"
                    onClick={() => deleteRecipe(entry.id)}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : snapshot !== null ? (
          <div className="workflow-recipe-library__empty">
            <span aria-hidden="true">◇</span>
            <div>
              <strong>还没有本地配方</strong>
              <p>先建立有效步骤链，再保存当前纯配方或导入 JSON。</p>
            </div>
          </div>
        ) : null}

        <div
          id={feedbackId}
          className={`workflow-recipe-library__feedback is-${feedback.kind}`}
          role={feedback.kind === "error" ? "alert" : "status"}
          aria-live="polite"
          aria-atomic="true"
          data-library-feedback={feedback.kind}
        >
          {feedback.message}
        </div>
      </div>
    </details>
  );
}

export { WorkflowRecipeLibraryPanel };
