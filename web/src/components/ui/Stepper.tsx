import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

export type Step = {
  id: string;
  label: React.ReactNode;
  /** Опис під label на desktop */
  hint?: React.ReactNode;
  /** completed | current | upcoming | error */
  status?: "completed" | "current" | "upcoming" | "error";
};

type StepperProps = {
  steps: Step[];
  /** Активний крок за id (якщо не задано — обчислюється з status) */
  activeId?: string;
  className?: string;
  /** orientation: на mobile horizontal compact автоматично */
  orientation?: "horizontal" | "vertical";
};

export function Stepper({
  steps,
  activeId,
  className,
  orientation = "horizontal",
}: StepperProps) {
  const items = steps.map((s) => {
    const status =
      s.status ??
      (activeId
        ? s.id === activeId
          ? "current"
          : steps.findIndex((x) => x.id === activeId) >
              steps.findIndex((x) => x.id === s.id)
            ? "completed"
            : "upcoming"
        : "upcoming");
    return { ...s, status };
  });

  if (orientation === "vertical") {
    return (
      <ol className={cn("flex flex-col", className)}>
        {items.map((s, i) => (
          <li key={s.id} className="flex gap-4 last:pb-0 pb-6 relative">
            {i < items.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "absolute left-3 top-7 bottom-0 w-px",
                  s.status === "completed" ? "bg-ink" : "bg-hairline-strong"
                )}
              />
            )}
            <StepBullet status={s.status} index={i} />
            <div className="pb-2 flex-1 min-w-0">
              <p
                className={cn(
                  "text-body font-medium leading-snug",
                  s.status === "current" ? "text-ink" : "text-muted"
                )}
              >
                {s.label}
              </p>
              {s.hint && (
                <p className="text-caption text-muted-soft mt-0.5">{s.hint}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <ol className={cn("flex items-start w-full", className)}>
      {items.map((s, i) => (
        <li
          key={s.id}
          className={cn("flex-1 flex flex-col items-center text-center min-w-0 relative")}
        >
          <div className="flex items-center w-full">
            <span
              aria-hidden
              className={cn(
                "h-px flex-1 mr-2",
                i === 0 ? "invisible" : items[i - 1].status === "completed" ? "bg-ink" : "bg-hairline-strong"
              )}
            />
            <StepBullet status={s.status} index={i} />
            <span
              aria-hidden
              className={cn(
                "h-px flex-1 ml-2",
                i === items.length - 1
                  ? "invisible"
                  : s.status === "completed"
                    ? "bg-ink"
                    : "bg-hairline-strong"
              )}
            />
          </div>
          <p
            className={cn(
              "mt-2 text-caption leading-snug truncate w-full px-1",
              s.status === "current"
                ? "text-ink font-medium"
                : s.status === "completed"
                  ? "text-ink-soft"
                  : s.status === "error"
                    ? "text-danger"
                    : "text-muted"
            )}
          >
            {s.label}
          </p>
          {s.hint && (
            <p className="hidden md:block text-micro text-muted-soft mt-0.5 truncate w-full px-1">
              {s.hint}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

function StepBullet({
  status,
  index,
}: {
  status: NonNullable<Step["status"]>;
  index: number;
}) {
  return (
    <span
      className={cn(
        "shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-full border text-micro font-mono tabular-nums",
        status === "completed" && "bg-ink text-paper border-ink",
        status === "current" && "bg-paper text-ink border-ink ring-4 ring-ink/10",
        status === "upcoming" && "bg-paper text-muted-soft border-hairline-strong",
        status === "error" && "bg-danger-soft text-danger border-danger"
      )}
      aria-current={status === "current" ? "step" : undefined}
    >
      {status === "completed" ? <Check size={12} /> : index + 1}
    </span>
  );
}
