"use client";
import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/cn";

export const Tabs = TabsPrimitive.Root;

type TabsListProps = React.ComponentProps<typeof TabsPrimitive.List> & {
  variant?: "underline" | "pill";
};

export const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  TabsListProps
>(({ className, variant = "underline", ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex items-center gap-1 overflow-x-auto",
      variant === "underline" && "border-b border-hairline w-full",
      variant === "pill" && "p-1 bg-canvas rounded-[var(--radius-md)] border border-hairline",
      className
    )}
    {...props}
  />
));
TabsList.displayName = "TabsList";

type TabsTriggerProps = React.ComponentProps<typeof TabsPrimitive.Trigger> & {
  variant?: "underline" | "pill";
  count?: number;
};

export const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  TabsTriggerProps
>(({ className, variant = "underline", count, children, ...props }, ref) => {
  const base =
    "inline-flex items-center gap-2 whitespace-nowrap font-sans text-body transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";
  const v =
    variant === "underline"
      ? "px-3 py-3 -mb-px border-b-2 border-transparent text-muted hover:text-ink data-[state=active]:border-ink data-[state=active]:text-ink"
      : "px-3 py-1.5 rounded-[var(--radius-sm)] text-muted hover:text-ink data-[state=active]:bg-paper data-[state=active]:text-ink data-[state=active]:shadow-xs";
  return (
    <TabsPrimitive.Trigger ref={ref} className={cn(base, v, className)} {...props}>
      {children}
      {typeof count === "number" && (
        <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-[var(--radius-pill)] bg-canvas border border-hairline text-micro font-mono tabular-nums text-muted-soft data-[state=active]:bg-ink data-[state=active]:text-paper data-[state=active]:border-ink">
          {count}
        </span>
      )}
    </TabsPrimitive.Trigger>
  );
});
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentProps<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("focus-visible:outline-none pt-6", className)}
    {...props}
  />
));
TabsContent.displayName = "TabsContent";
