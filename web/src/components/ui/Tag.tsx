"use client";
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const tagStyles = cva(
  "inline-flex items-center gap-1.5 font-sans transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
  {
    variants: {
      variant: {
        outline:
          "bg-paper text-ink border border-hairline-strong hover:border-ink",
        soft:
          "bg-canvas text-ink-soft border border-hairline hover:bg-elevated",
        accent:
          "bg-accent-soft text-accent-hover border border-accent",
      },
      size: {
        sm: "h-7 px-2.5 text-caption rounded-[var(--radius-pill)]",
        md: "h-8 px-3 text-body rounded-[var(--radius-pill)]",
      },
      selected: {
        true: "bg-ink! text-paper! border-ink!",
        false: "",
      },
      interactive: {
        true: "cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
        false: "",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "md",
      selected: false,
      interactive: false,
    },
  }
);

type TagProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof tagStyles> & {
    onRemove?: () => void;
    leftIcon?: React.ReactNode;
  };

export const Tag = React.forwardRef<HTMLSpanElement, TagProps>(
  ({ className, variant, size, selected, interactive, onRemove, leftIcon, children, ...props }, ref) => {
    const isInteractive = interactive ?? !!props.onClick;
    return (
      <span
        ref={ref}
        role={isInteractive ? "button" : undefined}
        tabIndex={isInteractive ? 0 : undefined}
        className={cn(tagStyles({ variant, size, selected, interactive: isInteractive }), className)}
        {...props}
      >
        {leftIcon && <span aria-hidden className="text-muted">{leftIcon}</span>}
        {children}
        {onRemove && (
          <button
            type="button"
            aria-label="Прибрати"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="ml-0.5 -mr-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-current opacity-60 hover:opacity-100 hover:bg-current/10"
          >
            ×
          </button>
        )}
      </span>
    );
  }
);
Tag.displayName = "Tag";
