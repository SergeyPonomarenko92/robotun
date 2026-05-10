"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight, Loader2, CheckCircle2, Mail } from "lucide-react";

import { AuthShell } from "@/components/organisms/AuthShell";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { RadioCardGroup } from "@/components/ui/RadioCardGroup";
import { TermCheckbox } from "@/components/ui/TermCheckbox";

import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";

type Role = "client" | "provider";

const PASSWORD_MIN = 12;

export default function RegisterPage() {
  const auth = useAuth();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [role, setRole] = React.useState<Role>("client");
  const [agree, setAgree] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  const valid =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    password.length >= PASSWORD_MIN &&
    agree;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await auth.register({ email, password, initial_role: role });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.status === 409
            ? "Цей email вже зареєстрований"
            : err.status === 400 && (err.body as { error?: string })?.error === "weak_password"
              ? `Пароль має бути щонайменше ${PASSWORD_MIN} символів`
              : err.status === 400
                ? "Перевірте формат email"
                : "Сервіс тимчасово недоступний"
        );
      } else {
        setError("Не вдалось підключитись. Перевірте інтернет.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <AuthShell
        title={
          <>
            Перевірте пошту
            <br />
            <span className="text-accent italic">{email}</span>
          </>
        }
        subtitle="Ми надіслали посилання для підтвердження. Воно дійсне 24 години."
        footer={
          <span className="text-caption text-muted">
            Не отримали лист?{" "}
            <button className="text-ink underline decoration-1 underline-offset-2 hover:decoration-2">
              Надіслати ще раз
            </button>
          </span>
        }
        panel={
          <div className="flex flex-col h-full">
            <div className="flex-1 flex flex-col justify-end">
              <span
                className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-paper/10 text-paper mb-6"
                aria-hidden
              >
                <Mail size={20} />
              </span>
              <p className="font-display text-h2 text-paper leading-tight tracking-tight">
                Готово.
                <br />
                <span className="text-paper/60 italic">
                  Залишився один клік.
                </span>
              </p>
            </div>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="border border-success rounded-[var(--radius-md)] bg-success-soft p-5 flex items-start gap-3">
            <CheckCircle2 size={18} className="text-success shrink-0 mt-0.5" />
            <div>
              <p className="font-display text-body-lg text-ink leading-tight">
                Акаунт створено
              </p>
              <p className="text-caption text-ink-soft mt-1 leading-relaxed">
                До підтвердження пошти можна переглядати каталог. Угоди й
                виплати — після верифікації.
              </p>
            </div>
          </div>
          <Link href="/login">
            <Button variant="accent" size="lg" className="w-full" rightIcon={<ArrowRight size={16} />}>
              До входу
            </Button>
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={
        <>
          Створимо акаунт
          <br />
          <span className="text-accent italic">за хвилину</span>
        </>
      }
      subtitle="Один акаунт — і клієнт, і виконавець. Ролі додаються будь-коли."
      footer={
        <span className="text-caption text-muted">
          Вже з нами?{" "}
          <Link
            href="/login"
            className="text-ink underline decoration-1 underline-offset-2 hover:decoration-2"
          >
            Увійти
          </Link>
        </span>
      }
      panel={
        <div className="flex flex-col h-full">
          <div className="flex-1 flex flex-col justify-end">
            <p className="font-mono text-micro uppercase tracking-[0.22em] text-paper/60 mb-3">
              Чому Robotun
            </p>
            <ul className="space-y-3 text-paper/85 max-w-sm">
              <li className="flex gap-3">
                <span className="font-mono text-micro text-paper/40 mt-1">01</span>
                Кошти заморожуються в ескроу — захист обох сторін.
              </li>
              <li className="flex gap-3">
                <span className="font-mono text-micro text-paper/40 mt-1">02</span>
                KYC лише для виплат — листинги можна публікувати одразу.
              </li>
              <li className="flex gap-3">
                <span className="font-mono text-micro text-paper/40 mt-1">03</span>
                Сервісний збір лише 5%, без прихованих комісій.
              </li>
            </ul>
          </div>
        </div>
      }
    >
      <form onSubmit={onSubmit} className="space-y-5">
        <FormField label="Як ви плануєте користуватись" required>
          <RadioCardGroup
            value={role}
            onChange={setRole}
            columns={2}
            options={[
              { id: "client", label: "Шукаю майстра", hint: "замовляю послуги" },
              { id: "provider", label: "Я виконавець", hint: "пропоную послуги" },
            ]}
          />
        </FormField>

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
        <FormField
          label="Пароль"
          required
          helper={`Мінімум ${PASSWORD_MIN} символів. Без правил складності — довжина важливіша.`}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="correct horse battery staple"
            required
          />
        </FormField>

        <TermCheckbox
          checked={agree}
          onChange={setAgree}
          title="Погоджуюсь з умовами Robotun"
          body="Включаючи Політику конфіденційності, обробку персональних даних та правила платформи."
          variant="selectable"
        />

        {error && (
          <InlineAlert tone="danger" title="Не вдалось зареєструватись">
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
          disabled={!valid || submitting}
        >
          {submitting ? "Створюємо…" : "Створити акаунт"}
        </Button>
      </form>
    </AuthShell>
  );
}
