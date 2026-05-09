import * as React from "react";
import { Calendar } from "lucide-react";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/Avatar";

export type DealEventTone = "neutral" | "info" | "warning" | "danger" | "success";

export type DealEvent = {
  id: string | number;
  /** event_type per Deal spec §4.2; у UI скоріше label-ready string */
  label: string;
  /** Кому відомий цей факт — за замовчуванням обидвом сторонам */
  description?: React.ReactNode;
  actor?: { name: string; avatarUrl?: string; role?: "client" | "provider" | "system" | "admin" };
  /** ISO */
  at: string;
  tone?: DealEventTone;
  /** Деталі (developer/audit-mode), показані у monospace */
  details?: { label: string; value: string }[];
};

type DealTimelineProps = {
  events: DealEvent[];
  className?: string;
};

const TONE: Record<DealEventTone, string> = {
  neutral: "bg-paper text-ink-soft border-hairline-strong",
  info: "bg-info-soft text-info border-info",
  warning: "bg-warning-soft text-warning border-warning",
  danger: "bg-danger-soft text-danger border-danger",
  success: "bg-success-soft text-success border-success",
};

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("uk-UA", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function DealTimeline({ events, className }: DealTimelineProps) {
  return (
    <div className={cn("relative", className)}>
      <ol className="flex flex-col gap-0">
        {events.map((e, i) => {
          const isLast = i === events.length - 1;
          return (
            <li key={e.id} className="grid grid-cols-[auto_1fr] gap-4 relative pb-6 last:pb-0">
              <div className="relative flex flex-col items-center">
                <span
                  className={cn(
                    "shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-full border text-micro font-mono tabular-nums",
                    TONE[e.tone ?? "neutral"]
                  )}
                  aria-hidden
                >
                  {events.length - i}
                </span>
                {!isLast && (
                  <span
                    className="flex-1 w-px bg-hairline mt-1"
                    aria-hidden
                  />
                )}
              </div>
              <div>
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <p className="font-display text-body-lg text-ink tracking-tight">
                    {e.label}
                  </p>
                  <span className="font-mono text-caption text-muted-soft inline-flex items-center gap-1 shrink-0">
                    <Calendar size={11} />
                    {fmtDateTime(e.at)}
                  </span>
                </div>
                {e.description && (
                  <p className="text-body text-muted leading-relaxed mt-1">
                    {e.description}
                  </p>
                )}
                {e.actor && (
                  <p className="mt-2 inline-flex items-center gap-2 text-caption text-muted">
                    <Avatar size="xs" alt={e.actor.name} src={e.actor.avatarUrl} />
                    <span>
                      {e.actor.name}
                      {e.actor.role && (
                        <span className="ml-1 text-muted-soft">· {e.actor.role}</span>
                      )}
                    </span>
                  </p>
                )}
                {e.details && e.details.length > 0 && (
                  <dl className="mt-3 grid grid-cols-2 gap-y-1 gap-x-4 text-caption max-w-md">
                    {e.details.map((d) => (
                      <React.Fragment key={d.label}>
                        <dt className="font-mono text-micro uppercase tracking-loose text-muted-soft">
                          {d.label}
                        </dt>
                        <dd className="font-mono tabular-nums text-ink-soft">
                          {d.value}
                        </dd>
                      </React.Fragment>
                    ))}
                  </dl>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
