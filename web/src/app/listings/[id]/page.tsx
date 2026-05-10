"use client";
import * as React from "react";
import { useParams } from "next/navigation";
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
  Loader2,
} from "lucide-react";

import { TopNav } from "@/components/organisms/TopNav";
import { MobileTabBar } from "@/components/organisms/MobileTabBar";
import { Footer } from "@/components/organisms/Footer";
import {
  AggregateRating,
  type RatingDistribution,
} from "@/components/organisms/AggregateRating";
import { ReviewCard } from "@/components/organisms/ReviewCard";
import { ListingCard } from "@/components/organisms/ListingCard";
import { EditorialPageHeader } from "@/components/organisms/EditorialPageHeader";

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
import { ErrorState } from "@/components/ui/ErrorState";

import {
  useListing,
  useListingsByIds,
  reviewToCard,
  projectionToCard,
  type ListingDetail,
} from "@/lib/feed";

export default function ListingDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const listing = useListing(id);

  if (listing.loading) {
    return <PageFrame><LoaderBlock /></PageFrame>;
  }
  if (listing.notFound) {
    return (
      <PageFrame>
        <ErrorState
          kind="not_found"
          title="Послугу не знайдено"
          description="Можливо, її було знято з публікації або URL змінився."
          variant="page"
        />
      </PageFrame>
    );
  }
  if (listing.error || !listing.data) {
    return (
      <PageFrame>
        <ErrorState
          kind="server"
          title="Не вдалось завантажити послугу"
          onRetry={() => window.location.reload()}
        />
      </PageFrame>
    );
  }

  return <ListingDetailView data={listing.data} />;
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopNav notificationsUnread={0} messagesUnread={0} />
      <main className="mx-auto max-w-7xl px-4 md:px-6 py-20 md:py-32">
        {children}
      </main>
      <Footer />
      <MobileTabBar />
    </>
  );
}

function LoaderBlock() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <Loader2 size={20} className="animate-spin text-muted" />
    </div>
  );
}

