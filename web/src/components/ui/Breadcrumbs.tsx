import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

export type BreadcrumbItem = {
  label: React.ReactNode;
  href?: string;
};

type BreadcrumbsProps = {
  items: BreadcrumbItem[];
  className?: string;
  /** Розмір крихт; sm — для admin/dense, md — типовий */
  size?: "sm" | "md";
};

export function Breadcrumbs({ items, className, size = "md" }: BreadcrumbsProps) {
  const text = size === "sm" ? "text-caption" : "text-body";
  return (
    <nav
      aria-label="Хлібні крихти"
      className={cn("flex items-center gap-1 min-w-0 overflow-x-auto", text, className)}
    >
      <ol className="flex items-center gap-1 min-w-0">
        {items.map((it, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className="flex items-center gap-1 min-w-0">
              {it.href && !last ? (
                <Link
                  href={it.href}
                  className="text-muted hover:text-ink truncate transition-colors"
                >
                  {it.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={cn(
                    "truncate",
                    last ? "text-ink font-medium" : "text-muted"
                  )}
                >
                  {it.label}
                </span>
              )}
              {!last && (
                <ChevronRight
                  size={14}
                  className="shrink-0 text-muted-soft"
                  aria-hidden
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
