"use client";
import { useState } from "react";
import { TopNav } from "@/components/organisms/TopNav";
import { MobileTabBar } from "@/components/organisms/MobileTabBar";
import { Footer } from "@/components/organisms/Footer";
import { ListingCard, type ListingCardData } from "@/components/organisms/ListingCard";
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
import { Filter, ArrowRight } from "lucide-react";

const USER = {
  id: "u1",
  displayName: "Сергій П.",
  email: "aks74ym@gmail.com",
  kycVerified: true,
  hasProviderRole: true,
};

const LISTINGS: ListingCardData[] = [
  {
    id: "l1",
    href: "#",
    title: "Ремонт пральних машин Bosch / Siemens — виїзд по Києву",
    coverUrl: "https://picsum.photos/seed/r-l1/640/480",
    priceFromKopecks: 32000,
    priceUnit: "/виклик",
    city: "Київ",
    region: "Київська обл.",
    category: "Ремонт побутової техніки",
    provider: {
      name: "Bosch Group Service",
      avatarUrl: "https://i.pravatar.cc/120?img=12",
      kycVerified: true,
      avgRating: 4.9,
      reviewsCount: 320,
      completedDealsCount: 412,
    },
    flags: ["Топ-1%", "Швидкий"],
    responseTime: "відп. за 12 хв",
    saved: true,
  },
  {
    id: "l2",
    href: "#",
    title: "Прибирання після ремонту — генеральне з вивозом сміття",
    coverUrl: "https://picsum.photos/seed/r-l2/640/480",
    priceFromKopecks: 120000,
    priceUnit: "/обʼєкт",
    city: "Львів",
    category: "Прибирання",
    provider: {
      name: "CleanWave",
      avatarUrl: "https://i.pravatar.cc/120?img=22",
      kycVerified: true,
      avgRating: 4.7,
      reviewsCount: 184,
    },
  },
  {
    id: "l3",
    href: "#",
    title: "Електрик — заміна проводки, штробління, монтаж",
    coverUrl: "https://picsum.photos/seed/r-l3/640/480",
    priceFromKopecks: 50000,
    priceUnit: "/год",
    city: "Київ",
    category: "Електрика",
    provider: {
      name: "Микола Петренко",
      avatarUrl: "https://i.pravatar.cc/120?img=8",
      kycVerified: false,
      avgRating: 4.5,
      reviewsCount: 32,
    },
    flags: ["Новий"],
  },
  {
    id: "l4",
    href: "#",
    title: "Сантехніка — заміна змішувачів, унітаз, бойлер",
    coverUrl: "https://picsum.photos/seed/r-l4/640/480",
    priceFromKopecks: 45000,
    priceUnit: "/виклик",
    city: "Харків",
    category: "Сантехніка",
    provider: {
      name: "Олег Б.",
      avatarUrl: "https://i.pravatar.cc/120?img=15",
      kycVerified: true,
      avgRating: 4.8,
      reviewsCount: 92,
    },
  },
  {
    id: "l5",
    href: "#",
    title: "Меблі під замовлення — кухні, шафи-купе, гардеробні",
    coverUrl: "https://picsum.photos/seed/r-l5/640/480",
    priceFromKopecks: 1850000,
    priceUnit: "/проект",
    city: "Дніпро",
    category: "Меблі",
    provider: {
      name: "Wood Atelier",
      kycVerified: true,
      avgRating: 5,
      reviewsCount: 14,
    },
    flags: ["Преміум"],
  },
  {
    id: "l6",
    href: "#",
    title: "Майстер на годину — дрібний ремонт у квартирі",
    coverUrl: "https://picsum.photos/seed/r-l6/640/480",
    priceFromKopecks: 30000,
    priceUnit: "/год",
    city: "Київ",
    category: "Дрібний ремонт",
    provider: {
      name: "FixIt",
      avatarUrl: "https://i.pravatar.cc/120?img=33",
      kycVerified: true,
      avgRating: 4.6,
      reviewsCount: 247,
    },
  },
];

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
  const [savedIds, setSavedIds] = useState<Record<string, boolean>>({ l1: true });
  const [emptyMode, setEmptyMode] = useState(false);

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

  const visibleListings = emptyMode ? [] : LISTINGS;

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
            <span className="text-accent">Київ</span> · 6 пропозицій
          </h1>
          <p className="mt-4 text-body-lg text-muted max-w-xl leading-relaxed">
            Перевірені виконавці. Гарантія через ескроу. Жодних прихованих комісій.
          </p>
        </header>

        <Tabs defaultValue="listings" className="mb-6">
          <TabsList>
            <TabsTrigger value="listings" count={6}>Послуги</TabsTrigger>
            <TabsTrigger value="providers" count={2}>Майстри</TabsTrigger>
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
                    resultsCount={visibleListings.length}
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
                    {visibleListings.length} результатів
                  </p>
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEmptyMode((v) => !v)}
                    >
                      {emptyMode ? "З результатами" : "Порожній стан"}
                    </Button>
                    <SortDropdown value={sort} onChange={setSort} size="sm" />
                  </div>
                </div>

                {visibleListings.length === 0 ? (
                  <NoResultsState
                    query="ремонт ноутбука"
                    suggestions={[
                      "ремонт телевізорів",
                      "ремонт пилососів",
                      "ремонт мікрохвильовок",
                    ]}
                    onResetFilters={reset}
                    onSuggestionClick={() => setEmptyMode(false)}
                  />
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {visibleListings.map((l) => (
                        <ListingCard
                          key={l.id}
                          data={{ ...l, saved: savedIds[l.id] ?? l.saved }}
                          onSaveToggle={handleSave}
                        />
                      ))}
                    </div>
                    <Pagination
                      hasMore
                      loaded={6}
                      total={184}
                      onLoadMore={() => {}}
                    />
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

        {/* Listing card row variant gallery */}
        <section className="mt-16">
          <h2 className="font-display text-h2 text-ink tracking-tight mb-4">
            ListingCard — row variant
          </h2>
          <div className="flex flex-col gap-3">
            {LISTINGS.slice(0, 3).map((l) => (
              <ListingCard
                key={l.id + "-row"}
                variant="row"
                data={{ ...l, saved: savedIds[l.id] ?? l.saved }}
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
            {LISTINGS.slice(0, 4).map((l) => (
              <ListingCard key={l.id + "-c"} variant="compact" data={l} />
            ))}
          </div>
        </section>

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
