"use client";
import * as React from "react";
import { Loader2, Banknote, ShieldCheck, CheckCircle2 } from "lucide-react";

import { TopNav } from "@/components/organisms/TopNav";
import { Footer } from "@/components/organisms/Footer";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { ErrorState } from "@/components/ui/ErrorState";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Avatar } from "@/components/ui/Avatar";
import { MoneyDisplay } from "@/components/ui/MoneyInput";
import { EditorialPageHeader } from "@/components/organisms/EditorialPageHeader";

import { useRequireAuth } from "@/lib/auth";
import { useRouter } from "next/navigation";
import {
  useAdminPayouts,
  completePayout as completePayoutApi,
  type AdminPayoutRow,
} from "@/lib/payments";
import {
  createMfaChallenge,
  type MfaChallenge,
} from "@/lib/deals";

const STATUS_TONE: Record<
  AdminPayoutRow["status"],
  "info" | "warning" | "success" | "danger"
> = {
  requested: "info",
  processing: "warning",
  paid: "success",
  failed: "danger",
};
const STATUS_LABEL: Record<AdminPayoutRow["status"], string> = {
  requested: "запитано",
  processing: "у обробці",
  paid: "зараховано",
  failed: "помилка",
};

export default function AdminPayoutsPage() {
  const auth = useRequireAuth("/login");
  const router = useRouter();
  const list = useAdminPayouts();
  const [active, setActive] = React.useState<AdminPayoutRow | null>(null);

  React.useEffect(() => {
    if (auth && !auth.user.roles.includes("admin")) router.replace("/");
  }, [auth, router]);

  if (!auth || (auth && !auth.user.roles.includes("admin"))) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-muted" />
      </main>
    );
  }

  const pending = list.items.filter(
    (p) => p.status === "requested" || p.status === "processing"
  );

  return (
    <>
      <TopNav
        user={{
          id: auth.user.id,
          displayName: auth.user.display_name,
          email: auth.user.email,
          kycVerified: false,
          hasProviderRole: false,
        }}
      />
      <main className="mx-auto max-w-6xl px-4 md:px-6 pt-6 md:pt-10 pb-20">
        <EditorialPageHeader
          kicker="Module 11 · admin"
          title={
            <>
              Черга
              <br />
              <span className="text-accent italic">виплат</span>
            </>
          }
          description={
            list.loading
              ? "Завантажуємо чергу…"
              : pending.length === 0
                ? "Усі виплати зараховано — зараз нічого розбирати."
                : `Очікують підтвердження: ${pending.length}. Закриття вимагає MFA-коду.`
          }
          sidecar={
            <Badge tone="danger" size="sm" shape="square">
              admin · MFA
            </Badge>
          }
        />

        {list.error && (
          <div className="mb-6">
            <ErrorState
              kind="server"
              variant="inline"
              description="Не вдалось завантажити чергу виплат."
              onRetry={list.refresh}
            />
          </div>
        )}

        {list.loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[88px] border border-hairline rounded-[var(--radius-md)] bg-paper animate-pulse"
              />
            ))}
          </div>
        ) : list.items.length === 0 ? (
          <div className="border border-dashed border-hairline-strong rounded-[var(--radius-md)] bg-paper/40 p-10 text-center">
            <Banknote size={28} className="mx-auto text-muted mb-3" />
            <p className="font-display text-h3 text-ink tracking-tight">
              Виплат немає
            </p>
            <p className="text-body text-muted mt-2">
              Запити від виконавців зʼявляться тут.
            </p>
          </div>
        ) : (
          <ul className="border border-hairline rounded-[var(--radius-md)] bg-paper divide-y divide-hairline overflow-hidden">
            {list.items.map((p) => (
              <PayoutRow
                key={p.id}
                p={p}
                onComplete={
                  p.status === "requested" || p.status === "processing"
                    ? () => setActive(p)
                    : undefined
                }
              />
            ))}
          </ul>
        )}
      </main>

      {active && (
        <CompleteModal
          payout={active}
          onClose={() => setActive(null)}
          onCompleted={() => {
            setActive(null);
            list.refresh();
          }}
        />
      )}

      <Footer />
    </>
  );
}

