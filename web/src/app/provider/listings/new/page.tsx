"use client";
import * as React from "react";
import { Suspense } from "react";
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
  type CategoryPath,
} from "@/components/ui/CategoryPicker";
import { useCategories } from "@/lib/categories";
import { MoneyInput, MoneyDisplay } from "@/components/ui/MoneyInput";
import { FileUploader } from "@/components/ui/FileUploader";
import { useUploader, getMediaStreamUrl } from "@/lib/media";
import {
  AttachmentGallery,
  type GalleryItem,
} from "@/components/ui/AttachmentGallery";
import { Tag } from "@/components/ui/Tag";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import { RadioCardGroup } from "@/components/ui/RadioCardGroup";
import { TermCheckbox } from "@/components/ui/TermCheckbox";
import { EditorialPageHeader } from "@/components/organisms/EditorialPageHeader";
import { WizardSheet } from "@/components/organisms/WizardSheet";
import { WizardActionBar } from "@/components/organisms/WizardActionBar";
import { SuccessScreen } from "@/components/organisms/SuccessScreen";
import { Tooltip } from "@/components/ui/Tooltip";
import { useRequireAuth } from "@/lib/auth";
import {
  createListing,
  createDraft,
  getDraft,
  useDraftAutosave,
  type CreateListingError,
  type DraftPayload,
  type ListingDetail,
  type SaveStatus,
} from "@/lib/listings";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, AlertTriangle } from "lucide-react";

const USER_FALLBACK = {
  id: "u1",
  displayName: "Сергій П.",
  email: "aks74ym@gmail.com",
  kycVerified: true,
  hasProviderRole: true,
};

/** Map server `validation_failed.fields` keys → wizard step they belong to. */
const FIELD_TO_STEP: Record<string, WizardStepId> = {
  title: "basics",
  description: "basics",
  category_id: "basics",
  city: "basics",
  gallery: "media",
  pricing_type: "pricing",
  price_amount_kopecks: "pricing",
};

/** Human copy for server field codes. */
const FIELD_ERROR_COPY: Record<string, string> = {
  title_too_short: "Назва занадто коротка (мінімум 12 символів)",
  title_too_long: "Назва задовга (максимум 120 символів)",
  description_too_short: "Опис занадто короткий (мінімум 80 символів)",
  description_too_long: "Опис задовгий (максимум 4000 символів)",
  category_required: "Оберіть категорію 3-го рівня",
  city_required: "Вкажіть місто",
  pricing_type_invalid: "Оберіть модель ціни",
  price_too_low: "Ціна нижча за допустиму (мін. 50 ₴)",
  price_too_high: "Ціна перевищує допустиму",
  gallery_required: "Додайте принаймні одну фотографію",
  gallery_too_many: "Не більше 10 фотографій",
  cover_required: "Позначте обкладинку",
  gallery_invalid: "Перевірте додані файли",
  invalid_attachments: "Один або кілька файлів недійсні — видаліть та додайте знову",
};

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

function formatSaveTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
}

function DraftSaveIndicator({
  status,
  hasDraft,
}: {
  status: SaveStatus;
  hasDraft: boolean;
}) {
  if (!hasDraft && status.kind === "idle") {
    return (
      <span className="text-caption text-muted">
        Чернетка з'явиться після перших правок
      </span>
    );
  }
  if (status.kind === "saving") {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption text-muted">
        <Loader2 size={12} className="animate-spin" aria-hidden />
        Зберігаємо…
      </span>
    );
  }
  if (status.kind === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption text-danger">
        <AlertTriangle size={12} aria-hidden />
        {status.message}
      </span>
    );
  }
  if (status.kind === "saved") {
    return (
      <span className="text-caption text-success">
        Збережено о {formatSaveTime(status.at)}
      </span>
    );
  }
  return (
    <span className="text-caption text-muted">Чернетка готова</span>
  );
}

const TITLE_MAX = 90;
const DESC_MAX = 2000;
const DESC_MIN = 80;

