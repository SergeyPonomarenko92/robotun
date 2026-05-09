import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

type AuthShellProps = {
  children: React.ReactNode;
  /** Editorial side panel: цитата, фото, або акцент. */
  panel?: React.ReactNode;
  /** Заголовок зліва (форма) */
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Низ форми — лінк альтернативи (sign-up ↔ sign-in) */
  footer?: React.ReactNode;
  className?: string;
};

export function AuthShell({
  children,
  panel,
  title,
  subtitle,
  footer,
  className,
}: AuthShellProps) {
  return (
    <div
      className={cn(
        "min-h-screen grid grid-cols-1 md:grid-cols-2",
        className
      )}
    >
      {/* Form side */}
      <div className="flex flex-col bg-canvas">
        <header className="px-6 md:px-12 py-6 md:py-8 flex items-center justify-between">
          <Link
            href="/"
            className="font-display text-h3 tracking-tight text-ink leading-none"
          >
            Robotun<span className="text-accent">.</span>
          </Link>
          <Link href="/help" className="text-caption text-muted hover:text-ink">
            Потрібна допомога?
          </Link>
        </header>
        <main className="flex-1 flex items-center justify-center px-6 md:px-12 pb-10">
          <div className="w-full max-w-sm">
            {(title || subtitle) && (
              <div className="mb-8">
                {title && (
                  <h1 className="font-display text-h1 text-ink tracking-tight leading-[1.05]">
                    {title}
                  </h1>
                )}
                {subtitle && (
                  <p className="mt-3 text-body text-muted leading-relaxed">
                    {subtitle}
                  </p>
                )}
              </div>
            )}
            {children}
            {footer && (
              <div className="mt-8 pt-6 border-t border-hairline text-caption text-muted">
                {footer}
              </div>
            )}
          </div>
        </main>
        <footer className="px-6 md:px-12 py-4 border-t border-hairline">
          <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-micro uppercase tracking-loose text-muted-soft">
            <span>© Robotun · 2026</span>
            <div className="flex items-center gap-4">
              <Link href="/legal/tos" className="hover:text-ink">умови</Link>
              <Link href="/legal/privacy" className="hover:text-ink">приватність</Link>
            </div>
          </div>
        </footer>
      </div>

      {/* Editorial panel */}
      <div className="hidden md:block relative bg-ink overflow-hidden">
        {panel ?? <DefaultAuthPanel />}
      </div>
    </div>
  );
}

function DefaultAuthPanel() {
  return (
    <div className="absolute inset-0 flex flex-col justify-between p-12 text-paper">
      {/* Decorative grid */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
          backgroundSize: "40px 40px",
          color: "white",
        }}
      />
      <div
        aria-hidden
        className="absolute -top-20 -right-20 h-[420px] w-[420px] rounded-full bg-accent/30 blur-3xl"
      />
      <div className="relative">
        <p className="font-mono text-micro uppercase tracking-loose text-paper/60">
          Робота починається тут
        </p>
      </div>
      <div className="relative">
        <p className="font-display text-display tracking-tight leading-[0.95]">
          Знайдіть<br />
          майстра.<br />
          <span className="text-accent">Без</span> зайвого.
        </p>
        <p className="mt-8 max-w-md text-body text-paper/70 leading-relaxed">
          Гарантія угод через ескроу, перевірені виконавці, чесні відгуки. Жодних
          фейкових профілів, жодних прихованих комісій.
        </p>
      </div>
      <div className="relative flex items-center gap-6 font-mono text-caption text-paper/60">
        <span>UA · UAH</span>
        <span>·</span>
        <span>v0.1 · MVP</span>
      </div>
    </div>
  );
}
