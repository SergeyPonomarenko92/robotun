"use client";
import { useState } from "react";
import { TopNav } from "@/components/organisms/TopNav";
import { MobileTabBar } from "@/components/organisms/MobileTabBar";
import { Footer } from "@/components/organisms/Footer";
import { ProviderHeader } from "@/components/organisms/ProviderHeader";
import { AggregateRating } from "@/components/organisms/AggregateRating";
import { ReviewCard, type ReviewCardData } from "@/components/organisms/ReviewCard";
import { ReviewForm } from "@/components/organisms/ReviewForm";
import { KYCStatusBadge, type KYCStatus } from "@/components/organisms/KYCStatusBadge";
import { WalletCard } from "@/components/organisms/WalletCard";
import { HoldExpiryWarning } from "@/components/organisms/HoldExpiryWarning";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { Button } from "@/components/ui/Button";
import { Modal, ModalClose } from "@/components/ui/Modal";
import { Tag } from "@/components/ui/Tag";
import { ListingCard, type ListingCardData } from "@/components/organisms/ListingCard";

const USER = {
  id: "u1",
  displayName: "Сергій П.",
  hasProviderRole: true,
};

const REVIEWS: ReviewCardData[] = [
  {
    id: "r1",
    rating: 5,
    body: "Майстер приїхав вчасно, швидко діагностував проблему — перегоріла плата управління. Замінив за 40 хвилин, дав гарантію на півроку. Все працює. Рекомендую.",
    createdAt: "2026-04-28T16:00:00Z",
    author: { displayName: "Олена К.", avatarUrl: "https://i.pravatar.cc/120?img=20" },
    dealRef: "DLR-7821",
    canReply: true,
    reply: {
      body: "Дякую за теплий відгук, Олено! Завжди до ваших послуг.",
      createdAt: "2026-04-29T09:30:00Z",
    },
  },
  {
    id: "r2",
    rating: 4,
    body: "Швидко і якісно. Мінус половини зірки — не привезли запасні фільтри як обіцяли в попередньому повідомленні, довелось замовляти окремо. В іншому — все ок.",
    createdAt: "2026-04-15T10:20:00Z",
    author: { displayName: "Микола П.", avatarUrl: "https://i.pravatar.cc/120?img=8" },
    dealRef: "DLR-7820",
    canReply: true,
    attachments: [
      { id: "a1", thumbUrl: "https://picsum.photos/seed/rev-1/200" },
      { id: "a2", thumbUrl: "https://picsum.photos/seed/rev-2/200" },
    ],
  },
  {
    id: "r3",
    rating: 3,
    body: "Робота виконана, але майстер запізнився на 2 години і не попередив. Якість самого ремонту — нормально.",
    createdAt: "2026-04-02T14:00:00Z",
    author: { displayName: "Анна Ш." },
    dealRef: "DLR-7755",
    canReply: true,
    status: "pending_takedown",
  },
  {
    id: "r4",
    rating: 1,
    body: "[відгук видалено]",
    createdAt: "2026-03-10T08:00:00Z",
    author: { displayName: "Прихований автор" },
    status: "removed",
  },
];

const PROVIDER_LISTINGS: ListingCardData[] = [
  {
    id: "l1",
    href: "#",
    title: "Ремонт пральних машин Bosch",
    coverUrl: "https://picsum.photos/seed/r-l1/640/480",
    priceFromKopecks: 32000,
    priceUnit: "/виклик",
    city: "Київ",
    category: "Ремонт техніки",
    provider: { name: "Bosch Group", kycVerified: true, avgRating: 4.9, reviewsCount: 320 },
    flags: ["Топ-1%"],
  },
  {
    id: "l2",
    href: "#",
    title: "Ремонт холодильників Bosch / Siemens",
    coverUrl: "https://picsum.photos/seed/r-l-fridge/640/480",
    priceFromKopecks: 45000,
    priceUnit: "/виклик",
    city: "Київ",
    category: "Ремонт техніки",
    provider: { name: "Bosch Group", kycVerified: true, avgRating: 4.9, reviewsCount: 320 },
  },
];

const KYC_STATES: KYCStatus[] = [
  "not_started",
  "submitted",
  "approved",
  "rejected",
  "expired",
  "rekyc_required",
  "suspended",
];

