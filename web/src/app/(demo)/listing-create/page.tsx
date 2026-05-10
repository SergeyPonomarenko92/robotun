"use client";
import * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ImagePlus,
  Sparkles,
  ShieldCheck,
  Eye,
  Save,
} from "lucide-react";

import { TopNav } from "@/components/organisms/TopNav";
import { MobileTabBar } from "@/components/organisms/MobileTabBar";
import { Footer } from "@/components/organisms/Footer";
import {
  ListingCard,
  type ListingCardData,
} from "@/components/organisms/ListingCard";

import { Stepper, type Step } from "@/components/ui/Stepper";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import {
  CategoryPicker,
  type Category,
  type CategoryPath,
} from "@/components/ui/CategoryPicker";
import { MoneyInput, MoneyDisplay } from "@/components/ui/MoneyInput";
import {
  FileUploader,
  type UploadedFile,
} from "@/components/ui/FileUploader";
import {
  AttachmentGallery,
  type GalleryItem,
} from "@/components/ui/AttachmentGallery";
import { Tag } from "@/components/ui/Tag";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import { Tooltip } from "@/components/ui/Tooltip";

const USER = {
  id: "u1",
  displayName: "Сергій П.",
  email: "aks74ym@gmail.com",
  kycVerified: true,
  hasProviderRole: true,
};

const CATEGORIES: Category[] = [
  {
    id: "el",
    name: "Електрика",
    children: [
      {
        id: "el-house",
        name: "Домашня електрика",
        children: [
          { id: "el-wiring", name: "Заміна проводки" },
          { id: "el-socket", name: "Заміна розеток" },
          { id: "el-light", name: "Встановлення світильників" },
        ],
      },
    ],
  },
  {
    id: "rep",
    name: "Ремонт побутової техніки",
    children: [
      {
        id: "rep-wash",
        name: "Пральні машини",
        children: [
          { id: "rep-wash-bosch", name: "Bosch / Siemens" },
          { id: "rep-wash-lg", name: "LG / Samsung" },
          { id: "rep-wash-other", name: "Інші бренди" },
        ],
      },
      {
        id: "rep-fridge",
        name: "Холодильники",
        children: [{ id: "rep-fridge-all", name: "Всі бренди" }],
      },
    ],
  },
  {
    id: "clean",
    name: "Прибирання",
    children: [
      {
        id: "clean-flat",
        name: "Квартири",
        children: [
          { id: "clean-flat-reg", name: "Регулярне" },
          { id: "clean-flat-deep", name: "Генеральне" },
        ],
      },
    ],
  },
];

const PRESET_TAGS = [
  "виїзд",
  "гарантія",
  "оригінальні зч.",
  "експрес",
  "вечір/вихідні",
  "чек / ФОП",
];

type PriceModel = "visit" | "hour" | "project" | "from";
const PRICE_MODELS: { id: PriceModel; label: string; hint: string }[] = [
  { id: "visit", label: "за виклик", hint: "одноразова сума за виїзд" },
  { id: "hour", label: "за годину", hint: "погодинно, мін. 1 година" },
  { id: "project", label: "за проєкт", hint: "фіксована сума за обʼєкт" },
  { id: "from", label: "від (договірна)", hint: "стартова, фінал — після огляду" },
];

const STEPS_DATA: { id: WizardStepId; label: string; hint: string }[] = [
  { id: "basics", label: "Основа", hint: "Назва, категорія, опис" },
  { id: "media", label: "Фото", hint: "Обкладинка та галерея" },
  { id: "pricing", label: "Ціна", hint: "Модель та ставка" },
  { id: "review", label: "Перевірка", hint: "Передперегляд" },
];

type WizardStepId = "basics" | "media" | "pricing" | "review";

const TITLE_MAX = 90;
const DESC_MAX = 2000;
const DESC_MIN = 80;

