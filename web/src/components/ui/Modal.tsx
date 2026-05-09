"use client";
import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

const sizeMap = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
} as const;

type ModalProps = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: keyof typeof sizeMap;
  /** Якщо true — заборонити закриття поза-кліком/Esc (для destructive confirms) */
  modalLock?: boolean;
};

export function Modal({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  size = "md",
  modalLock,
}: ModalProps) {
  return (
    <Dialog.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-overlay)] bg-ink/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in data-[state=closed]:fade-out" />
        <Dialog.Content
          onPointerDownOutside={modalLock ? (e) => e.preventDefault() : undefined}
          onEscapeKeyDown={modalLock ? (e) => e.preventDefault() : undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-[var(--z-modal)] -translate-x-1/2 -translate-y-1/2 w-[calc(100vw-2rem)] bg-paper border border-hairline-strong rounded-[var(--radius-lg)] shadow-pop p-6 md:p-8 focus:outline-none",
            sizeMap[size]
          )}
        >
          <div className="flex items-start justify-between gap-6 mb-4">
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
            {!modalLock && (
              <Dialog.Close
                aria-label="Закрити"
                className="-mt-1 -mr-1 inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-muted hover:bg-canvas hover:text-ink transition-colors"
              >
                <X size={18} />
              </Dialog.Close>
            )}
          </div>
          {children && <div className="text-body text-ink-soft">{children}</div>}
          {footer && (
            <div className="mt-6 flex flex-wrap items-center justify-end gap-2 pt-5 border-t border-hairline">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const ModalClose = Dialog.Close;
