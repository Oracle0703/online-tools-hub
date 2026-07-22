import type { ComponentPropsWithoutRef } from "react";

type ToolWorkspaceProps = Omit<
  ComponentPropsWithoutRef<"section">,
  "aria-labelledby"
> & {
  toolId: string;
  titleId: string;
  localProcessing?: boolean;
};

type ToolWorkspaceHeaderProps = ComponentPropsWithoutRef<"div">;

type ToolWorkspaceRegionProps = ComponentPropsWithoutRef<"div"> & {
  region: "input" | "output";
};

type ToolWorkspaceActionsProps = ComponentPropsWithoutRef<"div">;

export type ToolActionName =
  | "cancel"
  | "clear"
  | "copy"
  | "download"
  | "example"
  | "execute"
  | "swap"
  | "upload";

type ToolWorkspaceActionProps = ComponentPropsWithoutRef<"button"> & {
  action: ToolActionName;
};

function withBaseClass(baseClass: string, className?: string): string {
  return className ? `${baseClass} ${className}` : baseClass;
}

/**
 * Shared semantic frame for every interactive tool island.
 *
 * `data-tool-workspace` and the region/action attributes are stable hooks for
 * cross-tool automation. Tool-specific classes remain available for styling.
 */
export function ToolWorkspace({
  toolId,
  titleId,
  localProcessing = true,
  className,
  children,
  ...props
}: ToolWorkspaceProps) {
  return (
    <section
      {...props}
      className={withBaseClass("tool-workspace", className)}
      aria-labelledby={titleId}
      data-tool-workspace={toolId}
      data-local-processing={localProcessing ? "true" : undefined}
    >
      {children}
    </section>
  );
}

export function ToolWorkspaceHeader({
  className,
  children,
  ...props
}: ToolWorkspaceHeaderProps) {
  return (
    <div
      {...props}
      className={withBaseClass("tool-workspace__head", className)}
      data-tool-region="title"
    >
      {children}
    </div>
  );
}

export function ToolWorkspaceRegion({
  region,
  children,
  ...props
}: ToolWorkspaceRegionProps) {
  return (
    <div {...props} data-tool-region={region}>
      {children}
    </div>
  );
}

export function ToolWorkspaceActions({
  className,
  children,
  ...props
}: ToolWorkspaceActionsProps) {
  return (
    <div
      {...props}
      className={withBaseClass("workspace-actions", className)}
      data-tool-region="actions"
    >
      {children}
    </div>
  );
}

export function ToolWorkspaceAction({
  action,
  children,
  ...props
}: ToolWorkspaceActionProps) {
  return (
    <button {...props} data-tool-action={action}>
      {children}
    </button>
  );
}