export default function ListingCreateWizard() {
  const [activeId, setActiveId] = React.useState<WizardStepId>("basics");
  const [visited, setVisited] = React.useState<Set<WizardStepId>>(
    new Set(["basics"])
  );

  // ---------- form state ----------
  const [title, setTitle] = React.useState(
    "Ремонт пральних машин Bosch / Siemens — виїзд по Києву"
  );
  const [category, setCategory] = React.useState<CategoryPath | null>({
    l1: { id: "rep", name: "Ремонт побутової техніки" },
    l2: { id: "rep-wash", name: "Пральні машини" },
    l3: { id: "rep-wash-bosch", name: "Bosch / Siemens" },
  } as CategoryPath);
  const [description, setDescription] = React.useState(
    "Сервісний центр з 2014 року. Діагностика безкоштовна, оригінальні запчастини, гарантія на роботу 12 місяців. Працюємо з фізичними та юридичними особами через ескроу."
  );
  const [city, setCity] = React.useState("Київ");
  const [tags, setTags] = React.useState<string[]>(["виїзд", "гарантія"]);
  const [tagDraft, setTagDraft] = React.useState("");

  const [files, setFiles] = React.useState<UploadedFile[]>([]);
  const [gallery, setGallery] = React.useState<GalleryItem[]>([
    {
      id: "g1",
      src: "https://images.unsplash.com/photo-1581092335397-9583eb92d232?w=800&q=70",
      alt: "Майстер з пральною машиною",
      isCover: true,
    },
    {
      id: "g2",
      src: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&q=70",
      alt: "Сервіс",
    },
    {
      id: "g3",
      src: "https://images.unsplash.com/photo-1581092580497-e0d23cbdf1dc?w=800&q=70",
      alt: "Інструмент",
    },
  ]);

  const [priceModel, setPriceModel] = React.useState<PriceModel>("visit");
  const [priceKopecks, setPriceKopecks] = React.useState<number | null>(32000);
  const [escrowDeposit, setEscrowDeposit] = React.useState(true);
  const [responseSlaMin, setResponseSlaMin] = React.useState<number>(15);

  const [previewOpen, setPreviewOpen] = React.useState(false);

  // ---------- validation ----------
  const errors: Partial<Record<WizardStepId, string[]>> = {};
  {
    const e: string[] = [];
    if (title.trim().length < 12) e.push("Назва мінімум 12 символів");
    if (title.length > TITLE_MAX) e.push(`Не більше ${TITLE_MAX} символів`);
    if (!category?.l3) e.push("Оберіть категорію 3-го рівня");
    if (description.length < DESC_MIN)
      e.push(`Опис мінімум ${DESC_MIN} символів`);
    if (!city.trim()) e.push("Вкажіть місто");
    if (e.length) errors.basics = e;
  }
  {
    const e: string[] = [];
    if (gallery.length < 1) e.push("Потрібна щонайменше 1 фотографія");
    if (!gallery.some((g) => g.isCover)) e.push("Позначте обкладинку");
    if (e.length) errors.media = e;
  }
  {
    const e: string[] = [];
    if (!priceKopecks || priceKopecks < 5000)
      e.push("Мінімальна ціна — 50 ₴");
    if (e.length) errors.pricing = e;
  }

  const stepValid = (id: WizardStepId) => !errors[id];
  const allValid = (["basics", "media", "pricing"] as WizardStepId[]).every(
    stepValid
  );

  const stepStatus = (id: WizardStepId): NonNullable<Step["status"]> => {
    if (id === activeId) return "current";
    if (visited.has(id) && !stepValid(id)) return "error";
    if (visited.has(id) && stepValid(id)) return "completed";
    return "upcoming";
  };

  const stepperSteps: Step[] = STEPS_DATA.map((s) => ({
    id: s.id,
    label: s.label,
    hint: s.hint,
    status: stepStatus(s.id),
  }));

  // ---------- nav ----------
  const idx = STEPS_DATA.findIndex((s) => s.id === activeId);
  const goto = (id: WizardStepId) => {
    setVisited((v) => new Set(v).add(id));
    setActiveId(id);
    if (typeof window !== "undefined")
      window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const next = () => {
    setVisited((v) => new Set(v).add(activeId));
    if (idx < STEPS_DATA.length - 1) goto(STEPS_DATA[idx + 1].id);
  };
  const back = () => idx > 0 && goto(STEPS_DATA[idx - 1].id);

  // ---------- file mock ----------
  const addFiles = (incoming: File[]) => {
    const uploaded: UploadedFile[] = incoming.map((f, i) => ({
      id: `f-${Date.now()}-${i}`,
      file: f,
      status: "ready",
      progress: 100,
    }));
    setFiles((prev) => [...prev, ...uploaded].slice(0, 10));
    const galleryNext: GalleryItem[] = incoming.map((f, i) => ({
      id: `g-${Date.now()}-${i}`,
      src: URL.createObjectURL(f),
      alt: f.name,
    }));
    setGallery((prev) => [...prev, ...galleryNext].slice(0, 10));
  };

  // ---------- preview data ----------
  const previewData: ListingCardData = {
    id: "preview",
    href: "#",
    title: title || "Без назви",
    coverUrl:
      gallery.find((g) => g.isCover)?.src ||
      gallery[0]?.src ||
      "https://picsum.photos/seed/preview/640/480",
    priceFromKopecks: priceKopecks ?? 0,
    priceUnit:
      priceModel === "visit"
        ? "/виклик"
        : priceModel === "hour"
          ? "/год"
          : priceModel === "project"
            ? "/проект"
            : "",
    city: city || "—",
    category: category?.l2?.name,
    flags: tags.length ? tags.slice(0, 2) : undefined,
    provider: {
      name: USER.displayName,
      kycVerified: true,
      avgRating: 4.9,
      reviewsCount: 0,
      completedDealsCount: 0,
    },
  };

  return (
    <>
      <TopNav user={USER} notificationsUnread={3} messagesUnread={12} />

      <main className="mx-auto max-w-7xl px-4 md:px-6 pt-6 md:pt-10 pb-40 md:pb-32">
        {/* Editorial header */}
        <header className="grid grid-cols-12 gap-x-6 gap-y-4 mb-10 md:mb-14 items-end">
          <div className="col-span-12 lg:col-span-8">
            <p className="font-mono text-micro uppercase tracking-[0.22em] text-accent mb-3">
              Створення послуги
            </p>
            <h1 className="font-display text-h1 md:text-display text-ink leading-[0.98] tracking-tight">
              Нова послуга
              <br />
              <span className="text-ink-soft italic">за чотири кроки</span>
            </h1>
          </div>
          <aside className="col-span-12 lg:col-span-4">
            <div className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
              Чернетка
            </div>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="font-display text-h2 text-ink leading-none tabular-nums">
                {String(idx + 1).padStart(2, "0")}
                <span className="text-muted-soft">
                  /{String(STEPS_DATA.length).padStart(2, "0")}
                </span>
              </span>
              <Badge tone="warning" size="sm" shape="square">
                Не опубліковано
              </Badge>
            </div>
            <p className="mt-3 text-caption text-muted leading-relaxed">
              Чернетка зберігається автоматично. Опублікуємо лише після
              перевірки модерацією.
            </p>
          </aside>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-10 lg:gap-14">
          {/* ============ Stepper rail ============ */}
          <aside className="lg:sticky lg:top-24 self-start">
            {/* mobile horizontal */}
            <div className="lg:hidden">
              <Stepper
                steps={stepperSteps}
                activeId={activeId}
                orientation="horizontal"
              />
            </div>
            {/* desktop vertical */}
            <div className="hidden lg:block">
              <Stepper
                steps={stepperSteps}
                activeId={activeId}
                orientation="vertical"
              />
              <div className="mt-8 border-t border-hairline pt-5">
                <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted mb-2">
                  Підказка
                </p>
                <p className="text-caption text-ink-soft leading-relaxed">
                  Ціни вказуйте чесно — клієнт побачить підсумок до підтвердження
                  ескроу. Назву краще робити конкретною: «Ремонт пральних машин
                  Bosch» працює краще, ніж «Послуги ремонту».
                </p>
              </div>
            </div>
          </aside>

          {/* ============ Step content ============ */}
          <section className="min-w-0">
            <article className="border border-hairline rounded-[var(--radius-md)] bg-paper">
              {/* sheet header */}
              <header className="flex items-center justify-between gap-3 px-6 md:px-8 py-5 border-b border-hairline">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-micro uppercase tracking-[0.22em] text-accent shrink-0">
                    {String(idx + 1).padStart(2, "0")}
                  </span>
                  <h2 className="font-display text-h2 text-ink tracking-tight leading-tight truncate">
                    {STEPS_DATA[idx].label}
                  </h2>
                </div>
                {stepValid(activeId) ? (
                  <span className="hidden md:inline-flex items-center gap-1 text-caption text-success">
                    <Check size={14} />
                    готово
                  </span>
                ) : (
                  <span className="hidden md:inline-flex items-center gap-1 text-caption text-warning">
                    у роботі
                  </span>
                )}
              </header>

              <div className="p-6 md:p-8">
                {activeId === "basics" && (
                  <BasicsStep
                    title={title}
                    setTitle={setTitle}
                    category={category}
                    setCategory={setCategory}
                    description={description}
                    setDescription={setDescription}
                    city={city}
                    setCity={setCity}
                    tags={tags}
                    setTags={setTags}
                    tagDraft={tagDraft}
                    setTagDraft={setTagDraft}
                  />
                )}

                {activeId === "media" && (
                  <MediaStep
                    files={files}
                    setFiles={setFiles}
                    addFiles={addFiles}
                    gallery={gallery}
                    setGallery={setGallery}
                  />
                )}

                {activeId === "pricing" && (
                  <PricingStep
                    priceModel={priceModel}
                    setPriceModel={setPriceModel}
                    priceKopecks={priceKopecks}
                    setPriceKopecks={setPriceKopecks}
                    escrowDeposit={escrowDeposit}
                    setEscrowDeposit={setEscrowDeposit}
                    responseSlaMin={responseSlaMin}
                    setResponseSlaMin={setResponseSlaMin}
                  />
                )}

                {activeId === "review" && (
                  <ReviewStep
                    previewData={previewData}
                    title={title}
                    description={description}
                    category={category}
                    city={city}
                    tags={tags}
                    priceModel={priceModel}
                    priceKopecks={priceKopecks}
                    escrowDeposit={escrowDeposit}
                    responseSlaMin={responseSlaMin}
                    galleryCount={gallery.length}
                    onPreview={() => setPreviewOpen(true)}
                    onJump={goto}
                    allValid={allValid}
                    errors={errors}
                  />
                )}
              </div>

              {/* errors footer */}
              {errors[activeId]?.length ? (
                <div className="px-6 md:px-8 pb-6">
                  <InlineAlert tone="warning" title="Перевірте поля кроку">
                    <ul className="list-disc ml-4 space-y-0.5">
                      {errors[activeId]!.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  </InlineAlert>
                </div>
              ) : null}
            </article>

            {/* Encouragement strip — editorial flair */}
            <div className="mt-6 hidden md:flex items-center gap-3 text-caption text-muted">
              <Sparkles size={14} className="text-accent" />
              <span>
                Гарна назва і три фото &mdash; найбільший приріст кліків. Решту
                клієнт проясне в чаті.
              </span>
            </div>
          </section>
        </div>
      </main>

      {/* ============ Sticky action bar ============ */}
      <div className="fixed bottom-14 md:bottom-0 left-0 right-0 z-40 border-t border-hairline bg-paper/95 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-3 flex items-center gap-3">
          <Button
            variant="ghost"
            leftIcon={<ArrowLeft size={14} />}
            onClick={back}
            disabled={idx === 0}
          >
            <span className="hidden sm:inline">Назад</span>
          </Button>

          <div className="hidden md:flex items-center gap-2 font-mono text-micro uppercase tracking-[0.18em] text-muted">
            <span>Крок {idx + 1}</span>
            <span className="h-1 w-1 rounded-full bg-hairline-strong" aria-hidden />
            <span className="text-ink-soft">{STEPS_DATA[idx].label}</span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Tooltip content="Зберегти чернетку" side="top">
              <Button variant="secondary" leftIcon={<Save size={14} />}>
                <span className="hidden sm:inline">Чернетка</span>
              </Button>
            </Tooltip>
            <Button
              variant="ghost"
              leftIcon={<Eye size={14} />}
              onClick={() => setPreviewOpen(true)}
            >
              <span className="hidden md:inline">Передперегляд</span>
            </Button>
            {idx < STEPS_DATA.length - 1 ? (
              <Button
                variant="accent"
                rightIcon={<ArrowRight size={14} />}
                onClick={next}
                disabled={!stepValid(activeId)}
              >
                Далі
              </Button>
            ) : (
              <Button
                variant="accent"
                rightIcon={<Check size={14} />}
                disabled={!allValid}
              >
                Опублікувати
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ============ Preview Modal ============ */}
      <Modal
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        title="Передперегляд картки"
        description="Так клієнти побачать вашу послугу у стрічці пошуку."
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPreviewOpen(false)}>
              Закрити
            </Button>
            <Button variant="accent" onClick={() => setPreviewOpen(false)}>
              Назад до редагування
            </Button>
          </>
        }
      >
        <div className="max-w-md mx-auto">
          <ListingCard data={previewData} />
        </div>
      </Modal>

      <Footer />
      <MobileTabBar messagesUnread={12} />
    </>
  );
}

/* ===========================================================
   Step components
   =========================================================== */

function BasicsStep({
  title,
  setTitle,
  category,
  setCategory,
  description,
  setDescription,
  city,
  setCity,
  tags,
  setTags,
  tagDraft,
  setTagDraft,
}: {
  title: string;
  setTitle: (v: string) => void;
  category: CategoryPath | null;
  setCategory: (c: CategoryPath | null) => void;
  description: string;
  setDescription: (v: string) => void;
  city: string;
  setCity: (v: string) => void;
  tags: string[];
  setTags: (v: string[]) => void;
  tagDraft: string;
  setTagDraft: (v: string) => void;
}) {
  const toggleTag = (t: string) =>
    setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]);
  const addCustom = () => {
    const t = tagDraft.trim();
    if (!t || tags.includes(t)) return;
    setTags([...tags, t]);
    setTagDraft("");
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-x-8 gap-y-6">
      {/* title */}
      <div className="md:col-span-12">
        <FormField
          label="Назва послуги"
          required
          helper="Конкретно — бренд, регіон, головна вигода. Без CAPS."
          charCount={{ current: title.length, max: TITLE_MAX }}
        >
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={TITLE_MAX}
            placeholder="Ремонт пральних машин Bosch — виїзд по Києву"
          />
        </FormField>
      </div>

      {/* category */}
      <div className="md:col-span-12">
        <FormField
          label="Категорія"
          required
          helper="3 рівні. Кінцева категорія допомагає клієнту знайти вас."
        >
          <CategoryPicker
            categories={CATEGORIES}
            value={category}
            onChange={setCategory}
          />
        </FormField>
      </div>

      {/* description */}
      <div className="md:col-span-8">
        <FormField
          label="Опис"
          required
          helper="Що ви робите, які бренди / зони / гарантії, чого НЕ робите."
          charCount={{ current: description.length, max: DESC_MAX }}
        >
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={DESC_MAX}
            rows={8}
            className="w-full rounded-[var(--radius-sm)] border border-hairline-strong bg-paper px-3 py-2.5 text-body text-ink placeholder:text-muted-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink resize-y"
            placeholder="Розкажіть, як ви працюєте та що отримає клієнт."
          />
        </FormField>
      </div>

      {/* city + tags column */}
      <div className="md:col-span-4 space-y-6">
        <FormField label="Місто" required hint="ваш базовий регіон роботи">
          <Input
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="Київ"
          />
        </FormField>

        <div>
          <FormField
            label="Теги"
            optional
            helper="Виберіть готові або додайте свої."
          >
            <div className="flex flex-wrap gap-2">
              {PRESET_TAGS.map((t) => (
                <Tag
                  key={t}
                  variant="soft"
                  selected={tags.includes(t)}
                  interactive
                  onClick={() => toggleTag(t)}
                >
                  {t}
                </Tag>
              ))}
            </div>
          </FormField>

          <div className="mt-3 flex gap-2">
            <Input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              placeholder="свій тег"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustom();
                }
              }}
            />
            <Button variant="secondary" onClick={addCustom}>
              Додати
            </Button>
          </div>
          {tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <Tag
                  key={t}
                  variant="accent"
                  size="sm"
                  onRemove={() => toggleTag(t)}
                >
                  {t}
                </Tag>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MediaStep({
  files,
  setFiles,
  addFiles,
  gallery,
  setGallery,
}: {
  files: UploadedFile[];
  setFiles: React.Dispatch<React.SetStateAction<UploadedFile[]>>;
  addFiles: (f: File[]) => void;
  gallery: GalleryItem[];
  setGallery: React.Dispatch<React.SetStateAction<GalleryItem[]>>;
}) {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
        <div className="md:col-span-7">
          <FormField
            label="Завантажте фото"
            required
            helper="JPG / PNG / WebP, до 10 файлів. Перше — обкладинка."
          >
            <FileUploader
              accept="image/*"
              multiple
              maxFiles={10}
              maxSizeBytes={10 * 1024 * 1024}
              files={files}
              onFilesAdd={addFiles}
              onRemove={(id) =>
                setFiles((prev) => prev.filter((f) => f.id !== id))
              }
            />
          </FormField>
        </div>

        <aside className="md:col-span-5">
          <div className="border border-hairline rounded-[var(--radius-md)] bg-canvas p-5 h-full">
            <p className="font-mono text-micro uppercase tracking-[0.18em] text-accent mb-2">
              Як знімати
            </p>
            <ul className="text-caption text-ink-soft space-y-2 leading-relaxed">
              <li className="flex gap-2">
                <span className="font-mono text-muted">01</span>
                Природне світло, без спалаху.
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-muted">02</span>
                Робочий процес або результат — не лого.
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-muted">03</span>
                Без водяних знаків і нагромадження тексту.
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-muted">04</span>
                Перетягніть, щоб змінити порядок. Зірка &mdash; обкладинка.
              </li>
            </ul>
            <div className="mt-4 pt-4 border-t border-hairline-strong flex items-center gap-2 text-caption text-muted">
              <ImagePlus size={14} className="text-accent" />
              {gallery.length}/10 фото
            </div>
          </div>
        </aside>
      </div>

      <div>
        <p className="font-mono text-micro uppercase tracking-[0.22em] text-muted mb-3">
          Галерея
        </p>
        <AttachmentGallery
          items={gallery}
          maxItems={10}
          onRemove={(id) => setGallery((g) => g.filter((x) => x.id !== id))}
          onSetCover={(id) =>
            setGallery((g) => g.map((x) => ({ ...x, isCover: x.id === id })))
          }
          onReorder={setGallery}
          emptyHint="Завантажте фото вище — вони з'являться тут."
        />
      </div>
    </div>
  );
}

