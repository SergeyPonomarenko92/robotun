"use client";
import { useMemo, useState } from "react";
import {
  ShieldCheck,
  Clock,
  MapPin,
  Lock,
  ArrowRight,
  Bookmark,
  Share2,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Hammer,
} from "lucide-react";

import { TopNav } from "@/components/organisms/TopNav";
import { MobileTabBar } from "@/components/organisms/MobileTabBar";
import { Footer } from "@/components/organisms/Footer";
import {
  AggregateRating,
  type RatingDistribution,
} from "@/components/organisms/AggregateRating";
import { ProviderCard } from "@/components/organisms/ProviderCard";
import {
  ReviewCard,
  type ReviewCardData,
} from "@/components/organisms/ReviewCard";
import {
  ListingCard,
  type ListingCardData,
} from "@/components/organisms/ListingCard";

import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { Button } from "@/components/ui/Button";
import { Tag } from "@/components/ui/Tag";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { RatingStars } from "@/components/ui/RatingStars";
import { MoneyDisplay } from "@/components/ui/MoneyInput";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { CopyButton } from "@/components/ui/CopyButton";
import { Tooltip } from "@/components/ui/Tooltip";

const USER = {
  id: "u1",
  displayName: "Сергій П.",
  email: "aks74ym@gmail.com",
  kycVerified: true,
  hasProviderRole: true,
};

const GALLERY = [
  {
    id: "g1",
    src: "https://images.unsplash.com/photo-1581092335397-9583eb92d232?w=1600&q=80",
    alt: "Майстер з пральною машиною",
  },
  {
    id: "g2",
    src: "https://images.unsplash.com/photo-1581092580497-e0d23cbdf1dc?w=1200&q=80",
    alt: "Інструмент",
  },
  {
    id: "g3",
    src: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=1200&q=80",
    alt: "Сервіс пральних машин",
  },
  {
    id: "g4",
    src: "https://images.unsplash.com/photo-1545173168-9f1947eebb7f?w=1200&q=80",
    alt: "Робота на виїзді",
  },
  {
    id: "g5",
    src: "https://images.unsplash.com/photo-1607269512643-ec0c1d2c2b95?w=1200&q=80",
    alt: "Деталі двигуна",
  },
];

const DISTRIBUTION: RatingDistribution = { 5: 248, 4: 52, 3: 14, 2: 4, 1: 2 };

const REVIEWS: ReviewCardData[] = [
  {
    id: "r1",
    rating: 5,
    body:
      "Зателефонували — приїхали через 40 хв. Замінили підшипники у Bosch WAS, дали гарантію на 6 місяців. Усе чисто, прибрали за собою. Рекомендую без вагань.",
    createdAt: "2026-04-22T10:11:00Z",
    author: { displayName: "Олена К.", avatarUrl: "https://i.pravatar.cc/120?img=47" },
    dealRef: "DL-7421",
    reply: {
      body: "Дякуємо, Олено! Раді, що все вдалося оперативно.",
      createdAt: "2026-04-22T18:00:00Z",
    },
    status: "published",
  },
  {
    id: "r2",
    rating: 5,
    body:
      "Діагностика безкоштовна — це чесно. Виявили зношений ТЕН, замінили того ж дня. Ескроу — вперше користувався, дуже зручно.",
    createdAt: "2026-04-15T14:30:00Z",
    author: { displayName: "Андрій М.", avatarUrl: "https://i.pravatar.cc/120?img=33" },
    dealRef: "DL-7388",
    status: "published",
  },
  {
    id: "r3",
    rating: 4,
    body:
      "Ремонт зробили якісно, але запчастину чекали 3 дні. Майстер тримав у курсі — це плюс.",
    createdAt: "2026-04-08T09:00:00Z",
    author: { displayName: "Наталія Ш." },
    status: "published",
  },
];

