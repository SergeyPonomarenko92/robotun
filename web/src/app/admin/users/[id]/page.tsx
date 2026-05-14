"use client";
import * as React from "react";
import { use as usePromise } from "react";
import Link from "next/link";
import { ArrowLeft, AlertTriangle, Loader2, ShieldOff, ShieldCheck } from "lucide-react";

import { AdminShell } from "@/components/organisms/AdminShell";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { MoneyDisplay } from "@/components/ui/MoneyInput";
import {
  useAdminUser,
  suspendUser,
  unsuspendUser,
  type AdminUserStatus,
  type AdminUserDetail,
} from "@/lib/admin-users";
import { createMfaChallenge, type MfaChallenge } from "@/lib/deals";

const STATUS_LABEL: Record<AdminUserStatus, string> = {
  active: "Активний",
  pending: "Очікує підтвердження",
  suspended: "Зупинений",
  deleted: "Видалений",
};
const STATUS_TONE: Record<AdminUserStatus, "success" | "warning" | "danger" | "neutral"> = {
  active: "success",
  pending: "warning",
  suspended: "danger",
  deleted: "neutral",
};

type PageProps = { params: Promise<{ id: string }> };

export default function AdminUserDetailPage({ params }: PageProps) {
  const { id } = usePromise(params);
  const { data, error, refresh } = useAdminUser(id);
  const [modalKind, setModalKind] = React.useState<
    null | "suspend" | "unsuspend"
  >(null);

  return (
    <AdminShell
      kicker="Адмін · Користувачі"
      title={
        <>
          {data ? (
            <>
              {data.display_name}
              <br />
              <span className="text-ink-soft italic text-h2">{data.email}</span>
            </>
          ) : (
            <>Завантаження…</>
          )}
        </>
      }
      sidecar={
        <Link
          href="/admin/users"
          className="inline-flex items-center gap-2 text-caption text-ink-soft hover:text-ink"
        >
          <ArrowLeft size={14} aria-hidden /> До каталогу
        </Link>
      }
    >
      {error ? (
        <ErrorBlock
          status={error.status}
          message={error.message}
          onRetry={refresh}
        />
      ) : !data ? (
        <div className="mt-8 flex justify-center py-16">
          <Loader2 size={20} className="animate-spin text-muted" aria-hidden />
        </div>
      ) : (
        <UserBody
          user={data}
          onSuspend={() => setModalKind("suspend")}
          onUnsuspend={() => setModalKind("unsuspend")}
        />
      )}
      {data && modalKind && (
        <SuspensionModal
          kind={modalKind}
          user={data}
          onClose={() => setModalKind(null)}
          onDone={() => {
            setModalKind(null);
            refresh();
          }}
        />
      )}
    </AdminShell>
  );
}

