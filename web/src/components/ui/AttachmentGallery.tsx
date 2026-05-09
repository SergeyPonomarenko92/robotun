"use client";
import * as React from "react";
import { X, Star } from "lucide-react";
import { cn } from "@/lib/cn";

export type GalleryItem = {
  id: string;
  src: string;
  alt?: string;
  /** Cover (перше фото лістингу) — обводимо акцентом */
  isCover?: boolean;
};

type AttachmentGalleryProps = {
  items: GalleryItem[];
  /** Module 5: 1 cover + до 9 додаткових = 10 max. Module 14: 5 evidence/party. */
  maxItems?: number;
  onRemove?: (id: string) => void;
  onSetCover?: (id: string) => void;
  onReorder?: (next: GalleryItem[]) => void;
  className?: string;
  emptyHint?: React.ReactNode;
};

export function AttachmentGallery({
  items,
  maxItems = 10,
  onRemove,
  onSetCover,
  onReorder,
  className,
  emptyHint,
}: AttachmentGalleryProps) {
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overId, setOverId] = React.useState<string | null>(null);

  const empty = items.length === 0;
  const slots = Math.max(0, maxItems - items.length);
  const filledRatio = items.length / maxItems;

  function reorderTo(targetId: string) {
    if (!dragId || !onReorder || dragId === targetId) return;
    const from = items.findIndex((i) => i.id === dragId);
    const to = items.findIndex((i) => i.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorder(next);
  }

  return (
    <div className={cn("w-full", className)}>
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-caption text-muted">
          {empty ? "Жодного фото" : `${items.length} з ${maxItems}`}
        </p>
        <div
          className="h-1 w-32 bg-canvas border border-hairline rounded-full overflow-hidden"
          aria-hidden
        >
          <span
            className={cn(
              "block h-full transition-[width] duration-[var(--duration-base)]",
              filledRatio >= 1 ? "bg-warning" : "bg-ink"
            )}
            style={{ width: `${Math.min(100, filledRatio * 100)}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
        {items.map((it) => (
          <figure
            key={it.id}
            draggable={!!onReorder}
            onDragStart={() => setDragId(it.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOverId(it.id);
            }}
            onDrop={() => reorderTo(it.id)}
            className={cn(
              "relative group aspect-square overflow-hidden rounded-[var(--radius-sm)] border bg-canvas",
              it.isCover ? "border-accent shadow-md" : "border-hairline",
              overId === it.id && dragId !== it.id && "ring-2 ring-ink ring-offset-1 ring-offset-paper"
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={it.src}
              alt={it.alt ?? ""}
              className="h-full w-full object-cover"
              draggable={false}
            />
            {it.isCover && (
              <span className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--radius-xs)] bg-accent text-paper text-micro font-medium uppercase tracking-loose">
                <Star size={10} fill="currentColor" /> обкладинка
              </span>
            )}
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 p-1.5 bg-gradient-to-t from-ink/70 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
              {onSetCover && !it.isCover && (
                <button
                  type="button"
                  onClick={() => onSetCover(it.id)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-xs)] bg-paper/95 text-ink hover:bg-paper"
                  aria-label="Зробити обкладинкою"
                >
                  <Star size={12} />
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  onClick={() => onRemove(it.id)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-xs)] bg-paper/95 text-danger hover:bg-paper"
                  aria-label="Видалити"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </figure>
        ))}
        {empty && emptyHint && (
          <div className="col-span-full p-6 border border-dashed border-hairline-strong rounded-[var(--radius-md)] text-center text-caption text-muted">
            {emptyHint}
          </div>
        )}
        {!empty &&
          slots > 0 &&
          Array.from({ length: Math.min(slots, 5) }).map((_, i) => (
            <div
              key={`slot-${i}`}
              className="aspect-square rounded-[var(--radius-sm)] border border-dashed border-hairline-strong bg-canvas/40"
              aria-hidden
            />
          ))}
      </div>
    </div>
  );
}
