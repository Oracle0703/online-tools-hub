import {
  exportWorkflowRecipeCanonical,
  normalizeWorkflowRecipe,
} from "./recipe-codec";
import type {
  WorkflowRecipeNormalizationDependencies,
  WorkflowRecipeV1,
} from "./contract";

export const MAX_WORKFLOW_HISTORY_ENTRIES = 8;

export type WorkflowHistorySnapshot = Readonly<{
  entries: number;
  cursor: number;
  canUndo: boolean;
  canRedo: boolean;
}>;

export interface WorkflowHistoryOptions {
  /** May lower, but never raise, the privacy-reviewed eight-recipe bound. */
  readonly maxEntries?: number;
  /** Optional catalog policy used to make operation defaults explicit. */
  readonly normalization?: WorkflowRecipeNormalizationDependencies;
}

type HistoryEntry = Readonly<{
  canonical: string;
  recipe: WorkflowRecipeV1;
}>;

/**
 * Bounded structural undo for recipes. Payload IDs and bodies are not part of
 * the recipe schema, so cancellation and Vault cleanup cannot resurrect data.
 */
export class WorkflowHistory {
  readonly #entries: HistoryEntry[] = [];
  readonly #maxEntries: number;
  readonly #normalization: WorkflowRecipeNormalizationDependencies;
  #cursor = -1;

  constructor(options: WorkflowHistoryOptions = {}) {
    const maxEntries = options.maxEntries ?? MAX_WORKFLOW_HISTORY_ENTRIES;
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries <= 0 ||
      maxEntries > MAX_WORKFLOW_HISTORY_ENTRIES
    ) {
      throw new RangeError(
        `maxEntries must be between 1 and ${MAX_WORKFLOW_HISTORY_ENTRIES}.`,
      );
    }
    this.#maxEntries = maxEntries;
    this.#normalization = options.normalization ?? {};
  }

  /** Records a normalized, deeply frozen recipe and drops any redo branch. */
  record(recipe: unknown): WorkflowRecipeV1 {
    const normalized = normalizeWorkflowRecipe(recipe, this.#normalization);
    const canonical = exportWorkflowRecipeCanonical(normalized);
    const current = this.#entries[this.#cursor];
    if (current?.canonical === canonical) return current.recipe;

    if (this.#cursor + 1 < this.#entries.length) {
      this.#entries.splice(this.#cursor + 1);
    }
    this.#entries.push(Object.freeze({ canonical, recipe: normalized }));
    if (this.#entries.length > this.#maxEntries) this.#entries.shift();
    this.#cursor = this.#entries.length - 1;
    return normalized;
  }

  current(): WorkflowRecipeV1 | undefined {
    return this.#entries[this.#cursor]?.recipe;
  }

  undo(): WorkflowRecipeV1 | undefined {
    if (this.#cursor <= 0) return undefined;
    this.#cursor -= 1;
    return this.#entries[this.#cursor]?.recipe;
  }

  redo(): WorkflowRecipeV1 | undefined {
    if (this.#cursor < 0 || this.#cursor + 1 >= this.#entries.length) {
      return undefined;
    }
    this.#cursor += 1;
    return this.#entries[this.#cursor]?.recipe;
  }

  /** A read-only view useful to UI state; entries contain recipes only. */
  recipes(): readonly WorkflowRecipeV1[] {
    return Object.freeze(this.#entries.map((entry) => entry.recipe));
  }

  /** Clears structural undo only; it never reads or mutates the Payload Vault. */
  clear(): void {
    this.#entries.length = 0;
    this.#cursor = -1;
  }

  snapshot(): WorkflowHistorySnapshot {
    return Object.freeze({
      entries: this.#entries.length,
      cursor: this.#cursor,
      canUndo: this.#cursor > 0,
      canRedo: this.#cursor >= 0 && this.#cursor + 1 < this.#entries.length,
    });
  }
}