const RELATED: ListingCardData[] = [
  {
    id: "rl1",
    href: "#",
    title: "Ремонт холодильників — виїзд по Києву і області",
    coverUrl: "https://picsum.photos/seed/r-rl1/640/480",
    priceFromKopecks: 35000,
    priceUnit: "/виклик",
    city: "Київ",
    category: "Ремонт побутової техніки",
    provider: {
      name: "Bosch Group Service",
      avatarUrl: "https://i.pravatar.cc/120?img=12",
      kycVerified: true,
      avgRating: 4.9,
      reviewsCount: 320,
    },
  },
  {
    id: "rl2",
    href: "#",
    title: "Підключення посудомийних машин — гарантія 12 міс.",
    coverUrl: "https://picsum.photos/seed/r-rl2/640/480",
    priceFromKopecks: 45000,
    priceUnit: "/виклик",
    city: "Київ",
    category: "Сантехніка",
    provider: {
      name: "AquaPro",
      avatarUrl: "https://i.pravatar.cc/120?img=18",
      kycVerified: true,
      avgRating: 4.8,
      reviewsCount: 142,
    },
  },
  {
    id: "rl3",
    href: "#",
    title: "Чистка та сервіс кондиціонерів — комплексно",
    coverUrl: "https://picsum.photos/seed/r-rl3/640/480",
    priceFromKopecks: 60000,
    priceUnit: "/блок",
    city: "Київ",
    category: "Клімат",
    provider: {
      name: "ClimateLab",
      avatarUrl: "https://i.pravatar.cc/120?img=24",
      kycVerified: true,
      avgRating: 4.7,
      reviewsCount: 88,
    },
  },
];

