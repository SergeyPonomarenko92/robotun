"use client";
import * as React from "react";
import { CheckCircle2, AlertTriangle, XCircle, Send, Hourglass, MessageCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import type { DealStatus } from "./DealStateTracker";

type Role = "client" | "provider" | "admin";

type Action = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  variant?: "primary" | "secondary" | "accent" | "ghost" | "danger";
  destructive?: boolean;
  /** UI hint про необоротність / consent window */
  hint?: string;
};

const NOOP_HINT = "Дочекайтеся дій іншої сторони";

/**
 * Returns the set of actions visible to a given viewer in a given deal status,
 * matching the auth matrix in Deal §4.5/§4.6.
 */
function actionsFor(status: DealStatus, role: Role): { primary: Action[]; secondary: Action[]; hint?: string } {
  if (role === "client") {
    switch (status) {
      case "pending":
        return {
          primary: [],
          secondary: [{ id: "cancel", label: "Скасувати запит", variant: "ghost", icon: <XCircle size={14} /> }],
          hint: "Чекаємо, поки провайдер прийме угоду",
        };
      case "active":
        return {
          primary: [],
          secondary: [{ id: "cancel-request", label: "Запропонувати скасування", variant: "ghost" }],
          hint: "Робота триває. Очікуйте на здачу",
        };
      case "in_review":
        return {
          primary: [
            { id: "approve", label: "Прийняти роботу", variant: "accent", icon: <CheckCircle2 size={14} /> },
          ],
          secondary: [
            { id: "dispute", label: "Відкрити спір", variant: "ghost", icon: <AlertTriangle size={14} />, hint: "Потрібно ≥30 символів і 1+ доказ" },
          ],
        };
      case "completed":
        return {
          primary: [{ id: "review", label: "Залишити відгук", variant: "primary" }],
          secondary: [{ id: "dispute-grace", label: "Оскаржити (24 год)", variant: "ghost", hint: "Поки кошти не виплачено" }],
        };
      case "disputed":
        return {
          primary: [],
          secondary: [{ id: "evidence", label: "Додати докази", variant: "secondary" }],
          hint: "Адмін розглядає спір (до 14 днів)",
        };
      default:
        return { primary: [], secondary: [] };
    }
  }
  if (role === "provider") {
    switch (status) {
      case "pending":
        return {
          primary: [
            { id: "accept", label: "Прийняти угоду", variant: "accent", icon: <CheckCircle2 size={14} /> },
          ],
          secondary: [
            { id: "reject", label: "Відхилити", variant: "ghost", icon: <XCircle size={14} /> },
          ],
        };
      case "active":
        return {
          primary: [
            { id: "submit", label: "Здати роботу", variant: "accent", icon: <Send size={14} /> },
          ],
          secondary: [{ id: "cancel-request", label: "Запропонувати скасування", variant: "ghost" }],
        };
      case "in_review":
        return {
          primary: [],
          secondary: [],
          hint: "Клієнт перевіряє роботу. Авто-завершення за 7 днів",
        };
      case "completed":
        return { primary: [], secondary: [{ id: "thank", label: "Подякувати", variant: "ghost" }] };
      case "disputed":
        return {
          primary: [
            { id: "respond", label: "Подати відповідь", variant: "primary", hint: "До 3 днів" },
          ],
          secondary: [],
        };
      default:
        return { primary: [], secondary: [] };
    }
  }
  // admin
  if (status === "disputed") {
    return {
      primary: [{ id: "resolve", label: "Винести рішення", variant: "primary" }],
      secondary: [
        { id: "ask-evidence", label: "Запросити докази", variant: "ghost" },
        { id: "escalate", label: "Ескалувати", variant: "ghost" },
      ],
    };
  }
  return {
    primary: [],
    secondary: [],
    hint: "Адміністративні дії доступні лише в стані disputed",
  };
}

function variantOf(a: Action) {
  return a.variant ?? "secondary";
}

type DealActionsPanelProps = {
  status: DealStatus;
  role: Role;
  onAction?: (id: string) => void;
  /** Скрізь-доступна дія "Написати" */
  onMessage?: () => void;
  className?: string;
};

export function DealActionsPanel({
  status,
  role,
  onAction,
  onMessage,
  className,
}: DealActionsPanelProps) {
  const { primary, secondary, hint } = actionsFor(status, role);

  return (
    <section
      className={cn(
        "rounded-[var(--radius-md)] border border-hairline-strong bg-paper p-5 md:p-6",
        className
      )}
    >
      <div className="flex items-center justify-between mb-4">
        <p className="font-mono text-micro uppercase tracking-loose text-muted-soft">
          Дії {role === "client" ? "клієнта" : role === "provider" ? "провайдера" : "адміна"}
        </p>
        {onMessage && (
          <button
            type="button"
            onClick={onMessage}
            className="inline-flex items-center gap-1.5 text-caption text-muted hover:text-ink"
          >
            <MessageCircle size={14} /> Написати
          </button>
        )}
      </div>

      {primary.length === 0 && secondary.length === 0 ? (
        <div className="py-4 px-3 rounded-[var(--radius-sm)] bg-canvas border border-hairline text-center">
          <Hourglass size={18} className="inline text-muted-soft mb-1" />
          <p className="text-body text-muted">{hint ?? NOOP_HINT}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {primary.map((a) => (
              <ActionButton key={a.id} action={a} onClick={() => onAction?.(a.id)} />
            ))}
          </div>
          {secondary.length > 0 && (
            <div className="mt-3 pt-3 border-t border-hairline flex flex-col gap-2">
              {secondary.map((a) => (
                <ActionButton key={a.id} action={a} onClick={() => onAction?.(a.id)} />
              ))}
            </div>
          )}
          {hint && <p className="mt-3 text-caption text-muted leading-relaxed">{hint}</p>}
        </>
      )}
    </section>
  );
}

function ActionButton({ action, onClick }: { action: Action; onClick: () => void }) {
  return (
    <Button
      onClick={onClick}
      variant={variantOf(action)}
      size="lg"
      leftIcon={action.icon}
      className="w-full justify-start"
    >
      <span className="flex-1 text-left">{action.label}</span>
      {action.hint && (
        <span className="text-caption text-muted-soft font-normal">{action.hint}</span>
      )}
    </Button>
  );
}
