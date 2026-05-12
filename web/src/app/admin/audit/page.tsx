"use client";
import * as React from "react";
import { KeyRound, Gavel, Banknote, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { AdminShell } from "@/components/organisms/AdminShell";
import { useAdminAudit, type AdminAction } from "@/lib/admin_audit";

const ACTION_LABELS: Record<AdminAction["action"], string> = {
  "mfa.challenge.issued": "MFA · видано виклик",
  "mfa.challenge.consumed": "MFA · код використано",
  "dispute.resolved": "Диспут вирішено",
  "payout.completed": "Виплата зарахована",
};

const ACTION_ICONS: Record<AdminAction["action"], React.ReactNode> = {
  "mfa.challenge.issued": <KeyRound size={14} />,
  "mfa.challenge.consumed": <ShieldCheck size={14} />,
  "dispute.resolved": <Gavel size={14} />,
  "payout.completed": <Banknote size={14} />,
};

const ACTION_TONES: Record<
  AdminAction["action"],
  "neutral" | "info" | "success" | "danger" | "warning"
> = {
  "mfa.challenge.issued": "info",
  "mfa.challenge.consumed": "info",
  "dispute.resolved": "warning",
  "payout.completed": "success",
};

export default function AdminAuditPage() {
  const [filter, setFilter] = React.useState<"" | "mfa." | "dispute.">("");
  const audit = useAdminAudit({ limit: 30, actionPrefix: filter || undefined });

  return (
    <AdminShell
      kicker="Module 12 · admin_actions"
      title={
        <>
          Append-only
          <br />
          <span className="text-accent italic">audit log</span>
        </>
      }
      description={
        audit.loading
          ? "Завантажуємо журнал…"
          : `Усього записів: ${audit.total}. Кожна сильна дія адміністратора залишає рядок — UPDATE/DELETE заборонено на рівні БД (REVOKE).`
      }
      sidecar={
        <div
          role="tablist"
          aria-label="Фільтр"
          className="inline-flex border border-hairline rounded-[var(--radius-pill)] bg-paper p-1"
        >
          {(
            [
              { id: "", label: "усе" },
              { id: "mfa.", label: "MFA" },
              { id: "dispute.", label: "Disputes" },
            ] as { id: typeof filter; label: string }[]
          ).map((b) => (
            <button
              key={b.id || "all"}
              type="button"
              role="tab"
              aria-selected={filter === b.id}
              onClick={() => setFilter(b.id)}
              className={[
                "px-4 h-8 rounded-[var(--radius-pill)] text-caption transition-colors",
                filter === b.id
                  ? "bg-ink text-paper"
                  : "text-muted hover:text-ink",
              ].join(" ")}
            >
              {b.label}
            </button>
          ))}
        </div>
      }
    >
        {audit.error && (
          <div className="mb-6">
            <ErrorState
              kind="server"
              variant="inline"
              description="Не вдалось завантажити журнал."
              onRetry={audit.refresh}
            />
          </div>
        )}

        {audit.loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-[68px] border border-hairline rounded-[var(--radius-md)] bg-paper animate-pulse"
              />
            ))}
          </div>
        ) : audit.items.length === 0 ? (
          <div className="border border-dashed border-hairline-strong rounded-[var(--radius-md)] bg-paper/40 p-10 text-center">
            <p className="font-display text-h3 text-ink tracking-tight">
              Журнал порожній
            </p>
            <p className="text-body text-muted mt-2 max-w-lg mx-auto">
              Рядки зʼявляться щойно адміністратор запросить MFA-код або
              закриє диспут.
            </p>
          </div>
        ) : (
          <ul className="border border-hairline rounded-[var(--radius-md)] bg-paper divide-y divide-hairline overflow-hidden">
            {audit.items.map((a) => (
              <AuditRow key={a.id} a={a} />
            ))}
          </ul>
        )}

        {audit.nextCursor && (
          <div className="mt-6 flex justify-end">
            <Button
              variant="link"
              onClick={audit.loadMore}
              disabled={audit.loadingMore}
            >
              {audit.loadingMore
                ? "Завантаження…"
                : `Ще записи (${audit.total - audit.items.length})`}
            </Button>
          </div>
        )}
    </AdminShell>
  );
}

function AuditRow({ a }: { a: AdminAction }) {
  const ts = new Date(a.created_at);
  const metaPreview = Object.entries(a.metadata)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${String(v ?? "")}`)
    .join(" · ");
  return (
    <li className="px-5 md:px-6 py-4 flex items-start gap-4">
      <Badge tone={ACTION_TONES[a.action]} size="sm" shape="square">
        <span className="mr-1 inline-flex items-center">
          {ACTION_ICONS[a.action]}
        </span>
        {ACTION_LABELS[a.action]}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="text-body text-ink leading-tight">
          {a.target_type && a.target_id ? (
            <>
              <span className="font-mono text-caption text-muted mr-2">
                {a.target_type}
              </span>
              <span className="font-mono text-caption tracking-[0.1em]">
                {a.target_id.slice(0, 8).toUpperCase()}
              </span>
            </>
          ) : (
            <span className="text-muted">—</span>
          )}
        </p>
        {metaPreview && (
          <p className="font-mono text-micro text-muted-soft mt-1 truncate">
            {metaPreview}
          </p>
        )}
      </div>
      <div className="text-right shrink-0">
        <p className="font-mono text-caption tabular-nums text-ink-soft">
          {ts.toLocaleTimeString("uk-UA")}
        </p>
        <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted-soft">
          {ts.toLocaleDateString("uk-UA", { day: "numeric", month: "short" })}
        </p>
      </div>
    </li>
  );
}
