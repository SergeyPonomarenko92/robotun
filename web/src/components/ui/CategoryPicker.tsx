"use client";
import * as React from "react";
import { ChevronRight, Check } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * 3-level cascading picker per Module 2 (spec-data-category-tree).
 * Desktop: 3-column drill-down. Mobile: stack drill-down (lvl1 → lvl2 → lvl3).
 * Користувач вибирає leaf (level 3) — повертається повний path.
 */
export type Category = {
  id: string;
  name: string;
  /** Кількість дочірніх категорій (для desktop side hint) */
  childrenCount?: number;
  children?: Category[];
};

export type CategoryPath = {
  l1: Category;
  l2: Category;
  l3: Category;
};

type CategoryPickerProps = {
  categories: Category[];
  value?: CategoryPath | null;
  onChange?: (path: CategoryPath | null) => void;
  className?: string;
};

function Column({
  title,
  items,
  activeId,
  onSelect,
  emptyHint,
}: {
  title: string;
  items: Category[];
  activeId?: string;
  onSelect: (c: Category) => void;
  emptyHint?: string;
}) {
  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="px-3 py-2 border-b border-hairline">
        <p className="font-mono text-micro uppercase tracking-loose text-muted-soft">
          {title}
        </p>
      </div>
      <ul className="flex-1 overflow-y-auto max-h-72">
        {items.length === 0 ? (
          <li className="p-3 text-caption text-muted">{emptyHint ?? "—"}</li>
        ) : (
          items.map((c) => {
            const active = c.id === activeId;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c)}
                  className={cn(
                    "w-full flex items-center justify-between gap-2 px-3 py-2 text-left transition-colors",
                    active ? "bg-canvas text-ink" : "hover:bg-elevated text-ink-soft"
                  )}
                >
                  <span className="text-body truncate">{c.name}</span>
                  {c.children && c.children.length > 0 ? (
                    <ChevronRight
                      size={14}
                      className={cn("shrink-0", active ? "text-ink" : "text-muted-soft")}
                    />
                  ) : active ? (
                    <Check size={14} className="text-accent shrink-0" />
                  ) : null}
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

export function CategoryPicker({
  categories,
  value,
  onChange,
  className,
}: CategoryPickerProps) {
  const [l1, setL1] = React.useState<Category | null>(value?.l1 ?? null);
  const [l2, setL2] = React.useState<Category | null>(value?.l2 ?? null);

  React.useEffect(() => {
    if (value) {
      setL1(value.l1);
      setL2(value.l2);
    }
  }, [value]);

  const l2Items = l1?.children ?? [];
  const l3Items = l2?.children ?? [];

  return (
    <div
      className={cn(
        "border border-hairline-strong rounded-[var(--radius-md)] bg-paper overflow-hidden flex divide-x divide-hairline",
        className
      )}
    >
      <Column
        title="Категорія"
        items={categories}
        activeId={l1?.id}
        onSelect={(c) => {
          setL1(c);
          setL2(null);
        }}
      />
      <Column
        title="Підкатегорія"
        items={l2Items}
        activeId={l2?.id}
        emptyHint={l1 ? "Немає підкатегорій" : "Оберіть зліва"}
        onSelect={(c) => setL2(c)}
      />
      <Column
        title="Послуга"
        items={l3Items}
        activeId={value?.l3.id}
        emptyHint={l2 ? "Немає послуг" : "Оберіть підкатегорію"}
        onSelect={(c) => {
          if (l1 && l2) onChange?.({ l1, l2, l3: c });
        }}
      />
    </div>
  );
}
