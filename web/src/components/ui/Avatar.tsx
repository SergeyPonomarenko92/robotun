import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const avatarStyles = cva(
  "relative inline-flex items-center justify-center font-sans font-medium bg-canvas text-ink-soft overflow-hidden border border-hairline shrink-0",
  {
    variants: {
      size: {
        xs: "h-6 w-6 text-[10px] rounded-[var(--radius-xs)]",
        sm: "h-8 w-8 text-caption rounded-[var(--radius-sm)]",
        md: "h-10 w-10 text-body rounded-[var(--radius-sm)]",
        lg: "h-14 w-14 text-body-lg rounded-[var(--radius-md)]",
        xl: "h-24 w-24 text-h3 rounded-[var(--radius-md)]",
      },
      shape: {
        square: "",
        circle: "rounded-full!",
      },
    },
    defaultVariants: { size: "md", shape: "square" },
  }
);

type AvatarProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof avatarStyles> & {
    src?: string;
    alt?: string;
    initials?: string;
    kycVerified?: boolean;
    online?: boolean;
  };

function getInitials(name?: string) {
  if (!name) return "—";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export const Avatar = React.forwardRef<HTMLSpanElement, AvatarProps>(
  ({ className, size, shape, src, alt, initials, kycVerified, online, ...props }, ref) => {
    const label = initials ?? getInitials(alt);
    return (
      <span
        ref={ref}
        className={cn(avatarStyles({ size, shape }), "relative", className)}
        {...props}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={alt ?? ""} className="h-full w-full object-cover" />
        ) : (
          <span aria-hidden>{label}</span>
        )}
        {kycVerified && (
          <span
            title="KYC підтверджено"
            aria-label="KYC підтверджено"
            className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center h-4 w-4 rounded-full bg-success text-paper text-[8px] border-2 border-paper"
          >
            ✓
          </span>
        )}
        {online && (
          <span
            aria-hidden
            className="absolute top-0 right-0 h-2.5 w-2.5 rounded-full bg-success border-2 border-paper"
          />
        )}
      </span>
    );
  }
);
Avatar.displayName = "Avatar";
