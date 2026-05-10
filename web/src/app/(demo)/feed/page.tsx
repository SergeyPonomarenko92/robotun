"use client";
import { useMemo, useState } from "react";
import { TopNav } from "@/components/organisms/TopNav";
import { MobileTabBar } from "@/components/organisms/MobileTabBar";
import { Footer } from "@/components/organisms/Footer";
import { ListingCard } from "@/components/organisms/ListingCard";
import { ProviderCard, type ProviderCardData } from "@/components/organisms/ProviderCard";
import {
  FilterPanel,
  type FilterValue,
} from "@/components/organisms/FilterPanel";
import { SortDropdown, type SortKey } from "@/components/organisms/SortDropdown";
import { NoResultsState } from "@/components/organisms/NoResultsState";
import { Drawer, DrawerClose } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { Pagination } from "@/components/ui/Pagination";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { ErrorState } from "@/components/ui/ErrorState";
import { Filter, ArrowRight, Loader2 } from "lucide-react";
import { useFeed, projectionToCard, type FeedFilters } from "@/lib/feed";

const USER = {
  id: "u1",
  displayName: "Сергій П.",
  email: "aks74ym@gmail.com",
  kycVerified: true,
  hasProviderRole: true,
};


const PROVIDERS: ProviderCardData[] = [
  {
    id: "p1",
    href: "#",
    displayName: "Bosch Group Service",
    headline: "Сервісний центр з 2014 року. Bosch · Siemens · AEG",
    avatarUrl: "https://i.pravatar.cc/120?img=12",
    city: "Київ",
    kycVerified: true,
    avgRating: 4.9,
    reviewsCount: 320,
    completedDealsCount: 412,
    priceFromKopecks: 32000,
    badgeLabel: "Топ-1% у Києві",
  },
  {
    id: "p2",
    href: "#",
    displayName: "Wood Atelier",
    headline: "Меблі під замовлення з масиву та шпонованих плит",
    avatarUrl: "https://i.pravatar.cc/120?img=44",
    city: "Дніпро",
    kycVerified: true,
    avgRating: 5,
    reviewsCount: 14,
    completedDealsCount: 14,
    priceFromKopecks: 1850000,
  },
];

const CITIES = ["Київ", "Львів", "Харків", "Одеса", "Дніпро", "Запоріжжя", "Вінниця"];
const CATEGORIES = [
  { id: "el", label: "Електрика", count: 184 },
  { id: "rep", label: "Ремонт техніки", count: 247 },
  { id: "clean", label: "Прибирання", count: 1240 },
  { id: "plumb", label: "Сантехніка", count: 412 },
  { id: "furn", label: "Меблі", count: 86 },
  { id: "fix", label: "Дрібний ремонт", count: 320 },
];

