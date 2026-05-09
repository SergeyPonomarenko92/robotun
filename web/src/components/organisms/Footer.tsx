import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

type FooterProps = {
  className?: string;
};

const COLUMNS = [
  {
    title: "Маркетплейс",
    links: [
      { label: "Усі категорії", href: "/categories" },
      { label: "Майстри поряд", href: "/providers" },
      { label: "Як це працює", href: "/how-it-works" },
      { label: "Гарантія угод", href: "/escrow" },
    ],
  },
  {
    title: "Для майстрів",
    links: [
      { label: "Стати майстром", href: "/auth/sign-up?role=provider" },
      { label: "KYC та виплати", href: "/payouts" },
      { label: "Цінова політика", href: "/pricing" },
      { label: "Спільнота", href: "/community" },
    ],
  },
  {
    title: "Підтримка",
    links: [
      { label: "Допомога", href: "/help" },
      { label: "Угоди користувача", href: "/legal/tos" },
      { label: "Політика конфіденційності", href: "/legal/privacy" },
      { label: "Безпечні угоди", href: "/safety" },
    ],
  },
];

export function Footer({ className }: FooterProps) {
  return (
    <footer
      className={cn(
        "mt-24 border-t border-hairline bg-paper",
        className
      )}
    >
      <div className="mx-auto max-w-7xl px-4 md:px-6 py-14 md:py-16 grid grid-cols-1 md:grid-cols-[1.4fr_repeat(3,1fr)] gap-10">
        <div>
          <p className="font-display text-h2 text-ink tracking-tight leading-none">
            Robotun<span className="text-accent">.</span>
          </p>
          <p className="mt-4 text-body text-muted max-w-xs leading-relaxed">
            Маркетплейс послуг з ескроу, KYC та чесними угодами. Зроблено в Україні.
          </p>
          <p className="mt-6 font-mono text-micro uppercase tracking-loose text-muted-soft">
            UA · UAH · 2026
          </p>
        </div>
        {COLUMNS.map((col) => (
          <div key={col.title}>
            <h3 className="font-mono text-micro uppercase tracking-loose text-muted-soft mb-4">
              {col.title}
            </h3>
            <ul className="flex flex-col gap-2.5">
              {col.links.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className="text-body text-ink-soft hover:text-ink hover:underline underline-offset-4 decoration-1 transition-colors"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-hairline">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
          <p className="font-mono text-micro text-muted-soft uppercase tracking-loose">
            © Robotun OÜ · усі права захищено
          </p>
          <div className="flex items-center gap-4">
            <Link href="/legal/tos" className="text-caption text-muted hover:text-ink">
              Умови
            </Link>
            <Link href="/legal/privacy" className="text-caption text-muted hover:text-ink">
              Конфіденційність
            </Link>
            <Link href="/legal/cookies" className="text-caption text-muted hover:text-ink">
              Cookies
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
