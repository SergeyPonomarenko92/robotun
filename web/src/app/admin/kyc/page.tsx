"use client";
import * as React from "react";
import { CheckCircle2, XCircle, AlertTriangle, Loader2 } from "lucide-react";

import { AdminShell } from "@/components/organisms/AdminShell";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { RadioCardGroup } from "@/components/ui/RadioCardGroup";
import {
  useAdminKycQueue,
  approveKyc,
  rejectKyc,
  REJECTION_CODES,
  REJECTION_LABELS,
  type AdminKycFilter,
  type AdminKycRow,
  type RejectionCode,
} from "@/lib/admin-kyc";

const FILTERS: { id: AdminKycFilter; label: string }[] = [
  { id: "open", label: "Відкриті" },
  { id: "approved", label: "Підтверджені" },
  { id: "rejected", label: "Відхилені" },
];

const DOC_LABEL: Record<AdminKycRow["doc_type"], string> = {
  passport: "Паспорт",
  id_card: "ID-картка",
  bio_passport: "Закордонний",
};

const STATUS_TONE: Record<AdminKycRow["status"], "success" | "warning" | "danger" | "neutral"> = {
  not_submitted: "neutral",
  submitted: "warning",
  in_review: "warning",
  approved: "success",
  rejected: "danger",
  expired: "neutral",
  cancelled: "neutral",
};

const STATUS_LABEL: Record<AdminKycRow["status"], string> = {
  not_submitted: "Не подано",
  submitted: "Очікує",
  in_review: "На перевірці",
  approved: "Підтверджено",
  rejected: "Відхилено",
  expired: "Прострочено",
  cancelled: "Скасовано",
};

export default function AdminKycPage() {
  const [filter, setFilter] = React.useState<AdminKycFilter>("open");
  const { items, error, refresh } = useAdminKycQueue(filter);
  const [rejectTarget, setRejectTarget] = React.useState<AdminKycRow | null>(
    null
  );

  return (
    <AdminShell
      kicker="Адмін · KYC"
      title={
        <>
          Перевірка
          <br />
          <span className="text-ink-soft italic">документів виконавців</span>
        </>
      }
      description="Підтвердження дозволяє виплати; відхилення зберігає причину."
    >
      <section className="mt-6 space-y-5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
            Фільтр:
          </span>
          {FILTERS.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setFilter(o.id)}
              aria-pressed={filter === o.id}
              className={
                "px-2.5 py-1 rounded-[var(--radius-pill)] text-caption transition-colors duration-[var(--duration-fast)] " +
                (filter === o.id
                  ? "bg-ink text-paper"
                  : "bg-paper text-ink-soft border border-hairline hover:text-ink hover:border-hairline-strong")
              }
            >
              {o.label}
            </button>
          ))}
        </div>

        <QueueTable
          items={items}
          error={error}
          onReject={(row) => setRejectTarget(row)}
          onApproved={refresh}
        />
      </section>

      {rejectTarget && (
        <RejectModal
          row={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onDone={() => {
            setRejectTarget(null);
            refresh();
          }}
        />
      )}
    </AdminShell>
  );
}

