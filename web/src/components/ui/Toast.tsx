"use client";
import * as React from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/cn";

export type ToastTone = "success" | "warning" | "danger" | "info" | "neutral";

type ToastItem = {
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  tone?: ToastTone;
  duration?: number;
  action?: { label: string; onClick: () => void };
};

type ToastCtx = {
  push: (t: Omit<ToastItem, "id">) => string;
  dismiss: (id: string) => void;
};

const Ctx = React.createContext<ToastCtx | null>(null);

const ICONS: Record<ToastTone, React.ReactNode> = {
  success: <CheckCircle2 size={18} />,
  warning: <AlertTriangle size={18} />,
  danger: <XCircle size={18} />,
  info: <Info size={18} />,
  neutral: <Info size={18} />,
};

const TONE_CLASS: Record<ToastTone, string> = {
  success: "border-success bg-success-soft text-success",
  warning: "border-warning bg-warning-soft text-warning",
  danger: "border-danger bg-danger-soft text-danger",
  info: "border-info bg-info-soft text-info",
  neutral: "border-hairline-strong bg-paper text-ink",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);

  const dismiss = React.useCallback((id: string) => {
    setItems((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const push = React.useCallback<ToastCtx["push"]>((t) => {
    const id = crypto.randomUUID();
    setItems((cur) => [...cur, { id, duration: 4500, tone: "neutral", ...t }]);
    return id;
  }, []);

  return (
    <Ctx.Provider value={{ push, dismiss }}>
      <ToastPrimitive.Provider duration={4500} swipeDirection="right">
        {children}
        {items.map((t) => {
          const tone = t.tone ?? "neutral";
          return (
            <ToastPrimitive.Root
              key={t.id}
              duration={t.duration}
              onOpenChange={(open) => {
                if (!open) dismiss(t.id);
              }}
              className={cn(
                "border rounded-[var(--radius-md)] p-4 shadow-md flex items-start gap-3 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-right-2",
                TONE_CLASS[tone]
              )}
            >
              <span className="shrink-0 mt-0.5">{ICONS[tone]}</span>
              <div className="flex-1 min-w-0">
                <ToastPrimitive.Title className="font-sans text-body font-medium text-ink">
                  {t.title}
                </ToastPrimitive.Title>
                {t.description && (
                  <ToastPrimitive.Description className="text-caption text-muted mt-0.5">
                    {t.description}
                  </ToastPrimitive.Description>
                )}
                {t.action && (
                  <ToastPrimitive.Action
                    asChild
                    altText={t.action.label}
                    onClick={t.action.onClick}
                  >
                    <button className="mt-2 text-caption font-medium underline underline-offset-2 text-ink hover:no-underline">
                      {t.action.label}
                    </button>
                  </ToastPrimitive.Action>
                )}
              </div>
              <ToastPrimitive.Close
                aria-label="Закрити"
                className="shrink-0 -mr-1 -mt-1 inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-xs)] text-current opacity-60 hover:opacity-100 hover:bg-current/10"
              >
                <X size={14} />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          );
        })}
        <ToastPrimitive.Viewport className="fixed top-4 right-4 z-[var(--z-toast)] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useToast must be inside <ToastProvider>");
  return ctx;
}
