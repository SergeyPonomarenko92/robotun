"use client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Tag } from "@/components/ui/Tag";
import { Search, ArrowRight, Plus, Heart } from "lucide-react";

function Section({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <section id={id} className="border-t border-hairline py-14 first:border-t-0">
      <header className="mb-8 flex items-baseline gap-4">
        <span className="font-mono text-caption text-muted-soft">{id}</span>
        <h2 className="font-display text-h2 text-ink tracking-tight">{label}</h2>
      </header>
      <div className="space-y-10">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-[180px_1fr] md:items-center">
      <div className="font-mono text-caption text-muted">{label}</div>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

const swatches: { token: string; hex: string }[] = [
  { token: "canvas", hex: "#f7f4ee" },
  { token: "paper", hex: "#ffffff" },
  { token: "elevated", hex: "#fffdf8" },
  { token: "ink", hex: "#14110e" },
  { token: "ink-soft", hex: "#2c2924" },
  { token: "muted", hex: "#6e6862" },
  { token: "muted-soft", hex: "#948e85" },
  { token: "hairline", hex: "#e8e2d6" },
  { token: "accent", hex: "#b3361b" },
  { token: "accent-soft", hex: "#f3dcd2" },
  { token: "success", hex: "#2f6f4f" },
  { token: "warning", hex: "#a86a14" },
  { token: "danger", hex: "#a52a2a" },
  { token: "info", hex: "#2b4a7a" },
];

export default function StyleguidePage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16 md:py-24">
      <header className="mb-16 flex flex-col gap-6 md:gap-8">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-caption tracking-loose uppercase text-muted">
            Robotun · Styleguide v0.1
          </span>
          <span className="font-mono text-caption text-muted-soft">2026.05.09</span>
        </div>
        <h1 className="font-display text-h1 md:text-display tracking-tight text-ink leading-[1.05]">
          Foundation,<br />
          п’ять атомів,<br />
          один погляд.
        </h1>
        <p className="max-w-2xl text-body-lg text-muted leading-relaxed">
          Це живий контракт між дизайном і кодом. Все, що внизу — фундамент,
          з якого складатимуться всі екрани Robotun. Жодних компонентів поза
          цим списком без узгодження.
        </p>
      </header>

      <Section id="00" label="Typography">
        <div className="space-y-6">
          <p className="font-display text-display tracking-tight text-ink">Майстер під ваше завдання.</p>
          <p className="font-display text-h1 text-ink">Знайдіть сьогодні.</p>
          <p className="font-display text-h2 text-ink">Електрика, ремонт, прибирання.</p>
          <h3 className="font-display text-h3 text-ink">Заголовок третього рівня</h3>
          <p className="text-body-lg text-ink">Body large — для intro-параграфів і важливих описів послуг.</p>
          <p className="text-body text-ink">Body — стандартний розмір для контенту, форм, карток.</p>
          <p className="text-caption text-muted">Caption — для метаданих, підказок, дрібних підписів.</p>
          <p className="text-micro text-muted-soft">Micro — для службових позначок, ID, timestamps.</p>
          <p className="font-mono text-caption text-muted-soft">font-mono · LST-9241 · 320,00 ₴ · 2026-05-09T10:14Z</p>
        </div>
      </Section>

      <Section id="01" label="Color">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {swatches.map((s) => (
            <div key={s.token} className="border border-hairline rounded-[var(--radius-sm)] overflow-hidden bg-paper">
              <div className="h-20" style={{ background: `var(--color-${s.token})` }} />
              <div className="p-3">
                <div className="font-sans text-body text-ink">{s.token}</div>
                <div className="font-mono text-caption text-muted-soft">{s.hex}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section id="02" label="Button">
        <Row label="primary">
          <Button size="sm">Малий</Button>
          <Button size="md">Стандартний</Button>
          <Button size="lg" rightIcon={<ArrowRight size={18} />}>Великий з іконкою</Button>
        </Row>
        <Row label="secondary">
          <Button variant="secondary" size="sm">Скасувати</Button>
          <Button variant="secondary" leftIcon={<Plus size={16} />}>Додати фото</Button>
        </Row>
        <Row label="accent">
          <Button variant="accent">Опублікувати</Button>
          <Button variant="accent" size="lg">Створити угоду</Button>
        </Row>
        <Row label="ghost · link">
          <Button variant="ghost" leftIcon={<Heart size={16} />}>У збережене</Button>
          <Button variant="link">Дізнатись більше →</Button>
        </Row>
        <Row label="danger">
          <Button variant="danger">Видалити лістинг</Button>
        </Row>
        <Row label="states">
          <Button loading>Завантаження</Button>
          <Button disabled>Недоступно</Button>
          <Button size="icon" variant="secondary" aria-label="Пошук">
            <Search size={16} />
          </Button>
        </Row>
      </Section>

      <Section id="03" label="Input">
        <Row label="default">
          <div className="w-full max-w-sm">
            <Input placeholder="Назва послуги" />
          </div>
        </Row>
        <Row label="with addon">
          <div className="w-full max-w-sm">
            <Input
              leftAddon={<Search size={16} />}
              placeholder="Шукати майстра, послугу, категорію"
            />
          </div>
        </Row>
        <Row label="money">
          <div className="w-full max-w-xs">
            <Input
              type="number"
              placeholder="0"
              rightAddon={<span className="font-mono text-muted">₴</span>}
            />
          </div>
        </Row>
        <Row label="error">
          <div className="w-full max-w-sm space-y-1">
            <Input tone="error" defaultValue="bademail" />
            <p className="text-caption text-danger">Введіть коректну електронну адресу.</p>
          </div>
        </Row>
        <Row label="disabled / read-only">
          <div className="w-full max-w-sm flex flex-col gap-2">
            <Input disabled placeholder="Недоступно" />
            <Input readOnly defaultValue="LST-9241 · ID" className="font-mono" />
          </div>
        </Row>
        <Row label="sizes">
          <div className="w-full max-w-md flex flex-col gap-2">
            <Input size="sm" placeholder="sm" />
            <Input size="md" placeholder="md" />
            <Input size="lg" placeholder="lg" />
          </div>
        </Row>
      </Section>

      <Section id="04" label="Avatar">
        <Row label="sizes">
          <Avatar size="xs" alt="Микола Петренко" />
          <Avatar size="sm" alt="Микола Петренко" />
          <Avatar size="md" alt="Микола Петренко" />
          <Avatar size="lg" alt="Микола Петренко" />
          <Avatar size="xl" alt="Микола Петренко" />
        </Row>
        <Row label="circle + image">
          <Avatar shape="circle" size="md" alt="Anna Hill" src="https://i.pravatar.cc/80?img=47" />
          <Avatar shape="circle" size="lg" alt="Marko Lyko" src="https://i.pravatar.cc/120?img=12" />
        </Row>
        <Row label="kyc + online">
          <Avatar size="lg" alt="Bosch Group" kycVerified />
          <Avatar size="md" shape="circle" alt="Olha K" online src="https://i.pravatar.cc/80?img=5" />
          <Avatar size="lg" alt="Verified Pro" kycVerified online />
        </Row>
      </Section>

      <Section id="05" label="Badge">
        <Row label="tones">
          <Badge>neutral</Badge>
          <Badge tone="accent">accent</Badge>
          <Badge tone="success">success</Badge>
          <Badge tone="warning">warning</Badge>
          <Badge tone="danger">danger</Badge>
          <Badge tone="info">info</Badge>
          <Badge tone="ink">ink</Badge>
        </Row>
        <Row label="with dot">
          <Badge tone="success" withDot>active</Badge>
          <Badge tone="warning" withDot>in review</Badge>
          <Badge tone="danger" withDot>disputed</Badge>
          <Badge tone="neutral" withDot>pending</Badge>
        </Row>
        <Row label="square + sm">
          <Badge shape="square" size="sm">v1.3</Badge>
          <Badge shape="square" size="sm" tone="ink">KYC ✓</Badge>
          <Badge shape="square" size="sm" tone="info">UAH</Badge>
        </Row>
      </Section>

      <Section id="06" label="Tag">
        <Row label="categories">
          <Tag>Електрика</Tag>
          <Tag>Прибирання</Tag>
          <Tag>Ремонт</Tag>
          <Tag>Будівництво</Tag>
        </Row>
        <Row label="soft + accent">
          <Tag variant="soft">Київ</Tag>
          <Tag variant="soft">Львів</Tag>
          <Tag variant="accent">Топ-провайдер</Tag>
        </Row>
        <Row label="selected · interactive">
          <Tag interactive>Будь-яка ціна</Tag>
          <Tag interactive selected>До 500 ₴</Tag>
          <Tag interactive>500–2000 ₴</Tag>
          <Tag interactive>2000+ ₴</Tag>
        </Row>
        <Row label="removable filter chips">
          <Tag variant="soft" onRemove={() => {}}>Київ</Tag>
          <Tag variant="soft" onRemove={() => {}}>KYC ✓</Tag>
          <Tag variant="soft" onRemove={() => {}}>До 1000 ₴</Tag>
        </Row>
      </Section>

      <footer className="mt-20 border-t border-hairline pt-8">
        <p className="font-mono text-caption text-muted-soft">
          Далі: молекули — FormField, SearchBar, FileUploader, MoneyInput, CategoryPicker.
        </p>
      </footer>
    </main>
  );
}