function QueueTable({
  items,
  error,
  onReject,
  onApproved,
}: {
  items: AdminKycRow[] | null;
  error: string | null;
  onReject: (row: AdminKycRow) => void;
  onApproved: () => void;
}) {
  const [approvingId, setApprovingId] = React.useState<string | null>(null);
  const [approveErr, setApproveErr] = React.useState<string | null>(null);

  if (error) {
    return (
      <div className="border border-danger rounded-[var(--radius-md)] bg-danger-soft p-5 flex items-start gap-3">
        <AlertTriangle size={16} className="text-danger mt-0.5" aria-hidden />
        <div>
          <div className="text-body text-ink">Не вдалось завантажити чергу</div>
          <div className="text-caption text-muted mt-1">{error}</div>
        </div>
      </div>
    );
  }
  if (items === null) {
    return (
      <div className="border border-hairline rounded-[var(--radius-md)] bg-paper h-40 flex items-center justify-center">
        <Loader2 size={18} className="animate-spin text-muted" aria-hidden />
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="border border-hairline rounded-[var(--radius-md)] bg-paper p-8 text-center">
        <div className="text-body text-ink">Черга порожня</div>
        <div className="text-caption text-muted mt-1">
          Нових заявок на перевірку немає
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {approveErr && <InlineAlert tone="danger">{approveErr}</InlineAlert>}
      <div className="border border-hairline rounded-[var(--radius-md)] bg-paper overflow-hidden">
        <ul className="divide-y divide-hairline">
          {items.map((r) => {
            const isOpen = r.status === "submitted" || r.status === "in_review";
            return (
              <li key={r.provider_id} className="flex items-center gap-4 px-5 py-4 min-w-0">
                <Avatar
                  src={r.provider?.avatar_url}
                  alt={r.provider?.display_name ?? r.legal_name}
                  size="md"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-body text-ink truncate">
                      {r.legal_name || r.provider?.display_name || "—"}
                    </span>
                    <Badge tone={STATUS_TONE[r.status]} size="sm" shape="square">
                      {STATUS_LABEL[r.status]}
                    </Badge>
                  </div>
                  <div className="text-caption text-muted truncate">
                    {r.provider?.email} · {DOC_LABEL[r.doc_type]} · ІПН {r.tax_id}
                  </div>
                  <div className="text-caption text-muted tabular-nums mt-0.5">
                    Подано {new Date(r.submitted_at).toLocaleString("uk-UA")}
                    {r.rejection_code && (
                      <span className="ml-2 text-danger">
                        · {REJECTION_LABELS[r.rejection_code as RejectionCode]
                          ?? r.rejection_code}
                      </span>
                    )}
                  </div>
                </div>
                {isOpen && (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="primary"
                      leftIcon={<CheckCircle2 size={12} />}
                      disabled={approvingId === r.provider_id}
                      onClick={async () => {
                        setApprovingId(r.provider_id);
                        setApproveErr(null);
                        const res = await approveKyc(r.provider_id);
                        setApprovingId(null);
                        if (res.ok) onApproved();
                        else setApproveErr(res.error.message);
                      }}
                    >
                      Підтвердити
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      leftIcon={<XCircle size={12} />}
                      onClick={() => onReject(r)}
                    >
                      Відхилити
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function RejectModal({
  row,
  onClose,
  onDone,
}: {
  row: AdminKycRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [code, setCode] = React.useState<RejectionCode>("incomplete_submission");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const r = await rejectKyc(row.provider_id, code, note.trim() || undefined);
    setBusy(false);
    if (r.ok) onDone();
    else setErr(r.error.message);
  };

  return (
    <Modal open onOpenChange={(v) => !v && onClose()} title="Відхилити KYC" size="lg">
      <div className="space-y-5">
        <div className="border border-hairline rounded-[var(--radius-sm)] bg-canvas px-4 py-3 flex items-center gap-3">
          <Avatar
            src={row.provider?.avatar_url}
            alt={row.legal_name}
            size="sm"
          />
          <div className="min-w-0">
            <div className="text-body text-ink truncate">{row.legal_name}</div>
            <div className="text-caption text-muted truncate">
              {row.provider?.email}
            </div>
          </div>
        </div>

        <div>
          <div className="block text-caption text-ink-soft mb-2">
            Причина відхилення
          </div>
          <RadioCardGroup
            value={code}
            onChange={(v) => setCode(v as RejectionCode)}
            columns={2}
            options={REJECTION_CODES.map((c) => ({
              id: c,
              label: REJECTION_LABELS[c],
            }))}
          />
        </div>

        <label className="block">
          <span className="block text-caption text-ink-soft mb-1.5">
            Деталі (необовʼязково — буде у журналі)
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-hairline bg-paper text-body text-ink focus:outline-none focus:border-accent"
            placeholder="Опціонально"
          />
        </label>

        {err && <InlineAlert tone="danger">{err}</InlineAlert>}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Скасувати
          </Button>
          <Button variant="danger" onClick={submit} disabled={busy}>
            {busy ? "…" : "Відхилити"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