export default function ListingCreateWizard() {
  return (
    <Suspense fallback={null}>
      <ListingCreateWizardInner />
    </Suspense>
  );
}

function ListingCreateWizardInner() {
  const auth = useRequireAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const categoriesState = useCategories();
  const [activeId, setActiveId] = React.useState<WizardStepId>("basics");
  const [visited, setVisited] = React.useState<Set<WizardStepId>>(
    new Set(["basics"])
  );

  // ---------- submit lifecycle ----------
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<CreateListingError | null>(null);
  const [created, setCreated] = React.useState<ListingDetail | null>(null);

  // ---------- draft autosave state ----------
  const [draftId, setDraftId] = React.useState<string | null>(null);
  const [draftHydrating, setDraftHydrating] = React.useState<boolean>(
    !!searchParams.get("draft")
  );
  const draftCreatingRef = React.useRef(false);
  /** Set when the lazy-create POST returned `evicted:[…]` — surface the
   *  lost titles to the user (deep-review MEDIUM від 7dbb64e). */
  const [evictedNote, setEvictedNote] = React.useState<string | null>(null);

  // ---------- form state ----------
  // Real /provider/listings/new starts blank — provider fills it in. The demo
  // route used pre-seeded copy for screenshots; that drift is intentional.
  const [title, setTitle] = React.useState("");
  const [category, setCategory] = React.useState<CategoryPath | null>(null);
  const [description, setDescription] = React.useState("");
  const [city, setCity] = React.useState("");
  const [tags, setTags] = React.useState<string[]>([]);
  const [tagDraft, setTagDraft] = React.useState("");

  // Gallery is derived from the uploader: each successfully-uploaded file
  // becomes a GalleryItem keyed by its localId. We track cover + order locally
  // since the uploader is a pure primitive.
  const uploader = useUploader({ purpose: "listing_gallery", maxFiles: 10 });
  const [coverLocalId, setCoverLocalId] = React.useState<string | null>(null);
  const [order, setOrder] = React.useState<string[]>([]);

  // Keep the local order array in sync with uploader.files: append new ids,
  // drop removed ones. Cover auto-elects the first ready file if none picked.
  React.useEffect(() => {
    const presentIds = new Set(uploader.files.map((f) => f.id));
    setOrder((prev) => {
      const cleaned = prev.filter((id) => presentIds.has(id));
      const appended = uploader.files
        .map((f) => f.id)
        .filter((id) => !cleaned.includes(id));
      return [...cleaned, ...appended];
    });
    if (coverLocalId && !presentIds.has(coverLocalId)) {
      setCoverLocalId(null);
    }
  }, [uploader.files, coverLocalId]);

  const gallery: GalleryItem[] = React.useMemo(() => {
    const byId = new Map(uploader.files.map((f) => [f.id, f]));
    const out: GalleryItem[] = [];
    for (const localId of order) {
      const f = byId.get(localId);
      if (!f || f.status !== "ready") continue;
      const mid = uploader.getMediaId(localId);
      if (!mid) continue;
      out.push({
        id: localId,
        src: getMediaStreamUrl(mid),
        alt: f.file.name,
        isCover: localId === coverLocalId,
      });
    }
    return out;
  }, [uploader, order, coverLocalId]);

  const [priceModel, setPriceModel] = React.useState<PriceModel>("visit");
  const [priceKopecks, setPriceKopecks] = React.useState<number | null>(null);
  const [escrowDeposit, setEscrowDeposit] = React.useState(true);
  const [responseSlaMin, setResponseSlaMin] = React.useState<number>(15);

  const [previewOpen, setPreviewOpen] = React.useState(false);

  // ---------- draft hydration (?draft=<id>) ----------
  // Mark draft as hydrated (or hydration attempted) so we never re-fetch the
  // same id and never overwrite user edits made after hydration.
  const hydratedIdsRef = React.useRef<Set<string>>(new Set());
  // Track if user touched the gallery during this session — until they do,
  // hydration-restored gallery_media_ids must NOT be wiped by autosave (the
  // uploader starts empty after refresh and we cannot rebind file blobs).
  const galleryTouchedRef = React.useRef(false);
  const [hydratedGalleryMediaIds, setHydratedGalleryMediaIds] = React.useState<
    string[] | null
  >(null);
  const [hydratedCoverMediaId, setHydratedCoverMediaId] = React.useState<
    string | null
  >(null);

  React.useEffect(() => {
    if (!auth) return;
    const id = searchParams.get("draft");
    if (!id) {
      setDraftHydrating(false);
      return;
    }
    if (hydratedIdsRef.current.has(id)) return;
    hydratedIdsRef.current.add(id);
    let alive = true;
    (async () => {
      try {
        const draft = await getDraft(id);
        if (!alive) return;
        const p = draft.payload;
        if (typeof p.title === "string") setTitle(p.title);
        if (typeof p.description === "string") setDescription(p.description);
        if (typeof p.city === "string") setCity(p.city);
        if (Array.isArray(p.tags)) setTags(p.tags);
        if (p.category_path?.l1 && p.category_path?.l2 && p.category_path?.l3) {
          setCategory(p.category_path as CategoryPath);
        }
        if (p.pricing_type) setPriceModel(p.pricing_type);
        if (typeof p.price_amount_kopecks === "number")
          setPriceKopecks(p.price_amount_kopecks);
        if (typeof p.escrow_deposit === "boolean") setEscrowDeposit(p.escrow_deposit);
        if (typeof p.response_sla_minutes === "number")
          setResponseSlaMin(p.response_sla_minutes);
        if (Array.isArray(p.gallery_media_ids))
          setHydratedGalleryMediaIds(p.gallery_media_ids);
        if (p.cover_media_id) setHydratedCoverMediaId(p.cover_media_id);
        setDraftId(draft.id);
      } catch {
        // 404/403 — clear the dead `?draft=` param so we don't loop, then
        // start fresh. Lazy-create kicks in on first edit.
        const url = new URL(window.location.href);
        url.searchParams.delete("draft");
        router.replace(url.pathname + url.search, { scroll: false });
      } finally {
        if (alive) setDraftHydrating(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [auth, searchParams, router]);

  // ---------- lazy draft creation on first edit ----------
  const hasContent =
    !!title.trim() ||
    !!description.trim() ||
    !!city.trim() ||
    tags.length > 0 ||
    !!category ||
    priceKopecks !== null;
  React.useEffect(() => {
    if (!auth || draftId || draftHydrating || draftCreatingRef.current) return;
    if (!hasContent) return;
    draftCreatingRef.current = true;
    (async () => {
      try {
        const draft = await createDraft();
        // Mark as already-hydrated so the URL replace below doesn't trigger
        // a redundant GET on the freshly-created (empty) draft.
        hydratedIdsRef.current.add(draft.id);
        setDraftId(draft.id);
        if (draft.evicted.length > 0) {
          const names = draft.evicted
            .map((e) => `«${e.title}»`)
            .join(", ");
          setEvictedNote(
            draft.evicted.length === 1
              ? `Замінили найстарішу чернетку ${names}`
              : `Замінили найстарiшi чернетки: ${names}`
          );
        }
        // Reflect in URL so refresh / dashboard "Resume" can retrieve it.
        const url = new URL(window.location.href);
        url.searchParams.set("draft", draft.id);
        router.replace(url.pathname + url.search, { scroll: false });
      } catch {
        // Ignore — user can still publish without a draft row.
      } finally {
        draftCreatingRef.current = false;
      }
    })();
  }, [auth, draftId, draftHydrating, hasContent, router]);

  // ---------- autosave snapshot ----------
  // Built from current state every render; useDraftAutosave debounces +
  // diff-checks JSON.stringify so we don't hit the network on identical state.
  // Gallery is included only after the user has touched it this session —
  // otherwise hydrated draft.gallery_media_ids would be wiped (uploader has
  // no way to re-bind file blobs after refresh). uploader.getMediaId is
  // useCallback'd in lib/media.ts so passing it as a dep is stable.
  const liveGalleryMediaIds = React.useMemo(
    () =>
      gallery
        .map((g) => uploader.getMediaId(g.id))
        .filter((mid): mid is string => mid !== null),
    [gallery, uploader.getMediaId]
  );
  const liveCoverMediaId = React.useMemo(
    () => (coverLocalId ? uploader.getMediaId(coverLocalId) : null),
    [coverLocalId, uploader.getMediaId]
  );

  // Mark gallery as touched once the user uploads or removes a file.
  React.useEffect(() => {
    if (uploader.files.length > 0) galleryTouchedRef.current = true;
  }, [uploader.files.length]);

  const autosavePayload: DraftPayload = React.useMemo(() => {
    // Convention: send `null` for cleared text fields so the mock merger
    // can distinguish "untouched" (omitted) from "explicit clear" (null).
    const galleryFields = galleryTouchedRef.current
      ? {
          gallery_media_ids: liveGalleryMediaIds,
          cover_media_id: liveCoverMediaId,
        }
      : hydratedGalleryMediaIds !== null
        ? {
            gallery_media_ids: hydratedGalleryMediaIds,
            cover_media_id: hydratedCoverMediaId,
          }
        : {};
    return {
      title: title.trim() || null,
      description: description.trim() || null,
      city: city.trim() || null,
      tags,
      category_path: category
        ? { l1: category.l1, l2: category.l2, l3: category.l3 }
        : undefined,
      pricing_type: priceModel,
      price_amount_kopecks: priceKopecks,
      escrow_deposit: escrowDeposit,
      response_sla_minutes: responseSlaMin,
      ...galleryFields,
    };
  }, [
    title,
    description,
    city,
    tags,
    category,
    priceModel,
    priceKopecks,
    escrowDeposit,
    responseSlaMin,
    liveGalleryMediaIds,
    liveCoverMediaId,
    hydratedGalleryMediaIds,
    hydratedCoverMediaId,
  ]);

  const saveStatus = useDraftAutosave({
    draftId,
    payload: autosavePayload,
    enabled: !submitting && !created && !draftHydrating,
  });

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
    else if (!gallery.some((g) => g.isCover))
      e.push("Позначте обкладинку");
    if (uploader.uploading) e.push("Зачекайте завершення завантаження");
    if (uploader.hasErrors) e.push("Видаліть файли з помилкою");
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

  // ---------- server field errors → merge into per-step errors ----------
  if (submitError?.fields) {
    for (const [field, code] of Object.entries(submitError.fields)) {
      const step = FIELD_TO_STEP[field];
      if (!step) continue;
      const msg = FIELD_ERROR_COPY[code] ?? code;
      const list = (errors[step] ??= []);
      if (!list.includes(msg)) list.push(msg);
    }
  }

  // ---------- submit ----------
  const submit = async () => {
    if (!allValid || submitting) return;
    if (!category?.l3?.id) return;
    setSubmitting(true);
    setSubmitError(null);
    const result = await createListing({
      title: title.trim(),
      description: description.trim(),
      category_id: category.l3.id,
      category_path: {
        l1: category.l1 ? { id: category.l1.id, name: category.l1.name } : undefined,
        l2: category.l2 ? { id: category.l2.id, name: category.l2.name } : undefined,
        l3: category.l3 ? { id: category.l3.id, name: category.l3.name } : undefined,
      },
      city: city.trim(),
      tags,
      pricing_type: priceModel,
      price_amount_kopecks: priceKopecks!,
      escrow_deposit: escrowDeposit,
      response_sla_minutes: responseSlaMin,
      gallery: gallery
        .map((g) => {
          const mid = uploader.getMediaId(g.id);
          if (!mid) return null;
          return { media_id: mid, alt: g.alt, is_cover: !!g.isCover };
        })
        .filter((g): g is { media_id: string; alt: string; is_cover: boolean } => g !== null),
      // Atomic publish + draft cleanup (server deletes inside same handler).
      draft_id: draftId ?? undefined,
    });
    setSubmitting(false);
    if (result.ok) {
      setCreated(result.listing);
    } else {
      setSubmitError(result.error);
      if (result.error.status === 401) {
        router.replace(
          `/login?next=${encodeURIComponent("/listing-create")}`
        );
        return;
      }
      // Jump to the first step that has field errors so the user sees them.
      if (result.error.fields) {
        for (const field of Object.keys(result.error.fields)) {
          const step = FIELD_TO_STEP[field];
          if (step) {
            setActiveId(step);
            setVisited((v) => new Set(v).add(step));
            return;
          }
        }
      }
    }
  };

  // Gallery / cover handlers — proxy through to uploader + local state.
  const setCover = (localId: string) => setCoverLocalId(localId);
  const removeFile = (localId: string) => {
    uploader.removeFile(localId);
    if (coverLocalId === localId) setCoverLocalId(null);
  };
  const reorder = (next: GalleryItem[]) => setOrder(next.map((g) => g.id));

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
      name: auth?.user.display_name ?? USER_FALLBACK.displayName,
      kycVerified: auth?.user.kyc_status === "approved",
      avgRating: 5.0,
      reviewsCount: 0,
      completedDealsCount: 0,
    },
  };

  const topNavUser = auth
    ? {
        id: auth.user.id,
        displayName: auth.user.display_name,
        email: auth.user.email,
        kycVerified: auth.user.kyc_status === "approved",
        hasProviderRole: auth.user.has_provider_role,
      }
    : USER_FALLBACK;

  if (!auth) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-muted" />
      </main>
    );
  }

  if (created) {
    return (
      <>
        <TopNav user={topNavUser} notificationsUnread={3} messagesUnread={12} />
        <SuccessScreen
          icon={<Check size={28} />}
          iconTone="success"
          kicker="Послугу опубліковано"
          title={
            <>
              Готово —
              <br />
              <span className="text-accent italic">ваша послуга у стрічці</span>
            </>
          }
          description="Клієнти вже бачать вашу картку у стрічці пошуку. За потреби ви можете відредагувати її у кабінеті виконавця."
          badge={
            <Badge tone="success" size="sm" shape="square">
              Активна
            </Badge>
          }
          actions={
            <>
              <Button
                variant="accent"
                onClick={() => router.push(`/listings/${created.id}`)}
              >
                Подивитись картку
              </Button>
              <Button
                variant="secondary"
                onClick={() => router.push("/provider-dashboard")}
              >
                У кабінет
              </Button>
            </>
          }
          steps={[
            {
              n: "01",
              label: "Перевірка модерацією",
              hint: "У продакшен-режимі модерація триває до 24 год. У демо публікація миттєва.",
            },
            {
              n: "02",
              label: "Перші запити",
              hint: "Клієнти зможуть створити угоду через ескроу — гроші тримаються до завершення.",
            },
            {
              n: "03",
              label: "Аналітика",
              hint: "Перегляди та контакти зʼявляться у вкладці Послуги вашого кабінету.",
            },
          ]}
        />
        <Footer />
      </>
    );
  }

  return (
    <>
      <TopNav user={topNavUser} notificationsUnread={3} messagesUnread={12} />

      <main className="mx-auto max-w-7xl px-4 md:px-6 pt-6 md:pt-10 pb-40 md:pb-32">
        <EditorialPageHeader
          kicker="Створення послуги"
          title={
            <>
              Нова послуга
              <br />
              <span className="text-ink-soft italic">за чотири кроки</span>
            </>
          }
          sidecar={
            <>
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
                Опублікуємо лише після перевірки модерацією.
              </p>
              <div className="mt-2">
                <DraftSaveIndicator status={saveStatus} hasDraft={!!draftId} />
              </div>
            </>
          }
        />

        {evictedNote && (
          <div className="mt-6">
            <InlineAlert tone="warning" onDismiss={() => setEvictedNote(null)}>
              {evictedNote}. У вашому акаунті можна зберігати максимум 5 чернеток одночасно.
            </InlineAlert>
          </div>
        )}

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
            {submitError && (
              <div className="mb-4">
                <InlineAlert tone="danger" title={submitError.message}>
                  {submitError.fields
                    ? "Кроки з помилками підсвічено в навігації — перевірте їх і спробуйте знову."
                    : "Спробуйте ще раз через хвилину. Якщо проблема повториться — повідомте підтримку."}
                </InlineAlert>
              </div>
            )}
            <WizardSheet
              index={idx + 1}
              title={STEPS_DATA[idx].label}
              valid={stepValid(activeId)}
              errors={errors[activeId]}
            >
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
                    categoriesState={categoriesState}
                  />
                )}

                {activeId === "media" && (
                  <MediaStep
                    uploader={uploader}
                    gallery={gallery}
                    onSetCover={setCover}
                    onRemove={removeFile}
                    onReorder={reorder}
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
            </WizardSheet>

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

      <WizardActionBar
        index={idx + 1}
        totalSteps={STEPS_DATA.length}
        stepLabel={STEPS_DATA[idx].label}
        onBack={back}
        rightActions={
          <>
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
                rightIcon={
                  submitting ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Check size={14} />
                  )
                }
                disabled={!allValid || submitting}
                onClick={submit}
              >
                {submitting ? "Публікуємо…" : "Опублікувати"}
              </Button>
            )}
          </>
        }
      />

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
  categoriesState,
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
  categoriesState: ReturnType<typeof useCategories>;
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
          {categoriesState.loading ? (
            <div className="h-12 rounded-[var(--radius-md)] border border-hairline bg-paper animate-pulse" />
          ) : categoriesState.error ? (
            <InlineAlert tone="danger" title="Не вдалось завантажити категорії">
              Спробуйте оновити сторінку.
            </InlineAlert>
          ) : (
            <CategoryPicker
              categories={categoriesState.data ?? []}
              value={category}
              onChange={setCategory}
            />
          )}
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
  uploader,
  gallery,
  onSetCover,
  onRemove,
  onReorder,
}: {
  uploader: ReturnType<typeof useUploader>;
  gallery: GalleryItem[];
  onSetCover: (id: string) => void;
  onRemove: (id: string) => void;
  onReorder: (next: GalleryItem[]) => void;
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
            <div>
              <FileUploader
                accept={uploader.accept}
                multiple
                maxFiles={10}
                maxSizeBytes={uploader.maxSizeBytes}
                files={uploader.files}
                onFilesAdd={uploader.addFiles}
                onRemove={onRemove}
              />
              {uploader.hasErrors && (
                <p className="mt-2 text-caption text-warning">
                  Файли з помилкою не будуть надіслані. Видаліть їх та повторіть.
                </p>
              )}
            </div>
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
          onRemove={onRemove}
          onSetCover={onSetCover}
          onReorder={onReorder}
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
      <div className="md:col-span-12">
        <FormField label="Модель ціноутворення" required>
          <RadioCardGroup
            value={priceModel}
            onChange={setPriceModel}
            columns={4}
            labelSize="lg"
            options={PRICE_MODELS.map((m) => ({
              id: m.id,
              label: m.label,
              hint: m.hint,
            }))}
          />
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

      <div className="md:col-span-12">
        <TermCheckbox
          checked={escrowDeposit}
          onChange={setEscrowDeposit}
          title="Захист ескроу"
          body="Кошти заморожуються на платформі і переходять виконавцю лише після підтвердження роботи. Рекомендовано для всіх послуг від 500 ₴."
          icon={<ShieldCheck size={18} />}
          className="p-5"
        />
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
