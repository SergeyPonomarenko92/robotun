"use client";
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, ShieldCheck, Loader2 } from "lucide-react";

import { AuthShell } from "@/components/organisms/AuthShell";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Tag } from "@/components/ui/Tag";

import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";

const DEMO_ACCOUNTS: { label: string; email: string; password: string }[] = [
  { label: "Клієнт", email: "client@robotun.dev", password: "demo1234" },
  {
    label: "Виконавець",
    email: "provider@robotun.dev",
    password: "demo1234",
  },
];

export default function LoginPage() {
  const auth = useAuth();
  const params = useSearchParams();
  const next = params?.get("next") || "/feed";

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // If already authenticated, redirect immediately
  React.useEffect(() => {
    if (auth.status === "authenticated" && typeof window !== "undefined") {
      window.location.replace(next);
    }
  }, [auth.status, next]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await auth.login(email, password);
      window.location.assign(next);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.status === 401
            ? "Невірна електронна пошта або пароль"
            : err.status === 403
              ? "Акаунт недоступний — зверніться у підтримку"
              : "Сервіс тимчасово недоступний"
        );
      } else {
        setError("Не вдалось підключитись. Перевірте інтернет.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title={
        <>
          З поверненням
          <br />
          <span className="text-accent italic">в Robotun</span>
        </>
      }
      subtitle="Угоди, ескроу і виплати — з одного входу."
      footer={
        <span className="text-caption text-muted">
          Немає акаунту?{" "}
          <Link
            href="/register"
            className="text-ink underline decoration-1 underline-offset-2 hover:decoration-2"
          >
            Зареєструватись
          </Link>
        </span>
      }
      panel={
        <div className="flex flex-col h-full">
          <div className="flex-1 flex flex-col justify-end">
            <p className="font-mono text-micro uppercase tracking-[0.22em] text-paper/60 mb-3">
              Демо-акаунти
            </p>
            <p className="text-body-lg text-paper/85 leading-relaxed mb-6 max-w-sm">
              Для швидкого тестування — клацніть, щоб підставити дані.
            </p>
            <div className="flex flex-wrap gap-2">
              {DEMO_ACCOUNTS.map((d) => (
                <Tag
                  key={d.email}
                  variant="soft"
                  interactive
                  onClick={() => {
                    setEmail(d.email);
                    setPassword(d.password);
                  }}
                  className="bg-paper/10 text-paper border-paper/20 hover:bg-paper/15"
                >
                  {d.label} · {d.email}
                </Tag>
              ))}
            </div>
          </div>
          <p className="font-mono text-micro uppercase tracking-[0.22em] text-paper/40 mt-12 inline-flex items-center gap-2">
            <ShieldCheck size={12} />
            Захищено ескроу та KYC
          </p>
        </div>
      }
    >
      <form onSubmit={onSubmit} className="space-y-5">
        <FormField label="Електронна пошта" required>
          <Input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
        </FormField>
        <FormField label="Пароль" required>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
          />
        </FormField>

        {error && (
          <InlineAlert tone="danger" title="Не вдалось увійти">
            {error}
          </InlineAlert>
        )}

        <Button
          type="submit"
          variant="accent"
          size="lg"
          className="w-full"
          rightIcon={
            submitting ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <ArrowRight size={16} />
            )
          }
          disabled={submitting || !email || !password}
        >
          {submitting ? "Входимо…" : "Увійти"}
        </Button>

        <div className="flex items-center justify-between text-caption">
          <Link
            href="/password-reset"
            className="text-muted hover:text-ink underline-offset-2 hover:underline"
          >
            Забули пароль?
          </Link>
          <span className="text-muted-soft">access 15 хв · refresh 30 дн</span>
        </div>
      </form>
    </AuthShell>
  );
}
