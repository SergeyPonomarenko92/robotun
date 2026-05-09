import * as React from "react";
import { cn } from "@/lib/cn";

type EmptyStateProps = {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  primaryAction?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  /** Editorial decoration: large display number on the left */
  numeral?: string;
  className?: string;
  size?: "sm" | "md" | "lg";
};

export function EmptyState({
  icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  numeral,
  className,
  size = "md",
}: EmptyStateProps) {
  const padding =
    size === "sm" ? "py-10 px-6" : size === "lg" ? "py-24 px-12" : "py-16 px-8";

  return (
    <div
      className={cn(
        "border border-dashed border-hairline-strong rounded-[var(--radius-md)] bg-elevated/40 flex flex-col md:flex-row items-start md:items-center gap-6 md:gap-10",
        padding,
        className
      )}
    >
      {numeral ? (
        <span className="font-display text-display text-ink/15 leading-none tracking-tight shrink-0">
          {numeral}
        </span>
      ) : icon ? (
        <div className="shrink-0 w-14 h-14 rounded-[var(--radius-md)] bg-canvas border border-hairline flex items-center justify-center text-ink-soft">
          {icon}
        </div>
      ) : null}
      <div className="flex-1 max-w-xl">
        <h3 className="font-display text-h3 text-ink tracking-tight mb-2">
          {title}
        </h3>
        {description && (
          <p className="text-body text-muted leading-relaxed">{description}</p>
        )}
        {(primaryAction || secondaryAction) && (
          <div className="flex flex-wrap gap-3 mt-5">
            {primaryAction}
            {secondaryAction}
          </div>
        )}
      </div>
    </div>
  );
}
