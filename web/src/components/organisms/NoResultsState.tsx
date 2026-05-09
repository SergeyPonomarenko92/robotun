import * as React from "react";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Tag } from "@/components/ui/Tag";

type NoResultsStateProps = {
  query?: string;
  /** Підказані пошукові запити (Module 13 popular queries) */
  suggestions?: string[];
  onSuggestionClick?: (q: string) => void;
  onResetFilters?: () => void;
  className?: string;
};

export function NoResultsState({
  query,
  suggestions,
  onSuggestionClick,
  onResetFilters,
  className,
}: NoResultsStateProps) {
  return (
    <div className={className}>
      <div className="border border-dashed border-hairline-strong rounded-[var(--radius-md)] bg-elevated/40 p-10 md:p-14 flex flex-col md:flex-row gap-8 md:gap-12 items-start">
        <span className="font-display text-display text-ink/15 leading-none tracking-tight">
          0
        </span>
        <div className="flex-1 max-w-2xl">
          <p className="font-mono text-micro uppercase tracking-loose text-muted-soft mb-3">
            <SearchX size={12} className="inline -translate-y-px mr-1" />
            нічого не знайдено
          </p>
          <h3 className="font-display text-h2 text-ink tracking-tight leading-tight mb-3">
            {query ? (
              <>За запитом «{query}» нічого не знайшли.</>
            ) : (
              <>Нічого не знайшли за вашими фільтрами.</>
            )}
          </h3>
          <p className="text-body text-muted leading-relaxed mb-6">
            Спробуйте інший запит, зніміть частину фільтрів або перегляньте популярні
            пошуки нижче. Якщо це новий вид послуги — створіть «потребу», і майстри
            відгукнуться самі.
          </p>
          <div className="flex flex-wrap gap-3 mb-6">
            {onResetFilters && (
              <Button variant="secondary" onClick={onResetFilters}>
                Скинути фільтри
              </Button>
            )}
            <Button variant="ghost">Створити потребу →</Button>
          </div>
          {suggestions && suggestions.length > 0 && (
            <>
              <p className="font-mono text-micro uppercase tracking-loose text-muted-soft mb-2">
                Популярні запити
              </p>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((s) => (
                  <Tag
                    key={s}
                    interactive
                    onClick={() => onSuggestionClick?.(s)}
                  >
                    {s}
                  </Tag>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
