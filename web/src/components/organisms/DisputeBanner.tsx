import * as React from "react";
import { AlertTriangle, ShieldAlert, Clock } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";

/**
 * Banner показується на сторінці угоди коли deal.status='disputed' (Module 14
 * Disputes UI flow). Відображає countdown до response_due (3 дні) або
 * resolve_by (14 днів) залежно від ролі.
 */
type Mode =
  | "client_waiting_response"
  | "provider_must_respond"
  | "admin_review"
  | "resolution_published";

const META: Record<
  Mode,
  { tone: "warning" | "danger" | "info" | "success"; icon: React.ReactNode; title: string; desc: string }
> = {
  client_waiting_response: {
    tone: "warning",
    icon: <Clock size={20} />,
    title: "Спір відкрито. Очікуємо відповіді провайдера",
    desc: "Провайдер має 3 дні, щоб подати свою позицію та докази. Після цього статус оновлюється автоматично.",
  },
  provider_must_respond: {
    tone: "danger",
    icon: <AlertTriangle size={20} />,
    title: "Клієнт оспорив роботу. Потрібна ваша відповідь",
    desc: "Подайте свою версію подій і докази до кінця 3-денного вікна, інакше адмін винесе рішення без вас.",
  },
  admin_review: {
    tone: "info",
    icon: <ShieldAlert size={20} />,
    title: "Адмін розглядає докази обох сторін",
    desc: "Рішення буде опубліковано протягом 14 днів. Усі повідомлення в чаті — видимі модератору.",
  },
  resolution_published: {
    tone: "success",
    icon: <ShieldAlert size={20} />,
    title: "Рішення винесено",
    desc: "Перегляньте деталі резолюції нижче. Це остаточне рішення.",
  },
};

const TONE: Record<
  "warning" | "danger" | "info" | "success",
  string
> = {
  warning: "border-warning bg-warning-soft",
  danger: "border-danger bg-danger-soft",
  info: "border-info bg-info-soft",
  success: "border-success bg-success-soft",
};

type DisputeBannerProps = {
  mode: Mode;
  /** ISO коли треба відповісти / закінчуються вікна */
  dueAt?: string;
  /** Скільки днів залишилось — обчислюється з dueAt; передавайте якщо знаєте точно */
  daysRemaining?: number;
  hoursRemaining?: number;
  primaryAction?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  className?: string;
};

function computeRemaining(iso?: string): { days: number; hours: number } | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { days: 0, hours: 0 };
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  return { days, hours: hours - days * 24 };
}

export function DisputeBanner({
  mode,
  dueAt,
  daysRemaining,
  hoursRemaining,
  primaryAction,
  secondaryAction,
  className,
}: DisputeBannerProps) {
  const m = META[mode];
  const remaining =
    typeof daysRemaining === "number"
      ? { days: daysRemaining, hours: hoursRemaining ?? 0 }
      : computeRemaining(dueAt);

  return (
    <section
      role="status"
      className={cn(
        "rounded-[var(--radius-md)] border-2 p-5 md:p-6",
        TONE[m.tone],
        className
      )}
    >
      <div className="flex items-start gap-4">
        <span className="shrink-0 mt-0.5 text-current">{m.icon}</span>
        <div className="flex-1 min-w-0">
          <h3 className="font-display text-h3 text-ink tracking-tight leading-snug">
            {m.title}
          </h3>
          <p className="text-body text-ink-soft leading-relaxed mt-1.5">{m.desc}</p>

          {remaining && (
            <div className="mt-4 inline-flex items-center gap-3 px-3 py-2 rounded-[var(--radius-sm)] bg-paper/70 border border-current/30">
              <Clock size={16} />
              <span className="font-mono text-body tabular-nums">
                залишилось:{" "}
                <strong className="text-ink">
                  {remaining.days} дн{remaining.hours > 0 && ` ${remaining.hours} год`}
                </strong>
              </span>
            </div>
          )}

          {(primaryAction || secondaryAction) && (
            <div className="mt-5 flex flex-wrap gap-2">
              {primaryAction ?? <Button>Подати відповідь</Button>}
              {secondaryAction}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
