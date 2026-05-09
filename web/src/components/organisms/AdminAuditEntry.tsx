import * as React from "react";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/Avatar";
import { CopyButton } from "@/components/ui/CopyButton";

/**
 * Module 12 admin_actions immutable audit log row. REVOKE on table guarantees
 * append-only at DB level (mirror KYC SEC-006). UI always renders mono and
 * shows raw payload diff як expandable.
 */
export type AdminAuditAction =
  | "user.suspend"
  | "user.unsuspend"
  | "user.role_change"
  | "kyc.approve"
  | "kyc.reject"
  | "listing.takedown"
  | "review.takedown"
  | "dispute.resolve"
  | "chargeback.note"
  | "wallet.adjust"
  | "category.approve"
  | "bulk.execute"
  | "view_dispute_messages"
  | string;

export type AdminAuditEntryData = {
  id: string;
  /** ISO */
  at: string;
  actor: { id: string; name: string; avatarUrl?: string };
  action: AdminAuditAction;
  /** entity_type + entity_id (e.g. deal · DLR-9af3) */
  target: { type: string; id: string };
  metadata?: Record<string, string | number | boolean | null>;
  /** Optional: 4-eyes confirmation actor */
  approvedBy?: { id: string; name: string };
  /** request id для трейсингу */
  requestId?: string;
};

type AdminAuditEntryProps = {
  data: AdminAuditEntryData;
  className?: string;
};

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("uk-UA", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function actionTone(action: AdminAuditAction) {
  if (action.startsWith("user.suspend") || action.includes("takedown") || action.includes("reject")) return "danger";
  if (action.includes("approve") || action.includes("unsuspend")) return "success";
  if (action.includes("resolve") || action.includes("execute")) return "warning";
  return "neutral";
}

const TONE_CLS = {
  neutral: "border-l-hairline-strong",
  success: "border-l-success",
  warning: "border-l-warning",
  danger: "border-l-danger",
} as const;

export function AdminAuditEntry({ data, className }: AdminAuditEntryProps) {
  const tone = actionTone(data.action);
  return (
    <article
      className={cn(
        "grid grid-cols-[auto_1fr] gap-4 px-5 py-4 border-b border-hairline last:border-b-0 border-l-4 bg-paper",
        TONE_CLS[tone],
        className
      )}
    >
      <div className="flex flex-col items-center gap-1 pt-0.5">
        <Avatar shape="circle" size="sm" alt={data.actor.name} src={data.actor.avatarUrl} />
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <p className="text-body text-ink leading-snug">
            <strong className="font-medium">{data.actor.name}</strong>{" "}
            <span className="font-mono text-caption text-muted-soft">·</span>{" "}
            <code className="font-mono text-caption text-accent-hover bg-accent-soft px-1.5 py-0.5 rounded-[var(--radius-xs)] tracking-tight">
              {data.action}
            </code>{" "}
            <span className="text-muted">→</span>{" "}
            <span className="font-mono text-caption text-ink-soft">
              {data.target.type}/{data.target.id}
            </span>
          </p>
          <span className="font-mono text-micro text-muted-soft tabular-nums shrink-0">
            {fmtDateTime(data.at)}
          </span>
        </div>
        {data.metadata && Object.keys(data.metadata).length > 0 && (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-caption font-mono">
            {Object.entries(data.metadata).map(([k, v]) => (
              <React.Fragment key={k}>
                <dt className="text-muted-soft uppercase tracking-loose text-micro">
                  {k}
                </dt>
                <dd className="text-ink-soft tabular-nums break-all">
                  {String(v)}
                </dd>
              </React.Fragment>
            ))}
          </dl>
        )}
        <div className="mt-2 flex items-center gap-3 flex-wrap font-mono text-micro uppercase tracking-loose text-muted-soft">
          {data.approvedBy && (
            <span className="inline-flex items-center gap-1 text-success normal-case tracking-normal">
              4-eyes ok · {data.approvedBy.name}
            </span>
          )}
          {data.requestId && (
            <span className="inline-flex items-center gap-1">
              req
              <CopyButton value={data.requestId} variant="inline" size="sm" />
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
