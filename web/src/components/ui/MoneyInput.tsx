"use client";
import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * MoneyInput — UAH-only, тримає значення в kopecks (BIGINT) як єдину канонічну
 * форму. Використовується скрізь де ціна / гонорар / refund / payout.
 *
 * Конвенція проекту (CLAUDE.md): "Money is stored as integer minor units (cents),
 * never floats." Цей компонент гарантує цю інваріанту на UI боці.
 */
export type MoneyInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange" | "size" | "type"
> & {
  /** Значення в копійках (BIGINT-сумісний integer). undefined = пусто. */
  valueKopecks?: number | null;
  defaultValueKopecks?: number | null;
  onChangeKopecks?: (kopecks: number | null) => void;
  size?: "sm" | "md" | "lg";
  tone?: "neutral" | "error" | "success";
  /** min/max в копійках */
  minKopecks?: number;
  maxKopecks?: number;
  showCurrencySymbol?: boolean;
};

const KOP_NBSP = " "; // narrow no-break space як thousand separator (UA convention)
const FRAC_SEP = ",";

function format(kopecks: number | null | undefined, withSymbol: boolean): string {
  if (kopecks == null || Number.isNaN(kopecks)) return "";
  const sign = kopecks < 0 ? "-" : "";
  const abs = Math.abs(kopecks);
  const hrn = Math.floor(abs / 100);
  const cop = abs % 100;
  const hrnStr = hrn.toString().replace(/\B(?=(\d{3})+(?!\d))/g, KOP_NBSP);
  const out = `${sign}${hrnStr}${FRAC_SEP}${cop.toString().padStart(2, "0")}`;
  return withSymbol ? `${out}${KOP_NBSP}₴` : out;
}

function parse(input: string): number | null {
  const cleaned = input.replace(/[^\d,.\-]/g, "").replace(/\./g, ",");
  if (!cleaned || cleaned === "-") return null;
  const [intPart, fracRaw = ""] = cleaned.split(",");
  const frac = (fracRaw + "00").slice(0, 2);
  const sign = intPart.startsWith("-") ? -1 : 1;
  const intDigits = intPart.replace(/-/g, "");
  if (!intDigits && !fracRaw) return null;
  const k = sign * (Number(intDigits || "0") * 100 + Number(frac));
  return Number.isFinite(k) ? k : null;
}

export const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(
  function MoneyInput(
    {
      valueKopecks,
      defaultValueKopecks,
      onChangeKopecks,
      size = "md",
      tone = "neutral",
      minKopecks,
      maxKopecks,
      showCurrencySymbol = true,
      className,
      onBlur,
      onFocus,
      ...rest
    },
    ref
  ) {
    const isControlled = valueKopecks !== undefined;
    const [internal, setInternal] = React.useState<number | null>(
      defaultValueKopecks ?? null
    );
    const k = isControlled ? valueKopecks ?? null : internal;
    const [text, setText] = React.useState(format(k, false));
    const [focused, setFocused] = React.useState(false);

    React.useEffect(() => {
      if (!focused) setText(format(k, false));
    }, [k, focused]);

    function commit(next: number | null) {
      let n = next;
      if (n != null) {
        if (typeof minKopecks === "number" && n < minKopecks) n = minKopecks;
        if (typeof maxKopecks === "number" && n > maxKopecks) n = maxKopecks;
      }
      if (!isControlled) setInternal(n);
      onChangeKopecks?.(n);
    }

    const sizeCls =
      size === "sm"
        ? "h-8 text-caption px-3"
        : size === "lg"
          ? "h-12 text-body-lg px-4"
          : "h-10 text-body px-3";

    const borderTone =
      tone === "error"
        ? "border-danger focus-within:border-danger"
        : tone === "success"
          ? "border-success focus-within:border-success"
          : "border-hairline-strong focus-within:border-ink";

    return (
      <div
        className={cn(
          "flex items-stretch w-full bg-paper border rounded-[var(--radius-sm)] transition-colors",
          borderTone,
          className
        )}
      >
        <input
          ref={ref}
          inputMode="decimal"
          value={focused ? text : format(k, false)}
          onChange={(e) => {
            setText(e.target.value);
            commit(parse(e.target.value));
          }}
          onFocus={(e) => {
            setFocused(true);
            setText(format(k, false));
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            const parsed = parse(text);
            commit(parsed);
            setText(format(parsed, false));
            onBlur?.(e);
          }}
          className={cn(
            "flex-1 bg-transparent border-0 outline-none text-ink placeholder:text-muted-soft font-mono tabular-nums",
            sizeCls
          )}
          {...rest}
        />
        {showCurrencySymbol && (
          <span className="flex items-center pr-3 pl-1 font-mono text-muted shrink-0">
            ₴
          </span>
        )}
      </div>
    );
  }
);

/** Read-only display, узгоджений з MoneyInput-форматтером. */
export function MoneyDisplay({
  kopecks,
  showSymbol = true,
  className,
  emphasize,
}: {
  kopecks: number | null | undefined;
  showSymbol?: boolean;
  className?: string;
  emphasize?: boolean;
}) {
  return (
    <span
      className={cn(
        "font-mono tabular-nums",
        emphasize && "font-display text-ink",
        className
      )}
    >
      {format(kopecks, showSymbol)}
    </span>
  );
}

export const moneyFormat = format;
export const moneyParse = parse;