export default function ListingDetailPage() {
  const [activeImage, setActiveImage] = useState(0);
  const [saved, setSaved] = useState(false);

  const totalReviews = useMemo(
    () => Object.values(DISTRIBUTION).reduce((a, b) => a + b, 0),
    []
  );

  const next = () => setActiveImage((i) => (i + 1) % GALLERY.length);
  const prev = () =>
    setActiveImage((i) => (i - 1 + GALLERY.length) % GALLERY.length);

  return (
    <>
      <TopNav user={USER} notificationsUnread={3} messagesUnread={12} />

      <main className="mx-auto max-w-7xl px-4 md:px-6 pt-6 md:pt-8 pb-32 md:pb-20">
        <Breadcrumbs
          className="mb-8"
          items={[
            { label: "Усі категорії", href: "/categories" },
            { label: "Послуги вдома", href: "#" },
            { label: "Ремонт побутової техніки", href: "#" },
            { label: "Пральні машини" },
          ]}
        />

        {/* ============================================================
            EDITORIAL HEADER — magazine spread treatment
           ============================================================ */}
        <header className="grid grid-cols-12 gap-x-6 gap-y-6 mb-10 md:mb-14">
          <div className="col-span-12 lg:col-span-9">
            <div className="flex flex-wrap items-center gap-3 mb-5">
              <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
                Послуга №&nbsp;
                <span className="text-ink-soft">L-21847</span>
              </span>
              <span className="h-1 w-1 rounded-full bg-hairline-strong" aria-hidden />
              <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
                Опубліковано&nbsp;
                <span className="text-ink-soft">3 травня 2026</span>
              </span>
              <Badge tone="ink" size="sm" shape="square">
                Топ-1%
              </Badge>
              <Badge tone="success" size="sm" shape="square">
                <ShieldCheck size={10} className="mr-0.5" />
                KYC
              </Badge>
            </div>

            <h1 className="font-display text-h1 md:text-display text-ink leading-[0.98] tracking-tight">
              Ремонт пральних машин
              <br />
              <span className="text-accent italic">Bosch · Siemens</span>
              <br />
              <span className="text-ink-soft">з виїздом по Києву</span>
            </h1>

            <p className="mt-6 text-body-lg text-ink-soft max-w-2xl leading-relaxed">
              Сервісний центр з 2014 року. Діагностика безкоштовна, оригінальні
              запчастини, гарантія на роботу — 12&nbsp;місяців. Працюємо
              з фізичними та юридичними особами через ескроу.
            </p>
          </div>

          {/* Right column — vital stats card */}
          <aside className="col-span-12 lg:col-span-3">
            <div className="border border-hairline rounded-[var(--radius-md)] bg-elevated p-5 grid grid-cols-2 lg:grid-cols-1 gap-4 lg:gap-3 h-full">
              <Stat label="Рейтинг">
                <span className="font-display text-h2 text-ink leading-none">
                  4.9
                </span>
                <RatingStars value={4.9} size="sm" />
              </Stat>
              <Stat label="Виконано угод">
                <span className="font-display text-h2 text-ink leading-none tabular-nums">
                  412
                </span>
              </Stat>
              <Stat label="Відповідь">
                <span className="font-display text-h2 text-ink leading-none">
                  ~12<span className="text-muted text-h3">хв</span>
                </span>
              </Stat>
              <Stat label="Гарантія">
                <span className="font-display text-h2 text-ink leading-none">
                  12<span className="text-muted text-h3">міс</span>
                </span>
              </Stat>
            </div>
          </aside>
        </header>

        {/* ============================================================
            HERO GALLERY  +  STICKY BOOKING CARD (2-col on lg)
           ============================================================ */}
        <section className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6 lg:gap-10 mb-16 md:mb-24">
          {/* Gallery */}
          <div className="min-w-0">
            <div className="relative overflow-hidden rounded-[var(--radius-md)] border border-hairline bg-canvas">
              <div
                className="aspect-[4/3] md:aspect-[16/10] bg-cover bg-center transition-[background-image] duration-[var(--duration-slow)] ease-[var(--ease-standard)]"
                style={{ backgroundImage: `url(${GALLERY[activeImage].src})` }}
                aria-label={GALLERY[activeImage].alt}
                role="img"
              />
              {/* Counter pill */}
              <div className="absolute top-4 left-4 px-2.5 py-1 rounded-[var(--radius-pill)] bg-ink/85 text-paper font-mono text-micro tracking-wider tabular-nums backdrop-blur-sm">
                {String(activeImage + 1).padStart(2, "0")} / {String(GALLERY.length).padStart(2, "0")}
              </div>
              {/* Save / share */}
              <div className="absolute top-4 right-4 flex gap-2">
                <Tooltip content="Зберегти" side="bottom">
                  <button
                    type="button"
                    onClick={() => setSaved((v) => !v)}
                    aria-pressed={saved}
                    aria-label="Зберегти"
                    className="h-10 w-10 inline-flex items-center justify-center rounded-[var(--radius-sm)] bg-paper/95 text-ink border border-hairline-strong hover:bg-paper hover:border-ink transition-colors"
                  >
                    <Bookmark
                      size={16}
                      className={saved ? "fill-accent text-accent" : ""}
                    />
                  </button>
                </Tooltip>
                <Tooltip content="Поділитись" side="bottom">
                  <button
                    type="button"
                    aria-label="Поділитись"
                    className="h-10 w-10 inline-flex items-center justify-center rounded-[var(--radius-sm)] bg-paper/95 text-ink border border-hairline-strong hover:bg-paper hover:border-ink transition-colors"
                  >
                    <Share2 size={16} />
                  </button>
                </Tooltip>
              </div>
              {/* Prev / next */}
              <button
                type="button"
                onClick={prev}
                aria-label="Попереднє"
                className="absolute left-3 top-1/2 -translate-y-1/2 h-11 w-11 inline-flex items-center justify-center rounded-full bg-paper/95 text-ink border border-hairline-strong hover:bg-paper hover:border-ink transition-colors"
              >
                <ChevronLeft size={18} />
              </button>
              <button
                type="button"
                onClick={next}
                aria-label="Наступне"
                className="absolute right-3 top-1/2 -translate-y-1/2 h-11 w-11 inline-flex items-center justify-center rounded-full bg-paper/95 text-ink border border-hairline-strong hover:bg-paper hover:border-ink transition-colors"
              >
                <ChevronRight size={18} />
              </button>
            </div>

            {/* Thumb strip */}
            <div className="mt-3 grid grid-cols-5 gap-2">
              {GALLERY.map((g, i) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setActiveImage(i)}
                  className={[
                    "relative aspect-[4/3] rounded-[var(--radius-sm)] overflow-hidden border transition-all",
                    i === activeImage
                      ? "border-ink ring-2 ring-ink ring-offset-2 ring-offset-canvas"
                      : "border-hairline hover:border-ink-soft opacity-80 hover:opacity-100",
                  ].join(" ")}
                  aria-label={`Фото ${i + 1}`}
                  aria-current={i === activeImage}
                >
                  <span
                    className="absolute inset-0 bg-cover bg-center"
                    style={{ backgroundImage: `url(${g.src})` }}
                  />
                </button>
              ))}
            </div>
          </div>

          {/* Sticky booking card */}
          <aside className="lg:sticky lg:top-24 self-start">
            <div className="border border-hairline rounded-[var(--radius-md)] bg-paper shadow-[var(--shadow-sm)] overflow-hidden">
              {/* price block */}
              <div className="p-6 md:p-7 border-b border-hairline">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
                    від
                  </span>
                </div>
                <div className="flex items-baseline gap-1">
                  <MoneyDisplay
                    kopecks={32000}
                    emphasize
                    className="font-display text-h1 text-ink leading-none tracking-tight"
                  />
                  <span className="text-body text-muted ml-1">/виклик</span>
                </div>
                <p className="mt-3 text-caption text-muted leading-relaxed">
                  Підсумкова вартість — після безкоштовної діагностики.
                  Виплата майстру лише після підтвердження роботи.
                </p>
              </div>

              {/* CTA */}
              <div className="p-6 md:p-7 border-b border-hairline space-y-3">
                <Button
                  size="lg"
                  variant="accent"
                  className="w-full"
                  rightIcon={<ArrowRight size={16} />}
                >
                  Замовити з ескроу
                </Button>
                <Button size="lg" variant="secondary" className="w-full">
                  Написати майстру
                </Button>
              </div>

              {/* trust strip */}
              <ul className="p-6 md:p-7 space-y-3">
                <TrustItem
                  icon={<Lock size={14} />}
                  title="Платіж заморожується в ескроу"
                  hint="Кошти повертаються, якщо угоду скасовано."
                />
                <TrustItem
                  icon={<ShieldCheck size={14} />}
                  title="KYC-підтверджений виконавець"
                  hint="Документи перевірено модерацією."
                />
                <TrustItem
                  icon={<Clock size={14} />}
                  title="Відповідає в межах 12 хвилин"
                  hint="Середнє за останні 30 днів."
                />
              </ul>

              {/* meta */}
              <div className="px-6 md:px-7 pb-6 md:pb-7 flex items-center justify-between text-caption text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <MapPin size={12} /> Київ · вся область
                </span>
                <CopyButton value="https://robotun.ua/l/L-21847" size="sm" />
              </div>
            </div>

            {/* Print-ish editorial caption */}
            <p className="mt-4 font-mono text-micro uppercase tracking-[0.18em] text-muted-soft">
              Ескроу-захист&nbsp;·&nbsp;Без прихованих комісій
            </p>
          </aside>
        </section>

        {/* ============================================================
            DETAILS — TABS  (description / inclusions / faq)
           ============================================================ */}
        <section className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-10 mb-20">
          <div className="min-w-0">
            <SectionHeading kicker="01 — Послуга">Що входить</SectionHeading>

            <Tabs defaultValue="about" className="mt-4">
              <TabsList>
                <TabsTrigger value="about">Опис</TabsTrigger>
                <TabsTrigger value="includes">Що входить</TabsTrigger>
                <TabsTrigger value="terms">Умови</TabsTrigger>
                <TabsTrigger value="faq">FAQ</TabsTrigger>
              </TabsList>

              <TabsContent value="about">
                <div className="grid grid-cols-1 md:grid-cols-12 gap-x-8 gap-y-4 mt-2">
                  <p className="md:col-span-7 text-body-lg text-ink leading-relaxed first-letter:font-display first-letter:text-[3.6rem] first-letter:leading-[0.85] first-letter:text-accent first-letter:float-left first-letter:mr-2 first-letter:mt-1">
                    Ремонтуємо пральні машини всіх популярних брендів — Bosch,
                    Siemens, AEG, Electrolux, LG, Samsung. Працюємо лише з
                    оригінальними запчастинами. Майстри з досвідом 8+ років
                    приїжджають з повним інструментом.
                  </p>
                  <aside className="md:col-span-5 md:border-l md:border-hairline md:pl-8">
                    <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted mb-3">
                      Що ми НЕ робимо
                    </p>
                    <ul className="text-caption text-ink-soft space-y-1.5">
                      <li>— ремонт промислового обладнання</li>
                      <li>— перевстановлення без виклику</li>
                      <li>— онлайн-консультації без діагностики</li>
                    </ul>
                  </aside>
                </div>

                <div className="mt-8 flex flex-wrap gap-2">
                  {["Bosch", "Siemens", "AEG", "Electrolux", "LG", "Samsung", "Whirlpool"].map(
                    (b) => (
                      <Tag key={b} variant="soft">
                        {b}
                      </Tag>
                    )
                  )}
                </div>
              </TabsContent>

              <TabsContent value="includes">
                <ul className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
                  {[
                    "Виїзд та діагностика — безкоштовно",
                    "Заміна підшипників, ТЕНів, насосів",
                    "Прошивка модулів управління",
                    "Усунення протікань та засмічень",
                    "Заміна манжет, амортизаторів",
                    "Гарантія 12 міс. на роботу",
                  ].map((x) => (
                    <li
                      key={x}
                      className="flex items-start gap-3 text-body text-ink-soft"
                    >
                      <CheckCircle2
                        size={18}
                        className="text-success shrink-0 mt-0.5"
                      />
                      <span>{x}</span>
                    </li>
                  ))}
                </ul>
              </TabsContent>

              <TabsContent value="terms">
                <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Term
                    n="01"
                    title="Передоплата"
                    body="Замовляєте через ескроу — кошти заморожуються, виконавець бачить підтвердження."
                  />
                  <Term
                    n="02"
                    title="Виконання"
                    body="Майстер приїжджає, проводить діагностику, узгоджує з вами обсяг та фінальну ціну."
                  />
                  <Term
                    n="03"
                    title="Підтвердження"
                    body="Після робіт ви приймаєте угоду — кошти переходять виконавцю. Якщо щось не так — диспут."
                  />
                </div>
              </TabsContent>

              <TabsContent value="faq">
                <div className="mt-2 space-y-3">
                  {[
                    {
                      q: "Чи виїжджаєте за межі Києва?",
                      a: "Так, область — додатковий збір 100–300₴ залежно від відстані.",
                    },
                    {
                      q: "Скільки триває діагностика?",
                      a: "20–40 хвилин. Якщо не беретесь за ремонт — діагностика безкоштовна.",
                    },
                    {
                      q: "Що з гарантією?",
                      a: "12 місяців на роботу та оригінальні запчастини. Підтвердження — у деталях угоди.",
                    },
                  ].map((f) => (
                    <details
                      key={f.q}
                      className="group border border-hairline rounded-[var(--radius-md)] bg-paper open:bg-elevated transition-colors"
                    >
                      <summary className="cursor-pointer list-none p-5 flex items-center justify-between gap-3">
                        <span className="font-display text-body-lg text-ink">
                          {f.q}
                        </span>
                        <span className="font-mono text-micro text-muted shrink-0 group-open:text-accent transition-colors">
                          [+]
                        </span>
                      </summary>
                      <p className="px-5 pb-5 text-body text-ink-soft leading-relaxed">
                        {f.a}
                      </p>
                    </details>
                  ))}
                </div>
              </TabsContent>
            </Tabs>
          </div>

          {/* Provider mini-panel (also part of layout, NOT sticky) */}
          <aside className="self-start">
            <SectionHeading kicker="02 — Виконавець" small>
              Хто працює
            </SectionHeading>
            <div className="mt-4 border border-hairline rounded-[var(--radius-md)] bg-paper p-6">
              <div className="flex items-start gap-4">
                <Avatar
                  src="https://i.pravatar.cc/120?img=12"
                  alt="Bosch Group Service"
                  size="lg"
                />
                <div className="min-w-0">
                  <h3 className="font-display text-h3 text-ink leading-tight">
                    Bosch Group Service
                  </h3>
                  <p className="text-caption text-muted mt-0.5">
                    Сервісний центр · Київ
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <RatingStars value={4.9} size="sm" />
                    <span className="font-mono text-caption tabular-nums text-ink-soft">
                      4.9
                    </span>
                    <span className="text-caption text-muted">· 320 відгуків</span>
                  </div>
                </div>
              </div>

              <p className="mt-5 text-body text-ink-soft leading-relaxed">
                Команда з 6 майстрів. Власний склад запчастин Bosch / Siemens.
                Працюємо щодня, 09:00–21:00.
              </p>

              <div className="mt-6 grid grid-cols-3 gap-3 text-center">
                <ProviderStat n="412" label="угод" />
                <ProviderStat n="98%" label="завершено" />
                <ProviderStat n="2014" label="на ринку" />
              </div>

              <div className="mt-6 flex flex-col gap-2">
                <Button variant="secondary" className="w-full">
                  Профіль виконавця
                </Button>
                <Button variant="ghost" className="w-full">
                  Усі його послуги (8)
                </Button>
              </div>

              <div className="mt-5 pt-5 border-t border-hairline flex items-center gap-2 text-caption text-muted">
                <ShieldCheck size={14} className="text-success" />
                Документи перевірено · KYC підтверджено 14.01.2026
              </div>
            </div>
          </aside>
        </section>

        {/* ============================================================
            REVIEWS
           ============================================================ */}
        <section className="mb-20">
          <SectionHeading kicker="03 — Відгуки">
            Що кажуть клієнти
          </SectionHeading>

          <div className="mt-6">
            <AggregateRating
              avgRating={4.9}
              totalCount={totalReviews}
              distribution={DISTRIBUTION}
            />
          </div>

          <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4">
            {REVIEWS.map((r) => (
              <ReviewCard
                key={r.id}
                data={r}
                onReport={() => {}}
                onReply={() => {}}
              />
            ))}
          </div>

          <div className="mt-8 flex items-center justify-between">
            <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
              Показано 3 з {totalReviews}
            </span>
            <Button variant="link" rightIcon={<ArrowRight size={14} />}>
              Усі відгуки
            </Button>
          </div>
        </section>

        {/* ============================================================
            RELATED
           ============================================================ */}
        <section className="border-t border-hairline pt-12">
          <div className="flex items-end justify-between mb-6">
            <SectionHeading kicker="04 — Поряд" small>
              Схожі послуги
            </SectionHeading>
            <Button variant="link" rightIcon={<ArrowRight size={14} />}>
              Усі в категорії
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {RELATED.map((l) => (
              <ListingCard key={l.id} data={l} />
            ))}
          </div>
        </section>

        {/* Editorial colophon */}
        <p className="mt-16 font-mono text-micro uppercase tracking-[0.22em] text-muted-soft text-center">
          Robotun&nbsp;·&nbsp;Послуга L-21847&nbsp;·&nbsp;
          <span className="text-accent">Захищено ескроу</span>
        </p>
      </main>

      {/* Mobile sticky CTA bar */}
      <div className="lg:hidden fixed bottom-14 left-0 right-0 z-40 border-t border-hairline bg-paper/95 backdrop-blur-md p-3 flex items-center gap-3">
        <div className="min-w-0">
          <p className="font-mono text-micro uppercase tracking-wider text-muted leading-none">
            від
          </p>
          <MoneyDisplay
            kopecks={32000}
            emphasize
            className="font-display text-h3 text-ink leading-none"
          />
        </div>
        <Button
          variant="accent"
          size="lg"
          className="flex-1"
          rightIcon={<ArrowRight size={16} />}
        >
          Замовити
        </Button>
      </div>

      <Footer />
      <MobileTabBar messagesUnread={12} />

      {/* Hide related ProviderCard helper to avoid unused import warnings during demo */}
      <div className="hidden">
        <ProviderCard
          data={{
            id: "ph",
            href: "#",
            displayName: "Bosch Group Service",
            avatarUrl: "https://i.pravatar.cc/120?img=12",
            avgRating: 4.9,
            reviewsCount: 320,
            kycVerified: true,
          }}
        />
        <Hammer />
      </div>
    </>
  );
}

