import * as React from "react";
import { Wallet, Lock, ArrowDownToLine, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { MoneyDisplay } from "@/components/ui/MoneyInput";
import { Button } from "@/components/ui/Button";

export type WalletCardData = {
  /** Доступно для виплати, копійки */
  availableKopecks: number;
  /** На утриманні (held у відкритих угодах) */
  heldKopecks: number;
  /** В очікуванні виплати (payout requested але not yet completed) */
  pendingPayoutKopecks: number;
  currency?: string;
};

type WalletCardProps = {
  data: WalletCardData;
  /** Якщо null — KYC не пройдено, payout заблокований */
  payoutBlockedReason?: string | null;
  onPayout?: () => void;
  onTopUp?: () => void;
  className?: string;
};

export function WalletCard({
  data,
  payoutBlockedReason,
  onPayout,
  onTopUp,
  className,
}: WalletCardProps) {
  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-[var(--radius-lg)] bg-ink text-paper p-6 md:p-8",
        className
      )}
    >
      {/* Editorial decorative overlay */}
      <span
        aria-hidden
        className="absolute -top-32 -right-20 h-72 w-72 rounded-full bg-accent/30 blur-3xl"
      />
      <span
        aria-hidden
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(to right, currentColor 1px, transparent 1px)",
          backgroundSize: "32px 100%",
        }}
      />
      <header className="relative flex items-center justify-between mb-8">
        <p className="font-mono text-micro uppercase tracking-loose text-paper/60 inline-flex items-center gap-2">
          <Wallet size={14} />
          Баланс гаманця
        </p>
        <p className="font-mono text-micro tabular-nums text-paper/60">UAH</p>
      </header>
      <div className="relative">
        <p className="font-mono text-micro uppercase tracking-loose text-paper/60 mb-2">
          Доступно
        </p>
        <p className="font-display text-display text-paper tracking-tight tabular-nums leading-none">
          <MoneyDisplay kopecks={data.availableKopecks} showSymbol={false} />
          <span className="ml-2 text-h2 text-paper/40">₴</span>
        </p>
      </div>
      <dl className="relative mt-8 grid grid-cols-2 gap-6 pt-6 border-t border-paper/10">
        <div>
          <dt className="font-mono text-micro uppercase tracking-loose text-paper/60 inline-flex items-center gap-1.5">
            <Lock size={11} /> На утриманні
          </dt>
          <dd className="mt-1 font-display text-h3 text-paper tabular-nums">
            <MoneyDisplay kopecks={data.heldKopecks} />
          </dd>
        </div>
        <div>
          <dt className="font-mono text-micro uppercase tracking-loose text-paper/60 inline-flex items-center gap-1.5">
            <RotateCcw size={11} /> В очікуванні
          </dt>
          <dd className="mt-1 font-display text-h3 text-paper tabular-nums">
            <MoneyDisplay kopecks={data.pendingPayoutKopecks} />
          </dd>
        </div>
      </dl>
      <div className="relative mt-8 flex flex-wrap gap-2">
        <Button
          variant="accent"
          size="lg"
          leftIcon={<ArrowDownToLine size={16} />}
          disabled={!!payoutBlockedReason || data.availableKopecks === 0}
          onClick={onPayout}
        >
          Замовити виплату
        </Button>
        {onTopUp && (
          <Button variant="ghost" size="lg" className="text-paper hover:bg-paper/10" onClick={onTopUp}>
            Поповнити
          </Button>
        )}
      </div>
      {payoutBlockedReason && (
        <p className="relative mt-3 text-caption text-paper/70 leading-relaxed max-w-md">
          {payoutBlockedReason}
        </p>
      )}
    </section>
  );
}
