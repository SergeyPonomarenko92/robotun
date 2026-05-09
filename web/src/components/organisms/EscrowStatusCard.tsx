import * as React from "react";
import { Lock, ShieldCheck, ShieldAlert, RotateCcw, Clock } from "lucide-react";
import { cn } from "@/lib/cn";
import { MoneyDisplay } from "@/components/ui/MoneyInput";

/**
 * Per Deal spec §4.1 escrow_status:
 *   not_required → hold_requested → held → release_requested → released
 *                                       ↘ refund_requested → refunded
 * Plus v1.2 hold_cap_reached (PSP signals expiry → cancel).
 */
export type EscrowStatus =
  | "not_required"
  | "hold_requested"
  | "held"
  | "release_requested"
  | "released"
  | "refund_requested"
  | "refunded";

const STATUS_META: Record<
  EscrowStatus,
  { icon: React.ReactNode; label: string; tone: "neutral" | "info" | "warning" | "success" | "danger" }
> = {
  not_required: { icon: <ShieldCheck size={16} />, label: "Не потрібно", tone: "neutral" },
  hold_requested: { icon: <Clock size={16} />, label: "Очікуємо PSP", tone: "info" },
  held: { icon: <Lock size={16} />, label: "Заблоковано на ескроу", tone: "info" },
  release_requested: { icon: <ShieldCheck size={16} />, label: "Виплата ініційована", tone: "warning" },
  released: { icon: <ShieldCheck size={16} />, label: "Виплачено провайдеру", tone: "success" },
  refund_requested: { icon: <RotateCcw size={16} />, label: "Повернення ініційовано", tone: "warning" },
  refunded: { icon: <ShieldAlert size={16} />, label: "Повернено клієнту", tone: "danger" },
};

const TONE_BG: Record<"neutral" | "info" | "warning" | "success" | "danger", string> = {
  neutral: "bg-canvas border-hairline-strong text-ink-soft",
  info: "bg-info-soft/40 border-info text-info",
  warning: "bg-warning-soft border-warning text-warning",
  success: "bg-success-soft border-success text-success",
  danger: "bg-danger-soft border-danger text-danger",
};

type EscrowStatusCardProps = {
  status: EscrowStatus;
  amountKopecks: number;
  currency?: string;
  /** ISO */
  heldAt?: string | null;
  /** ISO; T-24h shows warning */
  holdExpiresAt?: string | null;
  /** PSP назва — LiqPay (default) / Fondy / Stripe */
  psp?: string;
  className?: string;
};

function timeUntil(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { text: "вже минув", urgent: true };
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return { text: `за ${hours} год`, urgent: hours < 24 };
  const days = Math.floor(hours / 24);
  return { text: `за ${days} дн`, urgent: false };
}

export function EscrowStatusCard({
  status,
  amountKopecks,
  heldAt,
  holdExpiresAt,
  psp = "LiqPay",
  className,
}: EscrowStatusCardProps) {
  const meta = STATUS_META[status];
  const expiry = holdExpiresAt ? timeUntil(holdExpiresAt) : null;

  return (
    <section
      className={cn(
        "rounded-[var(--radius-md)] border p-5 md:p-6",
        TONE_BG[meta.tone],
        className
      )}
    >
      <div className="flex items-start justify-between gap-4 mb-4">
        <p className="font-mono text-micro uppercase tracking-loose opacity-90">
          Ескроу
        </p>
        <span className="inline-flex items-center gap-1.5 text-caption font-medium opacity-90">
          {meta.icon}
          {meta.label}
        </span>
      </div>
      <p className="font-display text-h1 text-ink tracking-tight leading-none tabular-nums">
        <MoneyDisplay kopecks={amountKopecks} />
      </p>
      <dl className="mt-5 grid grid-cols-2 gap-y-2 text-caption">
        <dt className="font-mono text-micro uppercase tracking-loose text-muted-soft">
          PSP
        </dt>
        <dd className="text-ink-soft text-right font-mono">{psp}</dd>
        {heldAt && (
          <>
            <dt className="font-mono text-micro uppercase tracking-loose text-muted-soft">
              Заблоковано
            </dt>
            <dd className="text-ink-soft text-right font-mono tabular-nums">
              {new Date(heldAt).toLocaleDateString("uk-UA", { day: "numeric", month: "short", year: "numeric" })}
            </dd>
          </>
        )}
        {holdExpiresAt && expiry && (
          <>
            <dt className="font-mono text-micro uppercase tracking-loose text-muted-soft">
              Спливає
            </dt>
            <dd
              className={cn(
                "text-right font-mono tabular-nums",
                expiry.urgent ? "text-warning font-medium" : "text-ink-soft"
              )}
            >
              {expiry.text}
            </dd>
          </>
        )}
      </dl>
      <p className="mt-5 pt-4 border-t border-current/15 text-caption text-ink-soft leading-relaxed">
        Кошти зберігаються на ескроу-рахунку{" "}
        {psp} і не доступні жодній зі сторін до завершення угоди.
      </p>
    </section>
  );
}
