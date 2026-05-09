import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const buttonStyles = cva(
  "inline-flex items-center justify-center gap-2 select-none whitespace-nowrap font-sans font-medium transition-[background,color,border,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50 disabled:cursor-not-allowed active:translate-y-[0.5px]",
  {
    variants: {
      variant: {
        primary:
          "bg-ink text-paper hover:bg-ink-soft border border-ink",
        secondary:
          "bg-paper text-ink border border-hairline-strong hover:border-ink hover:bg-elevated",
        accent:
          "bg-accent text-paper hover:bg-accent-hover border border-accent",
        ghost:
          "bg-transparent text-ink hover:bg-accent-soft border border-transparent",
        danger:
          "bg-danger text-paper hover:opacity-90 border border-danger",
        link:
          "bg-transparent text-ink underline underline-offset-4 decoration-1 hover:decoration-2 px-0 py-0 border-0",
      },
      size: {
        sm: "h-8 px-3 text-caption rounded-[var(--radius-sm)]",
        md: "h-10 px-4 text-body rounded-[var(--radius-sm)]",
        lg: "h-12 px-6 text-body-lg rounded-[var(--radius-md)]",
        icon: "h-10 w-10 p-0 rounded-[var(--radius-sm)]",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
);

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonStyles> & {
    loading?: boolean;
    leftIcon?: React.ReactNode;
    rightIcon?: React.ReactNode;
  };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, leftIcon, rightIcon, children, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(buttonStyles({ variant, size }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? (
          <span
            className="h-4 w-4 rounded-full border-2 border-current border-r-transparent animate-spin"
            aria-hidden
          />
        ) : (
          leftIcon
        )}
        {children}
        {!loading && rightIcon}
      </button>
    );
  }
);
Button.displayName = "Button";