export default function ProfileDemoPage() {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [kycPick, setKycPick] = useState<KYCStatus>("approved");

  return (
    <>
      <TopNav user={{ ...USER, displayName: "Bosch Group", kycVerified: true }} role="provider" />
      <main className="mx-auto max-w-6xl px-4 md:px-6 pb-24 md:pb-16">
        <ProviderHeader
          data={{
            displayName: "Bosch Group Service",
            headline: "Сервісний центр з 2014 року. Bosch · Siemens · AEG · Whirlpool",
            bio: "Ми — команда з 6 інженерів. Виїжджаємо в межах Києва і області, тримаємо склад оригінальних запчастин. На всі роботи — гарантія від 6 до 18 місяців.",
            avatarUrl: "https://i.pravatar.cc/200?img=12",
            city: "Київ",
            region: "Київська обл.",
            languages: ["Українська", "English"],
            kycVerified: true,
            memberSince: "з 2024",
            avgRating: 4.93,
            reviewsCount: 320,
            completedDealsCount: 412,
            flags: ["Топ-1% у Києві"],
          }}
          primaryAction={<Button size="lg">Звʼязатись</Button>}
          secondaryAction={
            <Button size="lg" variant="secondary">
              До лістингів
            </Button>
          }
        />

        <Tabs defaultValue="listings" className="mt-12">
          <TabsList>
            <TabsTrigger value="listings" count={2}>Послуги</TabsTrigger>
            <TabsTrigger value="reviews" count={REVIEWS.length}>Відгуки</TabsTrigger>
            <TabsTrigger value="payments">Гроші</TabsTrigger>
            <TabsTrigger value="kyc">KYC</TabsTrigger>
          </TabsList>

          <TabsContent value="listings">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {PROVIDER_LISTINGS.map((l) => (
                <ListingCard key={l.id} data={l} />
              ))}
            </div>
          </TabsContent>

          <TabsContent value="reviews">
            <div className="space-y-6">
              <AggregateRating
                avgRating={4.93}
                totalCount={320}
                distribution={{ 5: 240, 4: 60, 3: 12, 2: 5, 1: 3 }}
              />
              <div className="flex justify-between items-center">
                <h3 className="font-display text-h2 text-ink tracking-tight">
                  Останні відгуки
                </h3>
                <Modal
                  open={reviewOpen}
                  onOpenChange={setReviewOpen}
                  trigger={<Button>Залишити відгук</Button>}
                  title="Як пройшла угода?"
                  description="Чесний відгук допомагає іншим клієнтам обрати майстра."
                  size="xl"
                >
                  <ReviewForm
                    contextLabel="Угода DLR-9af3 · Bosch Group Service"
                    onCancel={() => setReviewOpen(false)}
                    onSubmit={() => setReviewOpen(false)}
                  />
                </Modal>
              </div>
              <div className="grid grid-cols-1 gap-4">
                {REVIEWS.map((r) => (
                  <ReviewCard key={r.id} data={r} onReport={() => {}} onReply={() => {}} />
                ))}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="payments">
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">
              <div className="space-y-6">
                <HoldExpiryWarning
                  dealId="9af3"
                  amountKopecks={1200000}
                  hoursRemaining={4}
                  affects="client"
                  onApprove={() => {}}
                />
                <HoldExpiryWarning
                  dealId="7831"
                  amountKopecks={3500000}
                  hoursRemaining={22}
                  affects="provider"
                  onApprove={() => {}}
                  onCancel={() => {}}
                />
              </div>
              <WalletCard
                data={{
                  availableKopecks: 4820000,
                  heldKopecks: 1200000,
                  pendingPayoutKopecks: 350000,
                }}
                onPayout={() => {}}
              />
            </div>
            <div className="mt-8 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">
              <p className="text-body text-muted">
                Для прикладу — KYC заблокований стан гаманця:
              </p>
              <WalletCard
                data={{
                  availableKopecks: 1850000,
                  heldKopecks: 0,
                  pendingPayoutKopecks: 0,
                }}
                payoutBlockedReason="Виплати недоступні до проходження KYC. Перейдіть у вкладку KYC, щоб розпочати."
              />
            </div>
          </TabsContent>

          <TabsContent value="kyc">
            <div className="space-y-6">
              <p className="text-body text-muted">
                Натисніть на статус — побачите всі варіанти KYCStatusBadge.
              </p>
              <div className="flex flex-wrap gap-2">
                {KYC_STATES.map((s) => (
                  <Tag
                    key={s}
                    interactive
                    selected={kycPick === s}
                    onClick={() => setKycPick(s)}
                  >
                    {s}
                  </Tag>
                ))}
              </div>
              <div className="border border-hairline rounded-[var(--radius-md)] bg-paper p-8 flex items-center gap-4 flex-wrap">
                <KYCStatusBadge status={kycPick} expiresAt="2027-03-15T00:00:00Z" />
                <KYCStatusBadge status={kycPick} expiresAt="2027-03-15T00:00:00Z" size="sm" />
              </div>
              <p className="font-mono text-caption text-muted-soft">
                expiresAt відображається лише для approved
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </main>
      <Footer />
      <MobileTabBar />
    </>
  );
}
