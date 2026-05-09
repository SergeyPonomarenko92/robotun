import * as React from "react";
import { ShieldAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";

/**
 * Per Module 10 §4.6 — після N detections (5/7d) система авто-блокує канал;
 * перший auto-block потребує admin confirm. Banner показується або як warning
 * (близько до threshold), або як hard block (вже заблоковано).
 */
type Mode = "warning" | "blocked_pending_admin" | "blocked";

const META: Record<
  Mode,
  { tone: "warning" | "danger" | "info"; title: string; desc: string }
> = {
  warning: {
    tone: "warning",
    title: "Помітили обмін контактними даними",
    desc:
      "Безпечні угоди живуть у Robotun. Поза платформою ескроу не діє, а гарантія втрачається. Ще %N% таких випадків — і чат буде автоматично заблоковано.",
  },
  blocked_pending_admin: {
    tone: "warning",
    title: "Чат призупинено — очікуємо рішення модератора",
    desc:
      "Це перший випадок автоблокування для цього користувача. Модератор підтвердить блокування протягом 24 годин.",
  },
  blocked: {
    tone: "danger",
    title: "Чат автоматично заблоковано",
    desc:
      "Виявлено повторний обмін контактними даними. Для відновлення зв’язку зверніться в підтримку.",
  },
};

const TONE_CLS: Record<"warning" | "danger" | "info", string> = {
  warning: "border-warning bg-warning-soft text-warning",
  danger: "border-danger bg-danger-soft text-danger",
  info: "border-info bg-info-soft text-info",
};

type ContactInfoBlockBannerProps = {
  mode: Mode;
  /** Скільки попереджень залишилось (для warning) */
  remaining?: number;
  onAppeal?: () => void;
  className?: string;
};

export function ContactInfoBlockBanner({
  mode,
  remaining = 2,
  onAppeal,
  className,
}: ContactInfoBlockBannerProps) {
  const m = META[mode];
  const desc = m.desc.replace("%N%", String(remaining));
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 p-4 border-2 rounded-[var(--radius-md)]",
        TONE_CLS[m.tone],
        className
      )}
    >
      <ShieldAlert size={20} className="shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="font-display text-body-lg text-ink tracking-tight">{m.title}</p>
        <p className="text-caption text-ink-soft leading-relaxed mt-1">{desc}</p>
        {(mode === "blocked" || mode === "blocked_pending_admin") && onAppeal && (
          <Button size="sm" variant="secondary" onClick={onAppeal} className="mt-3">
            Звернутись в підтримку
          </Button>
        )}
      </div>
    </div>
  );
}
