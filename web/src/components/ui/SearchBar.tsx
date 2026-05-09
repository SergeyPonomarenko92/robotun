"use client";
import * as React from "react";
import { Search, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export type SearchSuggestion = {
  id: string;
  label: string;
  meta?: string;
  hint?: string;
  icon?: React.ReactNode;
};

type SearchBarProps = {
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  onSuggestionSelect?: (s: SearchSuggestion) => void;
  suggestions?: SearchSuggestion[];
  loading?: boolean;
  size?: "md" | "lg";
  className?: string;
  autoFocus?: boolean;
};

export function SearchBar({
  value,
  defaultValue,
  placeholder = "Шукати майстра, послугу або категорію",
  onChange,
  onSubmit,
  onSuggestionSelect,
  suggestions = [],
  loading,
  size = "md",
  className,
  autoFocus,
}: SearchBarProps) {
  const [internal, setInternal] = React.useState(defaultValue ?? "");
  const [open, setOpen] = React.useState(false);
  const [hoverIdx, setHoverIdx] = React.useState(-1);
  const ref = React.useRef<HTMLDivElement>(null);
  const isControlled = value !== undefined;
  const v = isControlled ? value! : internal;

  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function update(next: string) {
    if (!isControlled) setInternal(next);
    onChange?.(next);
  }

  function pick(s: SearchSuggestion) {
    update(s.label);
    onSuggestionSelect?.(s);
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHoverIdx((i) => Math.min(suggestions.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHoverIdx((i) => Math.max(-1, i - 1));
    } else if (e.key === "Enter") {
      if (open && hoverIdx >= 0 && suggestions[hoverIdx]) {
        e.preventDefault();
        pick(suggestions[hoverIdx]);
      } else if (v.trim()) {
        onSubmit?.(v.trim());
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const hSize = size === "lg" ? "h-14" : "h-12";
  const textSize = size === "lg" ? "text-body-lg" : "text-body";

  return (
    <div
      ref={ref}
      className={cn("relative w-full", className)}
      onFocus={() => setOpen(true)}
    >
      <div
        className={cn(
          "flex items-stretch w-full bg-paper border border-hairline-strong rounded-[var(--radius-md)] focus-within:border-ink transition-colors",
          hSize
        )}
      >
        <span className="flex items-center justify-center pl-4 pr-2 text-ink-soft">
          {loading ? <Loader2 className="animate-spin" size={18} /> : <Search size={18} />}
        </span>
        <input
          type="search"
          autoFocus={autoFocus}
          value={v}
          placeholder={placeholder}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKey}
          className={cn(
            "flex-1 bg-transparent border-0 outline-none px-2 text-ink placeholder:text-muted-soft font-sans",
            textSize
          )}
        />
        {v && (
          <button
            type="button"
            aria-label="Очистити"
            onClick={() => {
              update("");
              setHoverIdx(-1);
            }}
            className="flex items-center justify-center w-10 text-muted hover:text-ink transition-colors"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {open && suggestions.length > 0 && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full mt-2 z-50 bg-paper border border-hairline-strong rounded-[var(--radius-md)] shadow-lg overflow-hidden"
        >
          {suggestions.map((s, i) => (
            <button
              key={s.id}
              role="option"
              aria-selected={i === hoverIdx}
              onMouseEnter={() => setHoverIdx(i)}
              onClick={() => pick(s)}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors border-b border-hairline last:border-b-0",
                i === hoverIdx ? "bg-canvas" : "bg-paper"
              )}
            >
              <span className="text-ink-soft shrink-0">
                {s.icon ?? <Search size={14} />}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-body text-ink truncate">{s.label}</div>
                {s.meta && (
                  <div className="text-caption text-muted truncate">{s.meta}</div>
                )}
              </div>
              {s.hint && (
                <span className="text-micro font-mono text-muted-soft shrink-0 uppercase">
                  {s.hint}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