export default function FeedDemoPage() {
  const [filters, setFilters] = useState<FilterValue>({
    priceRange: [0, 1000000],
    cities: ["Київ"],
    ratingMin: 4,
    kycOnly: true,
    withReviewsOnly: false,
    categories: ["el"],
  });
  const [sort, setSort] = useState<SortKey>("relevance");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [savedIds, setSavedIds] = useState<Record<string, boolean>>({});

  const handleSave = (id: string, next: boolean) =>
    setSavedIds((s) => ({ ...s, [id]: next }));

  const reset = () =>
    setFilters({
      priceRange: [0, 1000000],
      cities: [],
      ratingMin: null,
      kycOnly: false,
      withReviewsOnly: false,
      categories: [],
    });

  // Map UI filter shape → server contract. Spec REQ-001 takes singular
  // category_id / city — pick first selected (multi-select is FE-only sugar
  // for now; real backend can accept repeated params later).
  const serverFilters: FeedFilters = useMemo(
    () => ({
      category_id: filters.categories[0] ?? null,
      city: filters.cities[0] ?? null,
      price_min: filters.priceRange[0] > 0 ? filters.priceRange[0] : null,
      price_max:
        filters.priceRange[1] < 1_000_000 ? filters.priceRange[1] : null,
      min_rating: filters.ratingMin,
      kyc_only: filters.kycOnly,
    }),
    [filters]
  );

  const feed = useFeed(serverFilters, 12);
  const cards = useMemo(
    () =>
      feed.items.map((p) => {
        const card = projectionToCard(p);
        return { ...card, saved: savedIds[card.id] ?? false };
      }),
    [feed.items, savedIds]
  );

  return (
    <>
      <TopNav
        user={USER}
        notificationsUnread={3}
        messagesUnread={12}
        searchSuggestions={[
          { id: "1", label: "ремонт пральних машин bosch" },
          { id: "2", label: "прибирання київ" },
        ]}
      />
      <main className="mx-auto max-w-7xl px-4 md:px-6 py-6 md:py-10 pb-24 md:pb-16">
        <Breadcrumbs
          className="mb-6"
          items={[
            { label: "Усі категорії", href: "/categories" },
            { label: "Послуги вдома", href: "#" },
            { label: "Електрика та техніка" },
          ]}
        />
        <header className="mb-8">
          <h1 className="font-display text-h1 md:text-display text-ink tracking-tight leading-[1.05]">
            Майстри поряд<br />
            <span className="text-accent">{filters.cities[0] ?? "усюди"}</span>
            {" · "}
            <span className="tabular-nums">
              {feed.loading ? "…" : feed.totalEstimate}
            </span>
            {" "}пропозицій
          </h1>
          <p className="mt-4 text-body-lg text-muted max-w-xl leading-relaxed">
            Перевірені виконавці. Гарантія через ескроу. Жодних прихованих комісій.
          </p>
        </header>

        <Tabs defaultValue="listings" className="mb-6">
          <TabsList>
            <TabsTrigger value="listings" count={feed.totalEstimate}>
              Послуги
            </TabsTrigger>
            <TabsTrigger value="providers" count={2}>
              Майстри
            </TabsTrigger>
            <TabsTrigger value="needs">Потреби</TabsTrigger>
          </TabsList>

          <TabsContent value="listings">
            <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-8">
              {/* Desktop sidebar */}
              <div className="hidden lg:block">
                <div className="sticky top-24">
                  <FilterPanel
                    value={filters}
                    onChange={setFilters}
                    cities={CITIES}
                    categories={CATEGORIES}
                    onReset={reset}
                    resultsCount={feed.totalEstimate}
                    onApply={() => {}}
                  />
                </div>
              </div>

              <div className="min-w-0">
                {/* Toolbar */}
                <div className="flex items-center justify-between gap-3 mb-5">
                  <div className="flex items-center gap-2 lg:hidden">
                    <Drawer
                      open={drawerOpen}
                      onOpenChange={setDrawerOpen}
                      side="bottom"
                      title="Фільтри"
                      trigger={
                        <Button variant="secondary" leftIcon={<Filter size={14} />}>
                          Фільтри
                        </Button>
                      }
                      footer={
                        <>
                          <Button variant="ghost" onClick={reset}>Скинути</Button>
                          <DrawerClose asChild>
                            <Button>Застосувати</Button>
                          </DrawerClose>
                        </>
                      }
                    >
                      <FilterPanel
                        value={filters}
                        onChange={setFilters}
                        cities={CITIES}
                        categories={CATEGORIES}
                      />
                    </Drawer>
                  </div>
                  <p className="font-mono text-caption text-muted-soft tabular-nums hidden md:block">
                    {feed.loading ? "…" : `${feed.totalEstimate} результатів`}
                  </p>
                  <div className="ml-auto flex items-center gap-2">
                    <SortDropdown value={sort} onChange={setSort} size="sm" />
                  </div>
                </div>

                {feed.error ? (
                  <ErrorState
                    kind="server"
                    title="Не вдалось завантажити стрічку"
                    description="Спробуйте оновити сторінку. Якщо проблема не зникає — повідомте підтримку."
                    onRetry={() => window.location.reload()}
                  />
                ) : feed.loading ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <ListingSkeleton key={i} />
                    ))}
                  </div>
                ) : cards.length === 0 ? (
                  <NoResultsState
                    query={filters.cities[0] ?? "за вашими фільтрами"}
                    suggestions={[
                      "ремонт телевізорів",
                      "ремонт пилососів",
                      "встановити кондиціонер",
                    ]}
                    onResetFilters={reset}
                  />
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {cards.map((card) => (
                        <ListingCard
                          key={card.id}
                          data={card}
                          onSaveToggle={handleSave}
                        />
                      ))}
                    </div>
                    <Pagination
                      hasMore={!!feed.nextCursor}
                      loaded={feed.items.length}
                      total={feed.totalEstimate}
                      onLoadMore={() => void feed.loadMore()}
                    />
                    {feed.loadingMore && (
                      <div className="mt-4 flex items-center justify-center text-caption text-muted">
                        <Loader2 size={14} className="animate-spin mr-2" />
                        Завантажуємо…
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="providers">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {PROVIDERS.map((p) => (
                <ProviderCard key={p.id} data={p} />
              ))}
            </div>
            <h3 className="mt-12 font-mono text-micro uppercase tracking-loose text-muted-soft mb-3">
              Row variant
            </h3>
            <div className="border border-hairline rounded-[var(--radius-md)] bg-paper divide-y divide-hairline">
              {PROVIDERS.map((p) => (
                <ProviderCard key={p.id + "-row"} data={p} variant="row" />
              ))}
            </div>
          </TabsContent>

          <TabsContent value="needs">
            <NoResultsState
              query="потреби"
              suggestions={["вивезти меблі", "збити стяжку", "встановити кондиціонер"]}
            />
          </TabsContent>
        </Tabs>

        {/* Card variant galleries — slice from live feed for design preview */}
        {cards.length > 0 && (
          <>
            <section className="mt-16">
              <h2 className="font-display text-h2 text-ink tracking-tight mb-4">
                ListingCard — row variant
              </h2>
              <div className="flex flex-col gap-3">
                {cards.slice(0, 3).map((c) => (
                  <ListingCard
                    key={c.id + "-row"}
                    variant="row"
                    data={c}
                    onSaveToggle={handleSave}
                  />
                ))}
              </div>
            </section>

            <section className="mt-12">
              <h2 className="font-display text-h2 text-ink tracking-tight mb-4">
                ListingCard — compact
              </h2>
              <div className="border border-hairline rounded-[var(--radius-md)] bg-paper p-2 max-w-md">
                {cards.slice(0, 4).map((c) => (
                  <ListingCard key={c.id + "-c"} variant="compact" data={c} />
                ))}
              </div>
            </section>
          </>
        )}

        <div className="mt-16 flex justify-end">
          <Button variant="link" rightIcon={<ArrowRight size={14} />}>
            До styleguide
          </Button>
        </div>
      </main>
      <Footer />
      <MobileTabBar messagesUnread={12} />
    </>
  );
}

function ListingSkeleton() {
  return (
    <div className="border border-hairline rounded-[var(--radius-md)] bg-paper overflow-hidden animate-pulse">
      <div className="aspect-[4/3] bg-canvas" />
      <div className="p-4 space-y-2">
        <div className="h-3 w-1/3 bg-canvas rounded" />
        <div className="h-5 w-4/5 bg-canvas rounded" />
        <div className="h-5 w-2/3 bg-canvas rounded" />
        <div className="flex items-center gap-2 pt-2">
          <div className="h-7 w-7 rounded-full bg-canvas" />
          <div className="h-3 w-1/2 bg-canvas rounded" />
        </div>
      </div>
    </div>
  );
}
