import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badgeStyles = cva(
  "inline-flex items-center gap-1 font-sans font-medium tracking-wide uppercase",
  {
    variants: {
      tone: {
        neutral: "bg-canvas text-ink-soft border border-hairline-strong",
        accent: "bg-accent-soft text-accent-hover border border-accent",
        success: "bg-success-soft text-success border border-success",
        warning: "bg-warning-soft text-warning border border-warning",
        danger: "bg-danger-soft text-danger border border-danger",
        info: "bg-info-soft text-info border border-info",
        ink: "bg-ink text-paper border border-ink",
      },
      shape: {
        pill: "rounded-[var(--radius-pill)]",
        square: "rounded-[var(--radius-xs)]",
      },
      size: {
        sm: "h-5 px-1.5 text-[10px]",
        md: "h-6 px-2 text-[11px]",
      },
      withDot: { true: "", false: "" },
    },
    defaultVariants: { tone: "neutral", shape: "pill", size: "md", withDot: false },
  }
);

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeStyles>;

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, tone, shape, size, withDot, children, ...props }, ref) => {
    return (
      <span
        ref={ref}
        className={cn(badgeStyles({ tone, shape, size, withDot }), className)}
        {...props}
      >
        {withDot && (
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full bg-current"
          />
        )}
        {children}
      </span>
    );
  }
);
Badge.displayName = "Badge";
