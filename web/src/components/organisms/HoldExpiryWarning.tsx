import * as React from "react";
import { Clock, ArrowRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { MoneyDisplay } from "@/components/ui/MoneyInput";
import { Button } from "@/components/ui/Button";

/**
 * Per Module 11 v1.2 + Deal v1.2: payment.hold_expiring (T-24h) +
 * deal.escrow_hold_warning. Banner розміщується на сторінці угоди
 * або у inbox як urgent action item.
 */
type HoldExpiryWarningProps = {
  /** Скільки годин до спливу */
  hoursRemaining: number;
  /** Сума заблокованих коштів, копійки */
  amountKopecks: number;
  /** ID угоди для CTA */
  dealId: string;
  /** Виконавець кому будуть проблеми */
  affects?: "client" | "provider";
  onApprove?: () => void;
  onCancel?: () => void;
  className?: string;
};

export function HoldExpiryWarning({
  hoursRemaining,
  amountKopecks,
  dealId,
  affects = "client",
  onApprove,
  onCancel,
  className,
}: HoldExpiryWarningProps) {
  const urgent = hoursRemaining <= 6;
  return (
    <section
      role="alert"
      className={cn(
        "rounded-[var(--radius-md)] border-2 p-5 md:p-6",
        urgent
          ? "border-danger bg-danger-soft"
          : "border-warning bg-warning-soft",
        className
      )}
    >
      <div className="flex items-start gap-4">
        <span
          className={cn(
            "shrink-0 inline-flex h-12 w-12 items-center justify-center rounded-[var(--radius-md)]",
            urgent ? "bg-danger text-paper" : "bg-warning text-paper"
          )}
        >
          <Clock size={22} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-mono text-micro uppercase tracking-loose text-ink-soft">
            угода DLR-{dealId} · ескроу спливає
          </p>
          <h3 className="font-display text-h2 text-ink tracking-tight leading-tight mt-1">
            {hoursRemaining < 1 ? (
              <>Менше години до повернення коштів</>
            ) : (
              <>
                {hoursRemaining} год до{" "}
                {affects === "client" ? "повернення" : "автоматичного скасування"}
              </>
            )}
          </h3>
          <p className="text-body text-ink-soft leading-relaxed mt-2 max-w-xl">
            {affects === "client" ? (
              <>
                Якщо до спливу строку клієнт не підтвердить роботу, ескроу-холд PSP
                автоматично закриється і кошти{" "}
                <MoneyDisplay kopecks={amountKopecks} emphasize /> повернуться вам.
                Угоду буде скасовано автоматично.
              </>
            ) : (
              <>
                Підтвердіть роботу або відкрийте спір. Інакше угоду буде скасовано
                і кошти{" "}
                <MoneyDisplay kopecks={amountKopecks} emphasize /> повернуться клієнту.
              </>
            )}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {onApprove && (
              <Button onClick={onApprove} rightIcon={<ArrowRight size={14} />}>
                {affects === "client" ? "Підтвердити роботу" : "Відкрити угоду"}
              </Button>
            )}
            {onCancel && (
              <Button variant="ghost" onClick={onCancel}>
                Скасувати самому
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