function ListingDetailView({ data }: { data: ListingDetail }) {
  const [activeImage, setActiveImage] = React.useState(0);
  const [saved, setSaved] = React.useState(false);

  const distribution: RatingDistribution = data.aggregate_rating.distribution;
  const totalReviews = data.aggregate_rating.total;
  const reviewCards = data.reviews_preview.map(reviewToCard);

  const next = () => setActiveImage((i) => (i + 1) % data.gallery.length);
  const prev = () =>
    setActiveImage(
      (i) => (i - 1 + data.gallery.length) % data.gallery.length
    );

  const related = useListingsByIds(data.related_ids);

  const publishedDate = new Date(data.published_at).toLocaleDateString(
    "uk-UA",
    { day: "numeric", month: "long", year: "numeric" }
  );

  return (
    <>
      <TopNav notificationsUnread={0} messagesUnread={0} />

      <main className="mx-auto max-w-7xl px-4 md:px-6 pt-6 md:pt-8 pb-32 md:pb-20">
        <Breadcrumbs
          className="mb-8"
          items={[
            { label: "Усі категорії", href: "/categories" },
            { label: data.category, href: `/feed?category_id=${data.category_id}` },
            { label: data.title.slice(0, 40) + "…" },
          ]}
        />

        <EditorialPageHeader
          align="start"
          kicker={
            <span className="flex flex-wrap items-center gap-3 normal-case tracking-[0.18em]">
              <span>
                Послуга №&nbsp;
                <span className="text-ink-soft">{data.id.slice(0, 8)}</span>
              </span>
              <span className="h-1 w-1 rounded-full bg-hairline-strong" aria-hidden />
              <span>
                Опубліковано&nbsp;
                <span className="text-ink-soft">{publishedDate}</span>
              </span>
              {data.flags.includes("Топ-1%") && (
                <Badge tone="ink" size="sm" shape="square">
                  Топ-1%
                </Badge>
              )}
              {data.provider.kyc_verified && (
                <Badge tone="success" size="sm" shape="square">
                  <ShieldCheck size={10} className="mr-0.5" />
                  KYC
                </Badge>
              )}
            </span>
          }
          title={
            <>
              {splitTitle(data.title).head}
              <br />
              <span className="text-accent italic">
                {splitTitle(data.title).accent}
              </span>
              {splitTitle(data.title).tail && (
                <>
                  <br />
                  <span className="text-ink-soft">
                    {splitTitle(data.title).tail}
                  </span>
                </>
              )}
            </>
          }
          description={data.description}
          sidecar={
            <div className="border border-hairline rounded-[var(--radius-md)] bg-elevated p-5 grid grid-cols-2 lg:grid-cols-1 gap-4 lg:gap-3 h-full">
              <Stat label="Рейтинг">
                <span className="font-display text-h2 text-ink leading-none">
                  {data.aggregate_rating.avg.toFixed(1)}
                </span>
                <RatingStars value={data.aggregate_rating.avg} size="sm" />
              </Stat>
              <Stat label="Виконано угод">
                <span className="font-display text-h2 text-ink leading-none tabular-nums">
                  {data.provider.completed_deals_count}
                </span>
              </Stat>
              {data.response_time && (
                <Stat label="Відповідь">
                  <span className="font-display text-h2 text-ink leading-none">
                    ~{data.response_time.replace(/[^0-9]/g, "") || "—"}
                    <span className="text-muted text-h3">хв</span>
                  </span>
                </Stat>
              )}
              <Stat label="Гарантія">
                <span className="font-display text-h2 text-ink leading-none">
                  {data.warranty_months}
                  <span className="text-muted text-h3">міс</span>
                </span>
              </Stat>
            </div>
          }
        />

        {/* HERO + sticky booking */}
        <section className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6 lg:gap-10 mb-16 md:mb-24">
          <div className="min-w-0">
            <div className="relative overflow-hidden rounded-[var(--radius-md)] border border-hairline bg-canvas">
              <div
                className="aspect-[4/3] md:aspect-[16/10] bg-cover bg-center transition-[background-image] duration-[var(--duration-slow)] ease-[var(--ease-standard)]"
                style={{
                  backgroundImage: `url(${data.gallery[activeImage]?.url})`,
                }}
                aria-label={data.gallery[activeImage]?.alt}
                role="img"
              />
              <div className="absolute top-4 left-4 px-2.5 py-1 rounded-[var(--radius-pill)] bg-ink/85 text-paper font-mono text-micro tracking-wider tabular-nums backdrop-blur-sm">
                {String(activeImage + 1).padStart(2, "0")} /{" "}
                {String(data.gallery.length).padStart(2, "0")}
              </div>
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

            <div className="mt-3 grid grid-cols-5 gap-2">
              {data.gallery.slice(0, 5).map((g, i) => (
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
                    style={{ backgroundImage: `url(${g.url})` }}
                  />
                </button>
              ))}
            </div>
          </div>

          <aside className="lg:sticky lg:top-24 self-start">
            <div className="border border-hairline rounded-[var(--radius-md)] bg-paper shadow-[var(--shadow-sm)] overflow-hidden">
              <div className="p-6 md:p-7 border-b border-hairline">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
                    від
                  </span>
                </div>
                <div className="flex items-baseline gap-1">
                  <MoneyDisplay
                    kopecks={data.price_from_kopecks}
                    emphasize
                    className="font-display text-h1 text-ink leading-none tracking-tight"
                  />
                  <span className="text-body text-muted ml-1">
                    {data.price_unit}
                  </span>
                </div>
                <p className="mt-3 text-caption text-muted leading-relaxed">
                  Орієнтовний діапазон:{" "}
                  <MoneyDisplay
                    kopecks={data.price_range_kopecks.min}
                    showSymbol={false}
                  />
                  –
                  <MoneyDisplay kopecks={data.price_range_kopecks.max} />.
                  Підсумкова ціна — після безкоштовної діагностики.
                </p>
              </div>

              <div className="p-6 md:p-7 border-b border-hairline space-y-3">
                <a href={`/deal-create?listing=${encodeURIComponent(data.id)}`}>
                  <Button
                    size="lg"
                    variant="accent"
                    className="w-full"
                    rightIcon={<ArrowRight size={16} />}
                  >
                    Замовити з ескроу
                  </Button>
                </a>
                <Button size="lg" variant="secondary" className="w-full">
                  Написати майстру
                </Button>
              </div>

              <ul className="p-6 md:p-7 space-y-3">
                <TrustItem
                  icon={<Lock size={14} />}
                  title="Платіж заморожується в ескроу"
                  hint="Кошти повертаються, якщо угоду скасовано."
                />
                {data.provider.kyc_verified && (
                  <TrustItem
                    icon={<ShieldCheck size={14} />}
                    title="KYC-підтверджений виконавець"
                    hint="Документи перевірено модерацією."
                  />
                )}
                {data.response_time && (
                  <TrustItem
                    icon={<Clock size={14} />}
                    title={`Відповідає ${data.response_time}`}
                    hint="Середнє за останні 30 днів."
                  />
                )}
              </ul>

              <div className="px-6 md:px-7 pb-6 md:pb-7 flex items-center justify-between text-caption text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <MapPin size={12} /> {data.city}
                  {data.region ? ` · ${data.region}` : ""}
                </span>
                <CopyButton
                  value={
                    typeof window !== "undefined"
                      ? window.location.href
                      : `/listings/${data.id}`
                  }
                  size="sm"
                />
              </div>
            </div>

            <p className="mt-4 font-mono text-micro uppercase tracking-[0.18em] text-muted-soft">
              Ескроу-захист&nbsp;·&nbsp;Без прихованих комісій
            </p>
          </aside>
        </section>

        {/* DETAILS Tabs + provider mini */}
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
                    {data.description}
                  </p>
                  {data.excludes.length > 0 && (
                    <aside className="md:col-span-5 md:border-l md:border-hairline md:pl-8">
                      <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted mb-3">
                        Що ми НЕ робимо
                      </p>
                      <ul className="text-caption text-ink-soft space-y-1.5">
                        {data.excludes.map((x) => (
                          <li key={x}>— {x}</li>
                        ))}
                      </ul>
                    </aside>
                  )}
                </div>

                {data.brand_tags.length > 0 && (
                  <div className="mt-8 flex flex-wrap gap-2">
                    {data.brand_tags.map((b) => (
                      <Tag key={b} variant="soft">
                        {b}
                      </Tag>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="includes">
                <ul className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
                  {data.includes.map((x) => (
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
                  {data.faq.map((f) => (
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

          <aside className="self-start">
            <SectionHeading kicker="02 — Виконавець" small>
              Хто працює
            </SectionHeading>
            <div className="mt-4 border border-hairline rounded-[var(--radius-md)] bg-paper p-6">
              <div className="flex items-start gap-4">
                <Avatar
                  src={data.provider.avatar_url}
                  alt={data.provider.name}
                  size="lg"
                />
                <div className="min-w-0">
                  <h3 className="font-display text-h3 text-ink leading-tight">
                    {data.provider.name}
                  </h3>
                  <p className="text-caption text-muted mt-0.5">
                    {data.category} · {data.city}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <RatingStars
                      value={data.provider.avg_rating}
                      size="sm"
                    />
                    <span className="font-mono text-caption tabular-nums text-ink-soft">
                      {data.provider.avg_rating.toFixed(1)}
                    </span>
                    <span className="text-caption text-muted">
                      · {data.provider.reviews_count} відгуків
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-6 grid grid-cols-3 gap-3 text-center">
                <ProviderStat
                  n={data.provider.completed_deals_count.toString()}
                  label="угод"
                />
                <ProviderStat
                  n={`${Math.round(data.provider.avg_rating * 20)}%`}
                  label="задоволені"
                />
                <ProviderStat n={`12+`} label="досвід" />
              </div>

              <div className="mt-6 flex flex-col gap-2">
                <Button variant="secondary" className="w-full">
                  Профіль виконавця
                </Button>
              </div>

              {data.provider.kyc_verified && (
                <div className="mt-5 pt-5 border-t border-hairline flex items-center gap-2 text-caption text-muted">
                  <ShieldCheck size={14} className="text-success" />
                  Документи перевірено · KYC підтверджено
                </div>
              )}
            </div>
          </aside>
        </section>

        {/* REVIEWS */}
        {totalReviews > 0 && (
          <section className="mb-20">
            <SectionHeading kicker="03 — Відгуки">
              Що кажуть клієнти
            </SectionHeading>

            <div className="mt-6">
              <AggregateRating
                avgRating={data.aggregate_rating.avg}
                totalCount={totalReviews}
                distribution={distribution}
              />
            </div>

            {reviewCards.length > 0 && (
              <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4">
                {reviewCards.map((r) => (
                  <ReviewCard
                    key={r.id}
                    data={r}
                    onReport={() => {}}
                    onReply={() => {}}
                  />
                ))}
              </div>
            )}

            <div className="mt-8 flex items-center justify-between">
              <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
                Показано {reviewCards.length} з {totalReviews}
              </span>
              <Button variant="link" rightIcon={<ArrowRight size={14} />}>
                Усі відгуки
              </Button>
            </div>
          </section>
        )}

        {/* RELATED */}
        {related.items.length > 0 && (
          <section className="border-t border-hairline pt-12">
            <div className="flex items-end justify-between mb-6">
              <SectionHeading kicker="04 — Поряд" small>
                Схожі послуги
              </SectionHeading>
              <Button
                variant="link"
                rightIcon={<ArrowRight size={14} />}
              >
                Усі в категорії
              </Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {related.items.map((p) => (
                <ListingCard key={p.id} data={projectionToCard(p)} />
              ))}
            </div>
          </section>
        )}

        <p className="mt-16 font-mono text-micro uppercase tracking-[0.22em] text-muted-soft text-center">
          Robotun&nbsp;·&nbsp;Послуга {data.id.slice(0, 8)}&nbsp;·&nbsp;
          <span className="text-accent">Захищено ескроу</span>
        </p>
      </main>

      {/* Mobile sticky CTA */}
      <div className="lg:hidden fixed bottom-14 left-0 right-0 z-40 border-t border-hairline bg-paper/95 backdrop-blur-md p-3 flex items-center gap-3">
        <div className="min-w-0">
          <p className="font-mono text-micro uppercase tracking-wider text-muted leading-none">
            від
          </p>
          <MoneyDisplay
            kopecks={data.price_from_kopecks}
            emphasize
            className="font-display text-h3 text-ink leading-none"
          />
        </div>
        <a
          href={`/deal-create?listing=${encodeURIComponent(data.id)}`}
          className="flex-1"
        >
          <Button
            variant="accent"
            size="lg"
            className="w-full"
            rightIcon={<ArrowRight size={16} />}
          >
            Замовити
          </Button>
        </a>
      </div>

      <Footer />
      <MobileTabBar />
    </>
  );
}

/* ---------- helpers ---------- */

function splitTitle(t: string): { head: string; accent: string; tail?: string } {
  // Heuristic split for editorial display: take a middle slice as accent if
  // there's an obvious branding phrase ("Bosch / Siemens" etc). Otherwise
  // first 2-3 words are head, the rest accent.
  const dashIdx = t.indexOf(" — ");
  if (dashIdx > 0) {
    return {
      head: t.slice(0, dashIdx),
      accent: t.slice(dashIdx + 3),
    };
  }
  const words = t.split(" ");
  if (words.length <= 3) return { head: t, accent: "" };
  return {
    head: words.slice(0, 2).join(" "),
    accent: words.slice(2).join(" "),
  };
}

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
