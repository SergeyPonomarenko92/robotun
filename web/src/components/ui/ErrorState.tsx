import * as React from "react";
import { ServerCrash, WifiOff, Lock, FileQuestion, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./Button";

type ErrorKind = "network" | "forbidden" | "not_found" | "server" | "generic";

const KIND: Record<
  ErrorKind,
  { icon: React.ReactNode; title: string; desc: string }
> = {
  network: {
    icon: <WifiOff size={22} />,
    title: "Немає з'єднання з сервером",
    desc: "Перевірте інтернет-зʼєднання та спробуйте ще раз.",
  },
  forbidden: {
    icon: <Lock size={22} />,
    title: "У вас немає доступу",
    desc: "Цей розділ доступний лише для авторизованих ролей.",
  },
  not_found: {
    icon: <FileQuestion size={22} />,
    title: "Сторінку не знайдено",
    desc: "Можливо, її було видалено або переміщено.",
  },
  server: {
    icon: <ServerCrash size={22} />,
    title: "Щось пішло не так на сервері",
    desc: "Ми вже знаємо про проблему. Спробуйте за хвилину.",
  },
  generic: {
    icon: <ServerCrash size={22} />,
    title: "Помилка",
    desc: "Не вдалося виконати запит.",
  },
};

type ErrorStateProps = {
  kind?: ErrorKind;
  /** Технічний код для відображення (`429`, `req-id-...`) */
  code?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  onRetry?: () => void;
  /** inline — компактний для in-card помилок; page — великий */
  variant?: "page" | "inline";
  className?: string;
};

export function ErrorState({
  kind = "generic",
  code,
  title,
  description,
  onRetry,
  variant = "page",
  className,
}: ErrorStateProps) {
  const k = KIND[kind];
  if (variant === "inline") {
    return (
      <div
        className={cn(
          "flex items-start gap-3 p-4 rounded-[var(--radius-md)] border border-danger/40 bg-danger-soft/40",
          className
        )}
      >
        <span className="shrink-0 mt-0.5 text-danger">{k.icon}</span>
        <div className="flex-1 min-w-0">
          <p className="font-sans font-medium text-ink leading-snug">
            {title ?? k.title}
          </p>
          <p className="text-caption text-muted mt-0.5">{description ?? k.desc}</p>
          {code && (
            <p className="font-mono text-micro text-muted-soft mt-1.5 uppercase tracking-loose">
              code · {code}
            </p>
          )}
          {onRetry && (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<RotateCcw size={12} />}
              onClick={onRetry}
              className="mt-3"
            >
              Спробувати ще раз
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center py-20 px-6",
        className
      )}
    >
      <div className="h-14 w-14 rounded-[var(--radius-md)] bg-canvas border border-hairline flex items-center justify-center text-danger mb-5">
        {k.icon}
      </div>
      <h3 className="font-display text-h2 text-ink tracking-tight mb-2">
        {title ?? k.title}
      </h3>
      <p className="text-body text-muted leading-relaxed max-w-md">
        {description ?? k.desc}
      </p>
      {code && (
        <p className="font-mono text-caption text-muted-soft mt-3 uppercase tracking-loose">
          code · {code}
        </p>
      )}
      {onRetry && (
        <Button
          variant="secondary"
          leftIcon={<RotateCcw size={16} />}
          onClick={onRetry}
          className="mt-6"
        >
          Спробувати ще раз
        </Button>
      )}
    </div>
  );
}