function PricingStep({
  priceModel,
  setPriceModel,
  priceKopecks,
  setPriceKopecks,
  escrowDeposit,
  setEscrowDeposit,
  responseSlaMin,
  setResponseSlaMin,
}: {
  priceModel: PriceModel;
  setPriceModel: (m: PriceModel) => void;
  priceKopecks: number | null;
  setPriceKopecks: (v: number | null) => void;
  escrowDeposit: boolean;
  setEscrowDeposit: (v: boolean) => void;
  responseSlaMin: number;
  setResponseSlaMin: (v: number) => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-x-8 gap-y-8">
      {/* model */}
      <div className="md:col-span-12">
        <FormField label="Модель ціноутворення" required>
          <div
            role="radiogroup"
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3"
          >
            {PRICE_MODELS.map((m) => {
              const active = priceModel === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setPriceModel(m.id)}
                  className={[
                    "text-left rounded-[var(--radius-md)] border px-4 py-4 transition-all duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
                    active
                      ? "border-ink bg-ink text-paper"
                      : "border-hairline bg-paper text-ink hover:border-ink",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-display text-h3 leading-none">
                      {m.label}
                    </span>
                    <span
                      className={[
                        "h-4 w-4 rounded-full border-2 flex items-center justify-center",
                        active
                          ? "border-paper bg-paper"
                          : "border-hairline-strong",
                      ].join(" ")}
                      aria-hidden
                    >
                      {active && (
                        <span className="h-1.5 w-1.5 rounded-full bg-ink" />
                      )}
                    </span>
                  </div>
                  <p
                    className={[
                      "mt-2 text-caption leading-snug",
                      active ? "text-paper/75" : "text-muted",
                    ].join(" ")}
                  >
                    {m.hint}
                  </p>
                </button>
              );
            })}
          </div>
        </FormField>
      </div>

      {/* price + sla */}
      <div className="md:col-span-7">
        <FormField
          label="Ставка"
          required
          helper={
            priceModel === "from"
              ? "Стартова сума, від якої ви рахуєте обсяг."
              : "Підсумкова сума за обрану одиницю."
          }
        >
          <MoneyInput
            valueKopecks={priceKopecks}
            onChangeKopecks={setPriceKopecks}
            minKopecks={5000}
            size="lg"
          />
        </FormField>
      </div>

      <div className="md:col-span-5">
        <FormField
          label="Час відповіді (хв)"
          optional
          helper="Скільки в середньому йде до першої відповіді у чаті."
        >
          <Input
            type="number"
            min={5}
            max={240}
            value={responseSlaMin}
            onChange={(e) => setResponseSlaMin(Number(e.target.value))}
          />
        </FormField>
      </div>

      {/* escrow toggle */}
      <div className="md:col-span-12">
        <label className="flex items-start gap-4 border border-hairline rounded-[var(--radius-md)] bg-canvas p-5 cursor-pointer">
          <input
            type="checkbox"
            checked={escrowDeposit}
            onChange={(e) => setEscrowDeposit(e.target.checked)}
            className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-2 font-display text-h3 text-ink leading-tight">
              <ShieldCheck size={18} className="text-success" />
              Захист ескроу
            </span>
            <span className="block text-caption text-ink-soft mt-1 leading-relaxed">
              Кошти заморожуються на платформі і переходять виконавцю лише після
              підтвердження роботи. Рекомендовано для всіх послуг від 500 ₴.
            </span>
          </span>
        </label>
      </div>

      {/* live summary */}
      <div className="md:col-span-12">
        <div className="border border-hairline rounded-[var(--radius-md)] bg-paper p-5 flex flex-wrap items-baseline gap-3">
          <span className="font-mono text-micro uppercase tracking-[0.22em] text-muted">
            Так побачить клієнт
          </span>
          <span className="font-mono text-micro text-muted">від</span>
          <MoneyDisplay
            kopecks={priceKopecks ?? 0}
            emphasize
            className="font-display text-h2 text-ink leading-none tracking-tight"
          />
          <span className="text-body text-muted">
            {PRICE_MODELS.find((m) => m.id === priceModel)?.label
              ? `${
                  priceModel === "visit"
                    ? "/виклик"
                    : priceModel === "hour"
                      ? "/год"
                      : priceModel === "project"
                        ? "/проект"
                        : "(договірна)"
                }`
              : ""}
          </span>
          {escrowDeposit && (
            <Badge tone="success" shape="square" size="sm" className="ml-auto">
              <ShieldCheck size={10} className="mr-0.5" />
              Ескроу
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewStep({
  previewData,
  title,
  description,
  category,
  city,
  tags,
  priceModel,
  priceKopecks,
  escrowDeposit,
  responseSlaMin,
  galleryCount,
  onPreview,
  onJump,
  allValid,
  errors,
}: {
  previewData: ListingCardData;
  title: string;
  description: string;
  category: CategoryPath | null;
  city: string;
  tags: string[];
  priceModel: PriceModel;
  priceKopecks: number | null;
  escrowDeposit: boolean;
  responseSlaMin: number;
  galleryCount: number;
  onPreview: () => void;
  onJump: (id: WizardStepId) => void;
  allValid: boolean;
  errors: Partial<Record<WizardStepId, string[]>>;
}) {
  const summary: { step: WizardStepId; label: string; rows: [string, string][] }[] = [
    {
      step: "basics",
      label: "Основа",
      rows: [
        ["Назва", title || "—"],
        [
          "Категорія",
          category?.l3
            ? `${category.l1?.name} / ${category.l2?.name} / ${category.l3.name}`
            : "—",
        ],
        ["Опис", `${description.length} символів`],
        ["Місто", city || "—"],
        ["Теги", tags.length ? tags.join(", ") : "—"],
      ],
    },
    {
      step: "media",
      label: "Фото",
      rows: [
        ["Кількість", `${galleryCount} / 10`],
        ["Обкладинка", galleryCount > 0 ? "обрано" : "—"],
      ],
    },
    {
      step: "pricing",
      label: "Ціна",
      rows: [
        [
          "Модель",
          PRICE_MODELS.find((m) => m.id === priceModel)?.label || "—",
        ],
        [
          "Ставка",
          priceKopecks ? `${(priceKopecks / 100).toFixed(2)} ₴` : "—",
        ],
        ["Ескроу", escrowDeposit ? "увімкнено" : "вимкнено"],
        ["Відповідь", `${responseSlaMin} хв`],
      ],
    },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
      <div className="lg:col-span-7 space-y-6">
        {summary.map((s) => {
          const e = errors[s.step];
          return (
            <section
              key={s.step}
              className={[
                "rounded-[var(--radius-md)] border bg-paper",
                e ? "border-warning" : "border-hairline",
              ].join(" ")}
            >
              <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-hairline">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-micro uppercase tracking-[0.22em] text-muted">
                    {s.step === "basics"
                      ? "01"
                      : s.step === "media"
                        ? "02"
                        : "03"}
                  </span>
                  <h3 className="font-display text-h3 text-ink leading-none">
                    {s.label}
                  </h3>
                  {e ? (
                    <Badge tone="warning" size="sm" shape="square">
                      потребує уваги
                    </Badge>
                  ) : (
                    <Badge tone="success" size="sm" shape="square">
                      <Check size={10} className="mr-0.5" />
                      готово
                    </Badge>
                  )}
                </div>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => onJump(s.step)}
                >
                  Редагувати
                </Button>
              </header>
              <dl className="px-5 py-4 grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-x-5 gap-y-2">
                {s.rows.map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt className="font-mono text-micro uppercase tracking-[0.16em] text-muted">
                      {k}
                    </dt>
                    <dd className="text-body text-ink-soft break-words">
                      {v}
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>
          );
        })}

        {!allValid && (
          <InlineAlert tone="warning" title="Деякі кроки потребують уваги">
            Виправте помилки в позначених секціях, щоб опублікувати послугу.
          </InlineAlert>
        )}
      </div>

      <aside className="lg:col-span-5">
        <div className="lg:sticky lg:top-24">
          <p className="font-mono text-micro uppercase tracking-[0.22em] text-accent mb-2">
            04 — Передперегляд
          </p>
          <h3 className="font-display text-h2 text-ink tracking-tight leading-tight mb-5">
            Як побачить клієнт
          </h3>
          <ListingCard data={previewData} />
          <Button
            variant="secondary"
            size="sm"
            className="mt-4 w-full"
            leftIcon={<Eye size={14} />}
            onClick={onPreview}
          >
            Відкрити в модалці
          </Button>
          <p className="mt-4 font-mono text-micro uppercase tracking-[0.18em] text-muted-soft text-center">
            Після публікації — модерація до 24 годин
          </p>
        </div>
      </aside>
    </div>
  );
}