/* ---------- local presentational helpers ---------- */

function SectionHeading({
  kicker,
  small,
  children,
}: {
  kicker: string;
  small?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="font-mono text-micro uppercase tracking-[0.22em] text-accent mb-2">
        {kicker}
      </p>
      <h2
        className={[
          "font-display text-ink tracking-tight leading-[1.05]",
          small ? "text-h2" : "text-h1",
        ].join(" ")}
      >
        {children}
      </h2>
    </div>
  );
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
        {label}
      </span>
      <div className="flex items-center gap-2 flex-wrap">{children}</div>
    </div>
  );
}

function TrustItem({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="h-7 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)] bg-accent-soft text-accent shrink-0 mt-0.5">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-body text-ink leading-tight">{title}</span>
        <span className="block text-caption text-muted mt-0.5 leading-snug">
          {hint}
        </span>
      </span>
    </li>
  );
}

function Term({
  n,
  title,
  body,
}: {
  n: string;
  title: string;
  body: string;
}) {
  return (
    <div className="border border-hairline rounded-[var(--radius-md)] bg-paper p-5 relative overflow-hidden">
      <span
        className="absolute -top-2 -right-2 font-display text-display text-canvas leading-none select-none"
        aria-hidden
      >
        {n}
      </span>
      <p className="relative font-mono text-micro uppercase tracking-[0.18em] text-accent mb-3">
        Крок {n}
      </p>
      <h4 className="relative font-display text-h3 text-ink leading-tight mb-2">
        {title}
      </h4>
      <p className="relative text-caption text-ink-soft leading-relaxed">
        {body}
      </p>
    </div>
  );
}

function ProviderStat({ n, label }: { n: string; label: string }) {
  return (
    <div className="border border-hairline rounded-[var(--radius-sm)] bg-canvas py-3">
      <div className="font-display text-h3 text-ink leading-none tabular-nums">
        {n}
      </div>
      <div className="font-mono text-micro uppercase tracking-[0.16em] text-muted mt-1">
        {label}
      </div>
    </div>
  );
}
