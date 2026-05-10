"use client";
import * as React from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowRight,
  ShieldCheck,
  Lock,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  ChevronRight,
  Loader2,
} from "lucide-react";

import { TopNav } from "@/components/organisms/TopNav";
import { MobileTabBar } from "@/components/organisms/MobileTabBar";
import { Footer } from "@/components/organisms/Footer";

import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { MoneyInput, MoneyDisplay } from "@/components/ui/MoneyInput";
import { DateTimePicker } from "@/components/ui/DateTimePicker";
import {
  FileUploader,
  type UploadedFile,
} from "@/components/ui/FileUploader";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Tag } from "@/components/ui/Tag";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { RatingStars } from "@/components/ui/RatingStars";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { Tooltip } from "@/components/ui/Tooltip";
import { RadioCardGroup } from "@/components/ui/RadioCardGroup";
import { TermCheckbox } from "@/components/ui/TermCheckbox";
import { ErrorState } from "@/components/ui/ErrorState";
import { EditorialPageHeader } from "@/components/organisms/EditorialPageHeader";
import { SuccessScreen } from "@/components/organisms/SuccessScreen";

import { useRequireAuth, type AuthUser } from "@/lib/auth";
import { useListing, type ListingDetail } from "@/lib/feed";
import { createDeal, type Deal, type Urgency as DealUrgency } from "@/lib/deals";

const URGENCY = [
  { id: "today", label: "Сьогодні", hint: "до кінця дня" },
  { id: "tomorrow", label: "Завтра", hint: "в межах 24 год" },
  { id: "week", label: "Цього тижня", hint: "гнучкий графік" },
  { id: "later", label: "Потім", hint: "погодимо в чаті" },
] as const;
type Urgency = DealUrgency;

const PLATFORM_FEE_PCT = 0.05;
const SCOPE_MIN = 40;
const SCOPE_MAX = 1500;