function PayoutRow({
  p,
  onComplete,
}: {
  p: AdminPayoutRow;
  onComplete?: () => void;
}) {
  const created = new Date(p.created_at);
  return (
    <li className="px-5 md:px-6 py-4 flex items-center gap-4">
      <Avatar src={p.payee.avatar_url} alt={p.payee.display_name} size="md" />
      <div className="min-w-0 flex-1">
        <p className="font-display text-body-lg text-ink leading-tight truncate">
          {p.payee.display_name}
        </p>
        <p className="font-mono text-micro tracking-[0.18em] text-muted mt-0.5">
          ····{p.method_last4} ·{" "}
          {created.toLocaleDateString("uk-UA", { day: "numeric", month: "short" })}{" "}
          {created.toLocaleTimeString("uk-UA", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
      <Badge tone={STATUS_TONE[p.status]} size="sm" shape="square">
        {STATUS_LABEL[p.status]}
      </Badge>
      <span className="font-display text-h3 text-ink font-mono tabular-nums shrink-0">
        <MoneyDisplay kopecks={p.amount_kopecks} />
      </span>
      {onComplete ? (
        <Button
          variant="accent"
          size="sm"
          leftIcon={<CheckCircle2 size={14} />}
          onClick={onComplete}
        >
          Зарахувати
        </Button>
      ) : (
        <span className="w-[136px]" aria-hidden />
      )}
    </li>
  );
}

function CompleteModal({
  payout,
  onClose,
  onCompleted,
}: {
  payout: AdminPayoutRow;
  onClose: () => void;
  onCompleted: () => void;
}) {
  type Step = "review" | "mfa";
  const [step, setStep] = React.useState<Step>("review");
  const [challenge, setChallenge] = React.useState<MfaChallenge | null>(null);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const startMfa = async () => {
    if (busy) return;
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
    const r = await completePayoutApi(payout.id, {
      mfa_challenge_id: challenge.id,
      mfa_code: code,
    });
    setBusy(false);
    if (r.ok) {
      onCompleted();
    } else {
      setErr(r.error.message);
      const c = r.error.code;
      if (
        c === "mfa_expired" ||
        c === "mfa_consumed" ||
        c === "mfa_not_found"
      ) {
        setChallenge(null);
        setStep("review");
      }
    }
  };

  return (
    <Modal
      open={true}
      onOpenChange={(open) => !open && onClose()}
      title={
        step === "review"
          ? "Підтвердити зарахування виплати"
          : "MFA · одноразовий код"
      }
      description={
        step === "review"
          ? `${payout.payee.display_name} · ····${payout.method_last4}`
          : "Захист від помилкового та ворожого зарахування коштів."
      }
      size="md"
      footer={
        step === "review" ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Назад
            </Button>
            <Button
              variant="accent"
              loading={busy}
              onClick={startMfa}
            >
              Далі — MFA
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setStep("review");
                setErr(null);
              }}
              disabled={busy}
            >
              Назад
            </Button>
            <Button
              variant="accent"
              loading={busy}
              onClick={submit}
              disabled={code.length !== 6}
            >
              Зарахувати
            </Button>
          </>
        )
      }
    >
      {step === "review" ? (
        <div className="space-y-4">
          <div className="flex items-baseline justify-between border-b border-hairline pb-3">
            <span className="text-caption text-muted">До зарахування</span>
            <span className="font-display text-h2 text-ink font-mono tabular-nums">
              <MoneyDisplay kopecks={payout.amount_kopecks} />
            </span>
          </div>
          <p className="text-body text-ink-soft leading-relaxed">
            Кошти підуть на ····{payout.method_last4}. Після підтвердження
            запит буде позначено «зараховано», у виконавця обнулиться
            pending_payout.
          </p>
          <p className="text-caption text-muted leading-relaxed">
            Дія залишить рядок у admin_actions (тип <code className="font-mono">payout.completed</code>) і не може бути скасована.
          </p>
        </div>
      ) : (
        challenge && (
          <div className="space-y-5">
            <div className="border border-warning/40 bg-warning-soft/30 rounded-[var(--radius-sm)] p-4 flex items-start gap-3">
              <ShieldCheck size={16} className="text-warning shrink-0 mt-0.5" />
              <p className="text-caption text-ink-soft leading-relaxed">
                У проді — TOTP. Demo — код нижче.
              </p>
            </div>
            <div className="rounded-[var(--radius-sm)] border border-hairline bg-canvas p-4 text-center">
              <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted mb-2">
                Demo-код
              </p>
              <p className="font-display text-display text-ink leading-none tracking-[0.25em] tabular-nums">
                {challenge.code}
              </p>
              <p className="text-caption text-muted-soft mt-2">
                до {new Date(challenge.expires_at).toLocaleTimeString("uk-UA")}
              </p>
            </div>
            <label className="block">
              <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
                Введіть 6-значний код
              </span>
              <input
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                className="mt-2 w-full rounded-[var(--radius-sm)] border border-hairline bg-paper px-4 py-3 font-display text-h2 text-ink tracking-[0.25em] tabular-nums text-center focus:outline-none focus:border-accent placeholder:text-muted-soft"
              />
            </label>
            {err && (
              <InlineAlert tone="danger" title="MFA не пройдено">
                {err}
              </InlineAlert>
            )}
          </div>
        )
      )}
      {step === "review" && err && (
        <div className="mt-4">
          <InlineAlert tone="danger" title="Дія не виконана">{err}</InlineAlert>
        </div>
      )}
    </Modal>
  );
}
