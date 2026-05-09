import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const inputStyles = cva(
  "block w-full font-sans bg-paper text-ink placeholder:text-muted-soft border transition-[border,background] duration-[var(--duration-fast)] ease-[var(--ease-standard)] focus:outline-none focus:border-ink disabled:opacity-50 disabled:cursor-not-allowed read-only:bg-canvas",
  {
    variants: {
      size: {
        sm: "h-8 px-3 text-caption rounded-[var(--radius-sm)]",
        md: "h-10 px-3 text-body rounded-[var(--radius-sm)]",
        lg: "h-12 px-4 text-body-lg rounded-[var(--radius-md)]",
      },
      tone: {
        neutral: "border-hairline-strong",
        error: "border-danger focus:border-danger",
        success: "border-success focus:border-success",
      },
    },
    defaultVariants: { size: "md", tone: "neutral" },
  }
);

type InputBase = Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">;

type InputProps = InputBase &
  VariantProps<typeof inputStyles> & {
    leftAddon?: React.ReactNode;
    rightAddon?: React.ReactNode;
  };

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, size, tone, leftAddon, rightAddon, ...props }, ref) => {
    if (!leftAddon && !rightAddon) {
      return <input ref={ref} className={cn(inputStyles({ size, tone }), className)} {...props} />;
    }
    return (
      <div
        className={cn(
          "flex items-stretch w-full bg-paper border rounded-[var(--radius-sm)] focus-within:border-ink",
          tone === "error" && "border-danger focus-within:border-danger",
          tone === "success" && "border-success focus-within:border-success",
          (!tone || tone === "neutral") && "border-hairline-strong"
        )}
      >
        {leftAddon && (
          <span className="flex items-center pl-3 pr-2 text-muted">{leftAddon}</span>
        )}
        <input
          ref={ref}
          className={cn(
            "flex-1 bg-transparent border-0 outline-none text-ink placeholder:text-muted-soft font-sans",
            size === "sm" ? "h-8 text-caption px-2" : size === "lg" ? "h-12 text-body-lg px-3" : "h-10 text-body px-2",
            className
          )}
          {...props}
        />
        {rightAddon && (
          <span className="flex items-center pr-3 pl-2 text-muted">{rightAddon}</span>
        )}
      </div>
    );
  }
);
Input.displayName = "Input";
