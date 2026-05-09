"use client";
import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/cn";

export function TooltipProvider({ children, delayDuration = 200 }: { children: React.ReactNode; delayDuration?: number }) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration}>{children}</TooltipPrimitive.Provider>;
}

type TooltipProps = {
  children: React.ReactElement;
  content: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  shortcut?: string;
};

export function Tooltip({ children, content, side = "top", align = "center", shortcut }: TooltipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          className={cn(
            "z-[var(--z-dropdown)] inline-flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] bg-ink text-paper text-caption shadow-md data-[state=delayed-open]:animate-in data-[state=closed]:animate-out fade-in-0 fade-out-0"
          )}
        >
          <span>{content}</span>
          {shortcut && (
            <span className="font-mono text-micro text-muted-soft uppercase tracking-loose">
              {shortcut}
            </span>
          )}
          <TooltipPrimitive.Arrow className="fill-ink" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
