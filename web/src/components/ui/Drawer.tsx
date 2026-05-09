"use client";
import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

type Side = "right" | "left" | "bottom";

const SIDE_CLS: Record<Side, string> = {
  right:
    "right-0 top-0 h-full w-[min(420px,100vw)] data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
  left:
    "left-0 top-0 h-full w-[min(420px,100vw)] data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
  bottom:
    "left-0 right-0 bottom-0 max-h-[90vh] w-full rounded-t-[var(--radius-lg)] data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
};

type DrawerProps = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  side?: Side;
  children?: React.ReactNode;
  footer?: React.ReactNode;
};

export function Drawer({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  side = "right",
  children,
  footer,
}: DrawerProps) {
  return (
    <Dialog.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-overlay)] bg-ink/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in data-[state=closed]:fade-out" />
        <Dialog.Content
          className={cn(
            "fixed z-[var(--z-modal)] bg-paper border-hairline-strong shadow-pop flex flex-col focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out",
            side === "bottom" ? "border-t" : side === "right" ? "border-l" : "border-r",
            SIDE_CLS[side]
          )}
        >
          <header className="flex items-start justify-between gap-6 p-6 pb-4 border-b border-hairline">
            <div>
              <Dialog.Title className="font-display text-h3 text-ink tracking-tight">
                {title}
              </Dialog.Title>
              {description && (
                <Dialog.Description className="mt-1.5 text-body text-muted leading-relaxed">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close
              aria-label="Закрити"
              className="-mt-1 -mr-1 inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-muted hover:bg-canvas hover:text-ink transition-colors"
            >
              <X size={18} />
            </Dialog.Close>
          </header>
          <div className="flex-1 overflow-y-auto p-6 text-body text-ink-soft">
            {children}
          </div>
          {footer && (
            <footer className="flex flex-wrap items-center justify-end gap-2 p-6 pt-4 border-t border-hairline">
              {footer}
            </footer>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const DrawerClose = Dialog.Close;