export default function DealCreatePage() {
  const auth = useRequireAuth("/login");
  const params = useSearchParams();
  const listingId = params?.get("listing") ?? null;
  const listing = useListing(listingId);

  if (!auth) {
    return <PageLoader />;
  }
  if (!listingId) {
    return (
      <PageFrame>
        <ErrorState
          kind="generic"
          title="Не вказано послугу"
          description="Перейдіть до /feed і оберіть послугу для замовлення."
          variant="page"
        />
      </PageFrame>
    );
  }
  if (listing.loading) return <PageLoader />;
  if (listing.notFound) {
    return (
      <PageFrame>
        <ErrorState
          kind="not_found"
          title="Послугу не знайдено"
          description="Можливо, її було знято з публікації."
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

  return <DealCreateForm me={auth.user} listing={listing.data} />;
}

function PageLoader() {
  return (
    <PageFrame>
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    </PageFrame>
  );
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

function DealCreateForm({
  me,
  listing,
}: {
  me: AuthUser;
  listing: ListingDetail;
}) {
  // Build LISTING/PROVIDER projection objects to keep the existing JSX
  // un-touched. Real data flows from the fetched ListingDetail + AuthUser.
  const LISTING = {
    id: listing.id,
    title: listing.title,
    category: listing.category,
    fromKopecks: listing.price_from_kopecks,
    unit: listing.price_unit,
    coverUrl:
      listing.gallery.find((g) => g.is_cover)?.url ??
      listing.gallery[0]?.url ??
      listing.cover_url,
  };
  const PROVIDER = {
    id: listing.provider.id,
    name: listing.provider.name,
    avatarUrl: listing.provider.avatar_url,
    city: listing.city,
    rating: listing.provider.avg_rating,
    reviewsCount: listing.provider.reviews_count,
    completedDealsCount: listing.provider.completed_deals_count,
    responseMin: Number(listing.response_time?.replace(/[^0-9]/g, "")) || 30,
    kycVerified: listing.provider.kyc_verified,
  };

  const [scope, setScope] = React.useState(
    `${listing.title}.\n\nБажаний час — гнучкий, узгодимо в чаті після підтвердження.`
  );
  const [budget, setBudget] = React.useState<number | null>(
    Math.max(50000, listing.price_from_kopecks * 2)
  );
  const [urgency, setUrgency] = React.useState<Urgency>("week");
  const [date, setDate] = React.useState<string>("");
  const [address, setAddress] = React.useState(`${listing.city}, `);
  const [phone, setPhone] = React.useState("+380 ");
  const [files, setFiles] = React.useState<UploadedFile[]>([]);
  const [agreeTerms, setAgreeTerms] = React.useState(true);
  const [agreeEscrow, setAgreeEscrow] = React.useState(true);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [createdDeal, setCreatedDeal] = React.useState<Deal | null>(null);

  // ---------- validation ----------
  const errors: string[] = [];
  if (scope.trim().length < SCOPE_MIN)
    errors.push(`Опишіть задачу детальніше — мінімум ${SCOPE_MIN} символів`);
  if (!budget || budget < 5000) errors.push("Бюджет — мінімум 50 ₴");
  if (!address.trim() || address.trim().length < 5)
    errors.push("Вкажіть адресу або район");
  if (!phone.trim() || phone.trim().length < 7)
    errors.push("Телефон обовʼязковий — для координації");
  if (!agreeTerms) errors.push("Підтвердіть умови сервісу");
  if (!agreeEscrow) errors.push("Підтвердіть роботу через ескроу");
  const valid = errors.length === 0;

  const handleSubmit = async () => {
    if (!valid || submitting || !budget) return;
    setSubmitError(null);
    setSubmitting(true);
    const result = await createDeal({
      listing_id: listing.id,
      scope: scope.trim(),
      urgency,
      deadline_at: date || null,
      address: address.trim(),
      phone: phone.trim(),
      budget_kopecks: budget,
      attachment_ids: files.map((f) => f.id),
      escrow_confirmed: agreeEscrow,
      terms_confirmed: agreeTerms,
    });
    setSubmitting(false);
    if (result.ok) {
      setCreatedDeal(result.deal);
    } else {
      setSubmitError(result.error.message);
      if (result.error.status === 401 && typeof window !== "undefined") {
        window.location.assign(
          `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
        );
      }
    }
  };

  // Keep TopNav happy when AuthProvider is loading on first paint
  void me;

  // ---------- breakdown ----------
  const baseKopecks = budget ?? 0;
  const feeKopecks = Math.round(baseKopecks * PLATFORM_FEE_PCT);
  const totalKopecks = baseKopecks + feeKopecks;

  const addFiles = (incoming: File[]) => {
    const uploaded: UploadedFile[] = incoming.map((f, i) => ({
      id: `f-${Date.now()}-${i}`,
      file: f,
      status: "ready",
      progress: 100,
    }));
    setFiles((prev) => [...prev, ...uploaded].slice(0, 5));
  };

  if (createdDeal) {
    return (
      <SubmittedScreen
        deal={createdDeal}
        provider={PROVIDER}
        onAgain={() => {
          setCreatedDeal(null);
          setScope("");
        }}
      />
    );
  }

  return (
    <>
      <TopNav notificationsUnread={3} messagesUnread={12} />

      <main className="mx-auto max-w-7xl px-4 md:px-6 pt-6 md:pt-8 pb-40 md:pb-32">
        <Breadcrumbs
          className="mb-6"
          items={[
            { label: "Послуги", href: "/feed" },
            { label: "Ремонт побутової техніки", href: "#" },
            { label: LISTING.title.slice(0, 40) + "…", href: "/listing" },
            { label: "Замовлення" },
          ]}
        />

        <EditorialPageHeader
          kicker="Створення угоди"
          title={
            <>
              Замовлення
              <br />
              <span className="text-ink-soft italic">через ескроу</span>
            </>
          }
          description="Кошти заморожуються на платформі. Виконавець отримує оплату лише після того, як ви підтвердите виконання роботи."
          sidecar={
            <ol className="grid grid-cols-3 gap-2 text-center">
              {[
                { n: "01", l: "Бриф", on: true },
                { n: "02", l: "Холд", on: true },
                { n: "03", l: "Угода", on: false },
              ].map((s) => (
                <li
                  key={s.n}
                  className={[
                    "rounded-[var(--radius-sm)] border px-3 py-3",
                    s.on
                      ? "border-ink bg-ink text-paper"
                      : "border-hairline bg-paper text-muted",
                  ].join(" ")}
                >
                  <div className="font-mono text-micro tracking-[0.22em]">
                    {s.n}
                  </div>
                  <div className="font-display text-body-lg leading-tight mt-1">
                    {s.l}
                  </div>
                </li>
              ))}
            </ol>
          }
        />

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-10 lg:gap-14">
          {/* ============ LEFT — form ============ */}
          <section className="min-w-0 space-y-10">
            {/* Provider context card */}
            <article className="border border-hairline rounded-[var(--radius-md)] bg-paper p-5 md:p-6">
              <div className="flex items-start gap-4">
                <div className="relative shrink-0">
                  <div
                    className="h-20 w-20 md:h-24 md:w-24 rounded-[var(--radius-sm)] bg-cover bg-center border border-hairline"
                    style={{ backgroundImage: `url(${LISTING.coverUrl})` }}
                    aria-hidden
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted mb-1">
                    Послуга №&nbsp;{LISTING.id}
                  </p>
                  <h2 className="font-display text-h3 text-ink leading-tight">
                    {LISTING.title}
                  </h2>
                  <p className="mt-1 text-caption text-muted truncate">
                    {LISTING.category}
                  </p>
                  <div className="mt-3 flex items-center gap-3">
                    <Avatar
                      src={PROVIDER.avatarUrl}
                      alt={PROVIDER.name}
                      size="sm"
                    />
                    <span className="font-display text-body-lg text-ink leading-none">
                      {PROVIDER.name}
                    </span>
                    <Badge tone="success" size="sm" shape="square">
                      <ShieldCheck size={10} className="mr-0.5" />
                      KYC
                    </Badge>
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-caption text-muted">
                    <RatingStars value={PROVIDER.rating} size="sm" />
                    <span className="font-mono tabular-nums text-ink-soft">
                      {PROVIDER.rating}
                    </span>
                    <span>· {PROVIDER.reviewsCount} відгуків</span>
                    <span className="hidden sm:inline">
                      · відп. за {PROVIDER.responseMin} хв
                    </span>
                  </div>
                </div>
              </div>
            </article>

            {/* Scope */}
            <SectionHeader n="01" title="Опишіть задачу" />
            <FormField
              label="Що потрібно зробити?"
              required
              helper="Бренд, модель, симптоми, бажаний час. Чим конкретніше — тим швидше відповідь."
              charCount={{ current: scope.length, max: SCOPE_MAX }}
            >
              <textarea
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                maxLength={SCOPE_MAX}
                rows={6}
                className="w-full rounded-[var(--radius-sm)] border border-hairline-strong bg-paper px-3 py-2.5 text-body text-ink placeholder:text-muted-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink resize-y"
                placeholder="Опишіть задачу детально"
              />
            </FormField>

            <FormField
              label="Файли (опціонально)"
              hint="фото поломки, скріни помилки — до 5 файлів, max 10 МБ"
            >
              <FileUploader
                accept="image/*,application/pdf"
                multiple
                maxFiles={5}
                maxSizeBytes={10 * 1024 * 1024}
                files={files}
                onFilesAdd={addFiles}
                onRemove={(id) =>
                  setFiles((prev) => prev.filter((f) => f.id !== id))
                }
              />
            </FormField>

            {/* When + where */}
            <SectionHeader n="02" title="Коли і де" />
            <div className="grid grid-cols-1 md:grid-cols-12 gap-x-8 gap-y-6">
              <div className="md:col-span-12">
                <FormField label="Коли потрібно" required>
                  <RadioCardGroup
                    value={urgency}
                    onChange={setUrgency}
                    columns={4}
                    options={URGENCY.map((u) => ({
                      id: u.id,
                      label: u.label,
                      hint: u.hint,
                      trailing: <></>,
                    }))}
                  />
                </FormField>
              </div>

              <div className="md:col-span-6">
                <FormField label="Бажана дата" optional>
                  <DateTimePicker
                    variant="datetime"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </FormField>
              </div>
              <div className="md:col-span-6">
                <FormField label="Телефон" required>
                  <Input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+380 ..."
                  />
                </FormField>
              </div>
              <div className="md:col-span-12">
                <FormField label="Адреса / район" required>
                  <Input
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Місто, вулиця, орієнтир"
                  />
                </FormField>
              </div>
            </div>

            {/* Budget */}
            <SectionHeader n="03" title="Бюджет" />
            <div className="grid grid-cols-1 md:grid-cols-12 gap-x-8 gap-y-6">
              <div className="md:col-span-7">
                <FormField
                  label="Скільки готові заплатити"
                  required
                  helper="Це сума, яка буде заморожена в ескроу."
                >
                  <MoneyInput
                    valueKopecks={budget}
                    onChangeKopecks={setBudget}
                    minKopecks={5000}
                    size="lg"
                  />
                </FormField>
                <div className="mt-3 flex flex-wrap gap-2">
                  {[50000, 80000, 120000, 200000].map((p) => (
                    <Tag
                      key={p}
                      variant="soft"
                      interactive
                      selected={budget === p}
                      onClick={() => setBudget(p)}
                    >
                      {(p / 100).toLocaleString("uk-UA")} ₴
                    </Tag>
                  ))}
                </div>
              </div>
              <aside className="md:col-span-5">
                <div className="border border-hairline rounded-[var(--radius-md)] bg-canvas p-4 h-full">
                  <p className="font-mono text-micro uppercase tracking-[0.18em] text-accent">
                    Орієнтовно для цієї послуги
                  </p>
                  <p className="mt-2 font-display text-h2 text-ink leading-none">
                    320–950 ₴
                  </p>
                  <p className="mt-2 text-caption text-muted leading-relaxed">
                    Базовий виклик 320 ₴. Підшипники / ТЕН / насос — додатково.
                    Точна ціна — після безкоштовної діагностики.
                  </p>
                </div>
              </aside>
            </div>

            {/* Terms */}
            <SectionHeader n="04" title="Підтвердження" />
            <div className="space-y-3">
              <TermCheckbox
                checked={agreeEscrow}
                onChange={setAgreeEscrow}
                title="Я працюю через ескроу"
                body="Кошти заморожуються в момент створення угоди. Виконавець отримує оплату лише після того, як я підтверджу виконання."
                icon={<Lock size={16} />}
                variant="selectable"
              />
              <TermCheckbox
                checked={agreeTerms}
                onChange={setAgreeTerms}
                title="Я погоджуюсь з умовами Robotun"
                body="Заборонено передавати контактні дані поза чатом до старту угоди. Спірні питання вирішуються через підтримку."
                icon={<ShieldCheck size={16} />}
                variant="selectable"
              />
            </div>

            {!valid && (
              <InlineAlert tone="warning" title="Ще трохи — і готово">
                <ul className="list-disc ml-4 space-y-0.5">
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </InlineAlert>
            )}

            {submitError && (
              <InlineAlert tone="danger" title="Не вдалось створити угоду">
                {submitError}
              </InlineAlert>
            )}
          </section>

          {/* ============ RIGHT — sticky receipt ============ */}
          <aside className="lg:sticky lg:top-24 self-start space-y-4">
            <div className="border border-hairline rounded-[var(--radius-md)] bg-paper shadow-[var(--shadow-sm)] overflow-hidden">
              <div className="p-5 md:p-6 border-b border-hairline">
                <p className="font-mono text-micro uppercase tracking-[0.22em] text-muted">
                  До холду
                </p>
                <div className="mt-1 flex items-baseline gap-1">
                  <MoneyDisplay
                    kopecks={totalKopecks}
                    emphasize
                    className="font-display text-h1 text-ink leading-none tracking-tight"
                  />
                  <span className="text-body text-muted ml-1">UAH</span>
                </div>
              </div>

              {/* breakdown */}
              <dl className="px-5 md:px-6 py-5 space-y-2 text-body">
                <div className="flex items-baseline justify-between">
                  <dt className="text-muted">Бюджет</dt>
                  <dd className="font-mono tabular-nums text-ink">
                    <MoneyDisplay kopecks={baseKopecks} />
                  </dd>
                </div>
                <div className="flex items-baseline justify-between">
                  <dt className="text-muted inline-flex items-center gap-1">
                    Сервісний збір
                    <Tooltip
                      content="5% покриває обробку платежу, KYC, гарантію ескроу"
                      side="top"
                    >
                      <span className="text-muted-soft cursor-help">[?]</span>
                    </Tooltip>
                  </dt>
                  <dd className="font-mono tabular-nums text-ink">
                    +<MoneyDisplay kopecks={feeKopecks} />
                  </dd>
                </div>
                <div className="border-t border-hairline pt-2 mt-2 flex items-baseline justify-between">
                  <dt className="font-display text-body-lg text-ink">
                    Загалом до холду
                  </dt>
                  <dd className="font-display text-body-lg text-ink font-mono tabular-nums">
                    <MoneyDisplay kopecks={totalKopecks} />
                  </dd>
                </div>
              </dl>

              {/* CTA */}
              <div className="p-5 md:p-6 border-t border-hairline">
                <Button
                  variant="accent"
                  size="lg"
                  className="w-full"
                  rightIcon={<ArrowRight size={16} />}
                  disabled={!valid}
                  onClick={() => setConfirmOpen(true)}
                >
                  Заморозити та надіслати
                </Button>
                <p className="mt-3 text-caption text-muted leading-relaxed text-center">
                  Кошти не списуються до підтвердження.
                  Виконавець бачить запит у себе.
                </p>
              </div>

              {/* trust */}
              <ul className="border-t border-hairline px-5 md:px-6 py-5 space-y-3">
                <Trust icon={<Lock size={14} />} title="Захищено ескроу" />
                <Trust
                  icon={<ShieldCheck size={14} />}
                  title="KYC-перевірений виконавець"
                />
                <Trust
                  icon={<Clock size={14} />}
                  title={`Відповідь у межах ${PROVIDER.responseMin} хв`}
                />
              </ul>
            </div>

            {/* tip */}
            <div className="border border-hairline rounded-[var(--radius-md)] bg-canvas p-4 flex gap-3">
              <Sparkles size={16} className="text-accent shrink-0 mt-0.5" />
              <p className="text-caption text-ink-soft leading-relaxed">
                Якщо діагностика покаже інший обсяг — ціну можна перепогодити
                в чаті до підтвердження угоди.
              </p>
            </div>
          </aside>
        </div>
      </main>

      {/* Mobile sticky CTA */}
      <div className="lg:hidden fixed bottom-14 left-0 right-0 z-40 border-t border-hairline bg-paper/95 backdrop-blur-md p-3 flex items-center gap-3">
        <div className="min-w-0">
          <p className="font-mono text-micro uppercase tracking-wider text-muted leading-none">
            до холду
          </p>
          <MoneyDisplay
            kopecks={totalKopecks}
            emphasize
            className="font-display text-h3 text-ink leading-none"
          />
        </div>
        <Button
          variant="accent"
          size="lg"
          className="flex-1"
          rightIcon={<ArrowRight size={16} />}
          disabled={!valid}
          onClick={() => setConfirmOpen(true)}
        >
          Заморозити
        </Button>
      </div>

      {/* Confirm modal */}
      <Modal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Підтвердження угоди"
        description="Перевірте умови — після цього кошти будуть заморожені."
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Назад
            </Button>
            <Button
              variant="accent"
              rightIcon={<CheckCircle2 size={16} />}
              onClick={() => {
                setConfirmOpen(false);
                void handleSubmit();
              }}
              loading={submitting}
            >
              Підтвердити та сплатити
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <ConfirmRow
            label="Виконавець"
            value={
              <span className="inline-flex items-center gap-2">
                <Avatar
                  src={PROVIDER.avatarUrl}
                  alt={PROVIDER.name}
                  size="xs"
                />
                {PROVIDER.name}
              </span>
            }
          />
          <ConfirmRow label="Послуга" value={LISTING.title} mono />
          <ConfirmRow
            label="Бюджет"
            value={<MoneyDisplay kopecks={baseKopecks} />}
          />
          <ConfirmRow
            label="Сервісний збір"
            value={
              <>
                +<MoneyDisplay kopecks={feeKopecks} />
              </>
            }
          />
          <ConfirmRow
            label="До холду"
            value={
              <span className="font-display text-h3 text-ink">
                <MoneyDisplay kopecks={totalKopecks} />
              </span>
            }
            emphasized
          />

          <div className="border border-warning rounded-[var(--radius-sm)] bg-warning-soft text-ink-soft p-4 flex gap-3">
            <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
            <div className="text-caption leading-relaxed">
              Не передавайте контактні дані виконавцю до підтвердження угоди.
              Усе спілкування — у чаті, інакше захист ескроу не діє.
            </div>
          </div>
        </div>
      </Modal>

      <Footer />
      <MobileTabBar messagesUnread={12} />
    </>
  );
}

/* ===========================================================
   Local helpers
   =========================================================== */

function SectionHeader({ n, title }: { n: string; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="font-mono text-micro uppercase tracking-[0.22em] text-accent">
        {n}
      </span>
      <h2 className="font-display text-h2 text-ink tracking-tight leading-none">
        {title}
      </h2>
      <span
        className="hidden md:block flex-1 h-px bg-hairline"
        aria-hidden
      />
    </div>
  );
}

function Trust({
  icon,
  title,
}: {
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <li className="flex items-center gap-3 text-body text-ink-soft">
      <span className="h-7 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)] bg-accent-soft text-accent shrink-0">
        {icon}
      </span>
      {title}
    </li>
  );
}

function ConfirmRow({
  label,
  value,
  mono,
  emphasized,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  emphasized?: boolean;
}) {
  return (
    <div
      className={[
        "grid grid-cols-[120px_1fr] gap-4 items-baseline",
        emphasized
          ? "pt-3 border-t border-hairline"
          : "",
      ].join(" ")}
    >
      <dt className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
        {label}
      </dt>
      <dd
        className={[
          "text-body text-ink",
          mono ? "font-mono text-caption text-ink-soft" : "",
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}

function SubmittedScreen({
  deal,
  provider,
  onAgain,
}: {
  deal: Deal;
  provider: { name: string; responseMin: number };
  onAgain: () => void;
}) {
  return (
    <>
      <TopNav notificationsUnread={3} messagesUnread={12} />
      <SuccessScreen
        icon={<CheckCircle2 size={32} />}
        iconTone="success"
        kicker={`Угода створена · ${deal.id.slice(0, 8)}`}
        title={
          <>
            Кошти заморожено
            <br />
            <span className="text-ink-soft italic">очікуємо виконавця</span>
          </>
        }
        description={
          <>
            {provider.name} отримав запит на{" "}
            <MoneyDisplay kopecks={deal.total_held_kopecks} /> (з них{" "}
            <MoneyDisplay kopecks={deal.fee_kopecks} /> — сервісний збір).
            Зазвичай відповідає протягом {provider.responseMin} хвилин. Ми
            сповістимо вас у чаті та поштою.
          </>
        }
        actions={
          <>
            <a href={`/deals/${deal.id}`}>
              <Button
                variant="accent"
                size="lg"
                rightIcon={<ChevronRight size={16} />}
              >
                Перейти до угоди
              </Button>
            </a>
            <Button variant="secondary" size="lg" onClick={onAgain}>
              Ще одне замовлення
            </Button>
          </>
        }
        steps={[
          { n: "01", label: "Чекаємо підтвердження виконавцем", active: true },
          { n: "02", label: "Виконання робіт у погоджений термін" },
          { n: "03", label: "Підтвердження + переказ коштів" },
        ]}
      />
      <Footer />
      <MobileTabBar messagesUnread={12} />
    </>
  );
}