function SuspensionModal({
  kind,
  user,
  onClose,
  onDone,
}: {
  kind: "suspend" | "unsuspend";
  user: AdminUserDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = React.useState<"reason" | "mfa">("reason");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [challenge, setChallenge] = React.useState<MfaChallenge | null>(null);
  const [code, setCode] = React.useState("");

  const isSuspend = kind === "suspend";
  const title = isSuspend ? "Зупинити обліковий запис" : "Поновити обліковий запис";
  const submitLabel = isSuspend ? "Зупинити" : "Поновити";
  const action = isSuspend ? suspendUser : unsuspendUser;

  const issueMfa = async () => {
    if (busy || reason.trim().length < 10) {
      setErr("Причина має містити мінімум 10 символів");
      return;
    }
    setBusy(true);
    setErr(null);
    const r = await createMfaChallenge();
    setBusy(false);
    if (r.ok) {
      setChallenge(r.challenge);
      setCode("");
      setStep("mfa");
    } else {
      setErr(r.error.message);
    }
  };

  const submit = async () => {
    if (busy || !challenge || code.length !== 6) return;
    setBusy(true);
    setErr(null);
    const r = await action(user.id, {
      reason: reason.trim(),
      mfa_challenge_id: challenge.id,
      mfa_code: code,
    });
    setBusy(false);
    if (r.ok) {
      onDone();
      return;
    }
    setErr(r.error.message);
    if (r.error.step === "mfa") {
      // Burnt / expired code → return to step 1, force re-issue.
      setStep("reason");
      setChallenge(null);
      setCode("");
    }
  };

  return (
    <Modal open onOpenChange={(v) => !v && onClose()} title={title} size="md">
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <Avatar src={user.avatar_url} alt={user.display_name} size="sm" />
          <div>
            <div className="text-body text-ink">{user.display_name}</div>
            <div className="text-caption text-muted">{user.email}</div>
          </div>
        </div>

        {step === "reason" ? (
          <div className="space-y-3">
            <label className="block">
              <span className="block text-caption text-ink-soft mb-1.5">
                Причина {isSuspend ? "зупинки" : "поновлення"} (буде записано
                в журнал)
              </span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-hairline bg-paper text-body text-ink focus:outline-none focus:border-accent"
                placeholder="Мінімум 10 символів"
                aria-label="Причина"
              />
            </label>
            {err && <InlineAlert tone="danger">{err}</InlineAlert>}
          </div>
        ) : (
          <div className="space-y-3">
            <InlineAlert tone="info">
              Введіть 6-значний код з MFA-додатку.{" "}
              {challenge?.code && (
                <>
                  <span className="font-mono">DEMO:</span>{" "}
                  <code className="font-mono text-ink">{challenge.code}</code>
                </>
              )}
            </InlineAlert>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="w-full px-3 py-2 font-mono text-h3 tracking-[0.4em] text-center rounded-[var(--radius-sm)] border border-hairline bg-paper text-ink focus:outline-none focus:border-accent"
              aria-label="6-значний MFA-код"
              placeholder="••••••"
            />
            {err && <InlineAlert tone="danger">{err}</InlineAlert>}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Скасувати
          </Button>
          {step === "reason" ? (
            <Button onClick={issueMfa} disabled={busy} variant={isSuspend ? "danger" : "primary"}>
              {busy ? "…" : "Далі — MFA"}
            </Button>
          ) : (
            <Button
              onClick={submit}
              disabled={busy || code.length !== 6}
              variant={isSuspend ? "danger" : "primary"}
            >
              {busy ? "…" : submitLabel}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ErrorBlock({
  status,
  message,
  onRetry,
}: {
  status: number;
  message: string;
  onRetry: () => void;
}) {
  const isNotFound = status === 404;
  return (
    <div className="mt-8 border border-danger rounded-[var(--radius-md)] bg-danger-soft p-6 flex items-start gap-3">
      <AlertTriangle size={18} className="text-danger mt-0.5" aria-hidden />
      <div className="flex-1">
        <div className="text-body text-ink">
          {isNotFound ? "Користувача не знайдено" : "Помилка завантаження"}
        </div>
        <div className="text-caption text-muted mt-1">{message}</div>
        {!isNotFound && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 text-caption text-ink underline hover:text-accent"
          >
            Спробувати знову
          </button>
        )}
      </div>
    </div>
  );
}

function UserBody({
  user,
  onSuspend,
  onUnsuspend,
}: {
  user: AdminUserDetail;
  onSuspend: () => void;
  onUnsuspend: () => void;
}) {
  return (
    <div className="mt-8 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8">
      <div className="space-y-6 min-w-0">
        {/* Identity card */}
        <section className="border border-hairline rounded-[var(--radius-md)] bg-paper p-6">
          <div className="flex items-start gap-4">
            <Avatar src={user.avatar_url} alt={user.display_name} size="lg" />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-h2 text-ink leading-tight">
                  {user.display_name}
                </h2>
                <Badge tone={STATUS_TONE[user.status]} shape="square">
                  {STATUS_LABEL[user.status]}
                </Badge>
              </div>
              <div className="text-body text-ink-soft mt-1">{user.email}</div>
              <div className="mt-3 flex flex-wrap gap-1">
                {user.roles.map((r) => (
                  <Badge key={r} tone="neutral" size="sm" shape="square">
                    {r}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 text-caption">
            <Pair k="ID" v={<code className="font-mono text-ink-soft">{user.id.slice(0, 8)}…</code>} />
            <Pair k="Зареєстрований" v={new Date(user.created_at).toLocaleString("uk-UA")} />
            <Pair k="Email перевірено" v={user.email_verified ? "так" : "ні"} />
            <Pair k="MFA увімкнено" v={user.mfa_enrolled ? "так" : "ні"} />
            <Pair k="KYC" v={user.kyc_status} />
            <Pair
              k="Виплати"
              v={user.payout_enabled ? "дозволено" : "заблоковано"}
            />
          </dl>
        </section>

        {/* Wallet (provider only) */}
        {user.wallet && (
          <section className="border border-hairline rounded-[var(--radius-md)] bg-paper p-6">
            <h3 className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
              Гаманець
            </h3>
            <div className="mt-4 grid grid-cols-3 gap-4">
              <BalanceCell
                label="Доступно"
                kopecks={user.wallet.available_kopecks}
              />
              <BalanceCell
                label="Заморожено"
                kopecks={user.wallet.held_kopecks}
              />
              <BalanceCell
                label="На виплату"
                kopecks={user.wallet.pending_payout_kopecks}
              />
            </div>
          </section>
        )}

        {/* Recent admin actions */}
        <section className="border border-hairline rounded-[var(--radius-md)] bg-paper p-6">
          <h3 className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
            Журнал дій адмінів
          </h3>
          {user.recent_admin_actions.length === 0 ? (
            <p className="mt-4 text-caption text-muted">
              Поки що жодних адмін-дій не зафіксовано.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-hairline">
              {user.recent_admin_actions.map((a) => (
                <li key={a.id} className="py-3 flex items-baseline gap-3">
                  <Badge tone="neutral" size="sm" shape="square">
                    {a.action}
                  </Badge>
                  <span className="text-caption text-muted tabular-nums">
                    {new Date(a.created_at).toLocaleString("uk-UA")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Right rail */}
      <aside className="space-y-4">
        <section className="border border-hairline rounded-[var(--radius-md)] bg-paper p-5">
          <h3 className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
            Угоди
          </h3>
          <dl className="mt-3 space-y-2 text-body">
            <CounterRow k="як клієнт" v={user.deal_counters.as_client} />
            <CounterRow k="як виконавець" v={user.deal_counters.as_provider} />
            <CounterRow
              k="активні зараз"
              v={user.deal_counters.active}
              emphasis
            />
            <CounterRow
              k="у диспуті"
              v={user.deal_counters.disputed}
              danger={user.deal_counters.disputed > 0}
            />
          </dl>
        </section>

        <section className="border border-hairline rounded-[var(--radius-md)] bg-paper p-5">
          <h3 className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
            Дії
          </h3>
          <div className="mt-3 space-y-2">
            {user.status === "suspended" ? (
              <Button
                variant="primary"
                className="w-full"
                leftIcon={<ShieldCheck size={14} />}
                onClick={onUnsuspend}
                disabled={user.roles.includes("admin")}
              >
                Поновити обліковий запис
              </Button>
            ) : (
              <Button
                variant="danger"
                className="w-full"
                leftIcon={<ShieldOff size={14} />}
                onClick={onSuspend}
                disabled={
                  user.status === "deleted" || user.roles.includes("admin")
                }
              >
                Зупинити обліковий запис
              </Button>
            )}
            <p className="text-caption text-muted">
              Дія потребує MFA-підтвердження. Журналюється у{" "}
              <code className="font-mono">admin_actions</code> з причиною.
              {user.roles.includes("admin") && (
                <span className="block mt-1 text-warning">
                  Адмін-облік не може бути зупинено цим інтерфейсом.
                </span>
              )}
            </p>
          </div>
        </section>
      </aside>
    </div>
  );
}

function Pair({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
        {k}
      </dt>
      <dd className="text-body text-ink mt-0.5">{v}</dd>
    </div>
  );
}

function CounterRow({
  k,
  v,
  emphasis,
  danger,
}: {
  k: string;
  v: number;
  emphasis?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-caption text-muted">{k}</span>
      <span
        className={
          "font-display tabular-nums " +
          (danger
            ? "text-danger text-h3"
            : emphasis
              ? "text-ink text-h3"
              : "text-ink-soft text-body-lg")
        }
      >
        {v}
      </span>
    </div>
  );
}

function BalanceCell({
  label,
  kopecks,
}: {
  label: string;
  kopecks: number;
}) {
  return (
    <div>
      <div className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
        {label}
      </div>
      <div className="mt-1 text-h3">
        <MoneyDisplay kopecks={kopecks} emphasize />
      </div>
    </div>
  );
}
