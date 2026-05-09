"use client";
import { useState } from "react";
import { TopNav } from "@/components/organisms/TopNav";
import { MobileTabBar } from "@/components/organisms/MobileTabBar";
import { Footer } from "@/components/organisms/Footer";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

const SUGGESTIONS = [
  { id: "1", label: "Ремонт пральних машин", meta: "Електропобут · 247", hint: "TOP" },
  { id: "2", label: "Прибирання квартир", meta: "Клінінг · 1 240" },
  { id: "3", label: "Електрика — заміна проводки", meta: "184" },
];

const USER = {
  id: "u1",
  displayName: "Сергій П.",
  email: "aks74ym@gmail.com",
  kycVerified: true,
  hasProviderRole: true,
};

export default function ShellDemoPage() {
  const [role, setRole] = useState<"client" | "provider">("client");
  return (
    <>
      <TopNav
        user={USER}
        role={role}
        onRoleSwitch={setRole}
        notificationsUnread={3}
        messagesUnread={12}
        searchSuggestions={SUGGESTIONS}
      />
      <main className="mx-auto max-w-7xl px-4 md:px-6 py-12 md:py-16 pb-24 md:pb-16">
        <div className="flex items-center gap-3 mb-8">
          <Badge tone="ink" shape="square" size="sm">demo</Badge>
          <span className="font-mono text-caption text-muted">
            Shell — TopNav · MobileTabBar · Footer
          </span>
        </div>
        <h1 className="font-display text-h1 md:text-display text-ink tracking-tight leading-[1.05] mb-6">
          Поточна роль:<br />
          <span className="text-accent">{role === "client" ? "Клієнт" : "Провайдер"}</span>
        </h1>
        <p className="text-body-lg text-muted max-w-xl leading-relaxed mb-8">
          Перемкніть роль через avatar-меню зверху праворуч. На мобільному —
          основна навігація знизу, плюс avatar-меню в right cluster.
        </p>
        <div className="flex flex-wrap gap-3 mb-12">
          <Button>Виклик до дії</Button>
          <Button variant="secondary">Вторинна</Button>
        </div>

        {/* Filler content для скролу */}
        <div className="space-y-12">
          {Array.from({ length: 4 }).map((_, i) => (
            <section key={i}>
              <h2 className="font-display text-h2 text-ink mb-4 tracking-tight">
                Секція {i + 1}
              </h2>
              <p className="text-body text-muted leading-relaxed max-w-2xl">
                Lorem ipsum dolor sit amet, consectetur adipiscing elit. Це placeholder
                для перевірки sticky-поведінки навбару й респонсивної сітки.
                Прокрутіть сторінку — TopNav залишиться зверху, mobile-tabbar — знизу.
              </p>
            </section>
          ))}
        </div>
      </main>
      <Footer />
      <MobileTabBar messagesUnread={12} notificationsUnread={3} />
    </>
  );
}
