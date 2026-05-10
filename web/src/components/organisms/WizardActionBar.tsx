"use client";
import * as React from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

type WizardActionBarProps = {
  /** 1-based current step */
  index: number;
  totalSteps: number;
  /** Поточна назва кроку — рендериться у моно-полоску посередині (md+) */
  stepLabel?: React.ReactNode;
  onBack?: () => void;
  /**
   * Кнопки справа. Зазвичай: 1-2 secondary/ghost (Чернетка / Передперегляд) +
   * 1 accent (Далі / Опублікувати).
   */
  rightActions?: React.ReactNode;
  /**
   * Чи зміщувати bar над MobileTabBar (`bottom-14`) на mobile.
   * Default true.
   */
  aboveMobileTabBar?: boolean;
  className?: string;
};

export function WizardActionBar({
  index,
  totalSteps,
  stepLabel,
  onBack,
  rightActions,
  aboveMobileTabBar = true,
  className,
}: WizardActionBarProps) {
  return (
    <div
      className={cn(
        "fixed left-0 right-0 z-40 border-t border-hairline bg-paper/95 backdrop-blur-md",
        aboveMobileTabBar ? "bottom-14 md:bottom-0" : "bottom-0",
        className
      )}
    >
      <div className="mx-auto max-w-7xl px-4 md:px-6 py-3 flex items-center gap-3">
        <Button
          variant="ghost"
          leftIcon={<ArrowLeft size={14} />}
          onClick={onBack}
          disabled={index <= 1 || !onBack}
        >
          <span className="hidden sm:inline">Назад</span>
        </Button>

        <div className="hidden md:flex items-center gap-2 font-mono text-micro uppercase tracking-[0.18em] text-muted">
          <span>
            Крок {index} / {totalSteps}
          </span>
          {stepLabel && (
            <>
              <span className="h-1 w-1 rounded-full bg-hairline-strong" aria-hidden />
              <span className="text-ink-soft">{stepLabel}</span>
            </>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">{rightActions}</div>
      </div>
    </div>
  );
}
