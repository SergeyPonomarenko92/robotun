"use client";
import * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ShieldCheck,
  Camera,
  FileText,
  Building2,
  CheckCircle2,
  Lock,
  AlertTriangle,
  Sparkles,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { TopNav } from "@/components/organisms/TopNav";
import { MobileTabBar } from "@/components/organisms/MobileTabBar";
import { Footer } from "@/components/organisms/Footer";
import { KYCStatusBadge } from "@/components/organisms/KYCStatusBadge";

import { Stepper, type Step } from "@/components/ui/Stepper";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Tooltip } from "@/components/ui/Tooltip";
import { FileUploader } from "@/components/ui/FileUploader";
import { useUploader } from "@/lib/media";
import { Modal } from "@/components/ui/Modal";
import { RadioCardGroup } from "@/components/ui/RadioCardGroup";
import { TermCheckbox } from "@/components/ui/TermCheckbox";
import { EditorialPageHeader } from "@/components/organisms/EditorialPageHeader";
import { WizardSheet } from "@/components/organisms/WizardSheet";
import { WizardActionBar } from "@/components/organisms/WizardActionBar";
import { SuccessScreen } from "@/components/organisms/SuccessScreen";
import { useRequireAuth } from "@/lib/auth";
import { useRouter } from "next/navigation";
import { submitKyc, useKycStatus } from "@/lib/kyc";

type StepId = "doc" | "selfie" | "payout" | "review";

const STEPS_DATA: { id: StepId; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: "doc", label: "Документ", hint: "Паспорт або ID-карта", icon: <FileText size={16} /> },
  { id: "selfie", label: "Селфі", hint: "Liveness-перевірка", icon: <Camera size={16} /> },
  { id: "payout", label: "Реквізити", hint: "Куди отримуватимете виплати", icon: <Building2 size={16} /> },
  { id: "review", label: "Перевірка", hint: "Ми вручну верифікуємо", icon: <ShieldCheck size={16} /> },
];

type DocType = "passport" | "id_card" | "bio_passport";
const DOC_TYPES: { id: DocType; label: string; sub: string }[] = [
  { id: "id_card", label: "ID-картка", sub: "пластикова, обидві сторони" },
  { id: "passport", label: "Паспорт-книжка", sub: "розворот зі світлиною" },
  { id: "bio_passport", label: "Закордонний", sub: "розворот з даними" },
];

type SelfieState = "idle" | "capturing" | "verifying" | "done" | "failed";

type PayoutMethod = "card" | "iban";

export default function KYCPage() {
  const auth = useRequireAuth("/login");
  const router = useRouter();

  // Only provider-role accounts have a reason to be here. Clients are sent
  // to the dashboard; the request to become a provider is a different flow.
  React.useEffect(() => {
    if (auth && !auth.user.has_provider_role) {
      router.replace("/");
    }
  }, [auth, router]);

  const [activeId, setActiveId] = React.useState<StepId>("doc");
  const [visited, setVisited] = React.useState<Set<StepId>>(new Set(["doc"]));
  const [submitted, setSubmitted] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const kycSnapshot = useKycStatus();

  // doc — real /provider/kyc starts blank; demo-style placeholders removed.
  const [docType, setDocType] = React.useState<DocType>("id_card");
  const docFrontUploader = useUploader({
    purpose: "kyc_document",
    maxFiles: 1,
    endpoint: "kyc",
  });
  const docBackUploader = useUploader({
    purpose: "kyc_document",
    maxFiles: 1,
    endpoint: "kyc",
  });
  const [legalName, setLegalName] = React.useState("");
  const [taxId, setTaxId] = React.useState("");

  // selfie
  const [selfieState, setSelfieState] = React.useState<SelfieState>("idle");
  const [selfieAttempt, setSelfieAttempt] = React.useState(0);

  // payout
  const [payoutMethod, setPayoutMethod] = React.useState<PayoutMethod>("card");
  const [cardNumber, setCardNumber] = React.useState("");
  const [iban, setIban] = React.useState("");
  const [bankName, setBankName] = React.useState("");
  const [accountHolder, setAccountHolder] = React.useState("");
  const [confirmPayout, setConfirmPayout] = React.useState(false);

  // ---------- validation ----------
  const errors: Partial<Record<StepId, string[]>> = {};
  {
    const e: string[] = [];
    if (docFrontUploader.mediaIds.length === 0)
      e.push("Додайте лицьову сторону документа");
    if (docType === "id_card" && docBackUploader.mediaIds.length === 0)
      e.push("Додайте зворотню сторону ID-картки");
    if (docFrontUploader.uploading || docBackUploader.uploading)
      e.push("Зачекайте завершення завантаження");
    if (docFrontUploader.hasErrors || docBackUploader.hasErrors)
      e.push("Видаліть файли з помилкою");
    if (legalName.trim().length < 4) e.push("ПІБ — мінімум 4 символи");
    if (!/^\d{10}$/.test(taxId)) e.push("ІПН — рівно 10 цифр");
    if (e.length) errors.doc = e;
  }
  {
    const e: string[] = [];
    if (selfieState !== "done") e.push("Пройдіть liveness-перевірку до кінця");
    if (e.length) errors.selfie = e;
  }
  {
    const e: string[] = [];
    if (payoutMethod === "card" && cardNumber.replace(/\s/g, "").length < 16)
      e.push("Номер картки — 16 цифр");
    if (payoutMethod === "iban" && iban.replace(/\s/g, "").length < 29)
      e.push("IBAN — 29 символів");
    if (!bankName.trim()) e.push("Вкажіть банк");
    if (!accountHolder.trim()) e.push("Імʼя власника рахунку обовʼязкове");
    if (!confirmPayout) e.push("Підтвердіть, що рахунок належить вам");
    if (e.length) errors.payout = e;
  }

  const stepValid = (id: StepId) => !errors[id];
  const allValid = (["doc", "selfie", "payout"] as StepId[]).every(stepValid);

  const stepStatus = (id: StepId): NonNullable<Step["status"]> => {
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

  const idx = STEPS_DATA.findIndex((s) => s.id === activeId);
  const goto = (id: StepId) => {
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

  // selfie liveness mock
  React.useEffect(() => {
    if (selfieState === "capturing") {
      const t = setTimeout(() => setSelfieState("verifying"), 1600);
      return () => clearTimeout(t);
    }
    if (selfieState === "verifying") {
      const t = setTimeout(() => {
        if (selfieAttempt > 0 && selfieAttempt % 3 === 1) {
          setSelfieState("failed");
        } else {
          setSelfieState("done");
        }
      }, 1800);
      return () => clearTimeout(t);
    }
  }, [selfieState, selfieAttempt]);

  // Auth still loading → render minimal frame to avoid layout flash.
  if (auth === null) {
    return (
      <main
        role="status"
        aria-live="polite"
        className="min-h-screen flex items-center justify-center bg-canvas"
      >
        <Loader2 size={20} className="animate-spin text-muted" aria-hidden />
        <span className="sr-only">Завантаження…</span>
      </main>
    );
  }
  if (!auth.user.has_provider_role) return null;

  // If the provider already has an active KYC application (submitted /
  // in_review / approved) — show the success view instead of the wizard.
  // `cancelled` / `rejected` / `expired` fall through so the user can resubmit.
  const serverStatus = kycSnapshot.data?.status;
  const showResultScreen =
    submitted ||
    serverStatus === "submitted" ||
    serverStatus === "in_review" ||
    serverStatus === "approved";
  if (showResultScreen) {
    return <SubmittedScreen onAgain={() => setSubmitted(false)} />;
  }

  return (
    <>
      <TopNav />

      <main className="mx-auto max-w-7xl px-4 md:px-6 pt-6 md:pt-10 pb-40 md:pb-32">
        <EditorialPageHeader
          kicker="Верифікація виконавця"
          title={
            <>
              Підтвердження
              <br />
              <span className="text-ink-soft italic">особистості</span>
            </>
          }
          description="Це потрібно лише для виплат — ваші угоди можна вести й без KYC. Усі документи зберігаються зашифровано та видаляються після затвердження."
          sidecar={
            <div className="flex flex-col gap-3 lg:items-end">
              <KYCStatusBadge status="not_started" />
              <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
                Очікуваний час перевірки&nbsp;·&nbsp;
                <span className="text-ink-soft">до 24 годин</span>
              </p>
            </div>
          }
        />

        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-10 lg:gap-14">
          {/* Stepper rail */}
          <aside className="lg:sticky lg:top-24 self-start">
            <div className="lg:hidden">
              <Stepper
                steps={stepperSteps}
                activeId={activeId}
                orientation="horizontal"
              />
            </div>
            <div className="hidden lg:block">
              <Stepper
                steps={stepperSteps}
                activeId={activeId}
                orientation="vertical"
              />
              <div className="mt-8 border-t border-hairline pt-5 space-y-4">
                <div className="flex items-start gap-3">
                  <Lock size={14} className="text-success mt-0.5 shrink-0" />
                  <p className="text-caption text-ink-soft leading-relaxed">
                    AES-256, зберігання у криптованому S3, KYC-провайдер
                    Diia.Verified.
                  </p>
                </div>
                <div className="flex items-start gap-3">
                  <RefreshCw size={14} className="text-muted mt-0.5 shrink-0" />
                  <p className="text-caption text-ink-soft leading-relaxed">
                    Документи видаляються через 30 днів після верифікації.
                  </p>
                </div>
              </div>
            </div>
          </aside>

          {/* Step content */}
          <section className="min-w-0">
            <WizardSheet
              index={idx + 1}
              title={STEPS_DATA[idx].label}
              icon={STEPS_DATA[idx].icon}
              valid={stepValid(activeId)}
              statusBadge={stepValid(activeId) ? undefined : null}
              errors={errors[activeId]}
            >
                {activeId === "doc" && (
                  <DocStep
                    docType={docType}
                    setDocType={setDocType}
                    frontUploader={docFrontUploader}
                    backUploader={docBackUploader}
                    legalName={legalName}
                    setLegalName={setLegalName}
                    taxId={taxId}
                    setTaxId={setTaxId}
                  />
                )}
                {activeId === "selfie" && (
                  <SelfieStep
                    state={selfieState}
                    onStart={() => {
                      setSelfieAttempt((a) => a + 1);
                      setSelfieState("capturing");
                    }}
                    onRetry={() => {
                      setSelfieState("idle");
                    }}
                  />
                )}
                {activeId === "payout" && (
                  <PayoutStep
                    method={payoutMethod}
                    setMethod={setPayoutMethod}
                    cardNumber={cardNumber}
                    setCardNumber={setCardNumber}
                    iban={iban}
                    setIban={setIban}
                    bankName={bankName}
                    setBankName={setBankName}
                    accountHolder={accountHolder}
                    setAccountHolder={setAccountHolder}
                    confirmPayout={confirmPayout}
                    setConfirmPayout={setConfirmPayout}
                  />
                )}
                {activeId === "review" && (
                  <ReviewStep
                    docType={docType}
                    legalName={legalName}
                    taxId={taxId}
                    payoutMethod={payoutMethod}
                    cardNumber={cardNumber}
                    iban={iban}
                    bankName={bankName}
                    accountHolder={accountHolder}
                    onJump={goto}
                    allValid={allValid}
                    errors={errors}
                  />
                )}
            </WizardSheet>

            <div className="mt-6 hidden md:flex items-center gap-3 text-caption text-muted">
              <Sparkles size={14} className="text-accent" />
              <span>
                Перевірка займає до 24 годин. Ми сповістимо у чаті, як тільки
                буде результат.
              </span>
            </div>
          </section>
          {submitError && (
            <div className="mt-6">
              <InlineAlert tone="danger">{submitError}</InlineAlert>
            </div>
          )}
        </div>
      </main>

      <WizardActionBar
        index={idx + 1}
        totalSteps={STEPS_DATA.length}
        stepLabel={STEPS_DATA[idx].label}
        onBack={back}
        rightActions={
          idx < STEPS_DATA.length - 1 ? (
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
              rightIcon={<ShieldCheck size={14} />}
              disabled={!allValid || submitting}
              onClick={async () => {
                if (submitting) return;
                setSubmitting(true);
                setSubmitError(null);
                const r = await submitKyc({
                  doc_type: docType,
                  doc_media_ids: [
                    ...docFrontUploader.mediaIds,
                    ...docBackUploader.mediaIds,
                  ],
                  legal_name: legalName,
                  tax_id: taxId,
                  payout_method: payoutMethod,
                  payout_details: {
                    card_number:
                      payoutMethod === "card" ? cardNumber : undefined,
                    iban: payoutMethod === "iban" ? iban : undefined,
                    bank_name: bankName,
                    account_holder: accountHolder,
                  },
                });
                setSubmitting(false);
                if (r.ok) {
                  setSubmitted(true);
                  kycSnapshot.refresh();
                } else {
                  setSubmitError(r.error.message);
                }
              }}
            >
              {submitting ? "Надсилаємо…" : "Надіслати на перевірку"}
            </Button>
          )
        }
      />

      <Footer />
      <MobileTabBar messagesUnread={6} />
    </>
  );
}

/* ===========================================================
   Step: DOC
   =========================================================== */
function DocStep({
  docType,
  setDocType,
  frontUploader,
  backUploader,
  legalName,
  setLegalName,
  taxId,
  setTaxId,
}: {
  docType: DocType;
  setDocType: (v: DocType) => void;
  frontUploader: ReturnType<typeof useUploader>;
  backUploader: ReturnType<typeof useUploader>;
  legalName: string;
  setLegalName: (v: string) => void;
  taxId: string;
  setTaxId: (v: string) => void;
}) {
  return (
    <div className="space-y-8">
      <FormField label="Тип документа" required>
        <RadioCardGroup
          value={docType}
          onChange={setDocType}
          columns={3}
          options={DOC_TYPES.map((d) => ({
            id: d.id,
            label: d.label,
            hint: d.sub,
          }))}
        />
      </FormField>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <FormField
          label="Лицьова сторона"
          required
          helper="JPG / PNG / PDF, до 20 МБ. Перевірка ClamAV ~2 сек."
        >
          <FileUploader
            accept={frontUploader.accept}
            maxFiles={1}
            maxSizeBytes={frontUploader.maxSizeBytes}
            files={frontUploader.files}
            onFilesAdd={frontUploader.addFiles}
            onRemove={frontUploader.removeFile}
          />
        </FormField>

        <FormField
          label={docType === "id_card" ? "Зворотна сторона" : "Розворот зі світлиною"}
          required={docType === "id_card"}
          optional={docType !== "id_card"}
          helper="JPG / PNG / PDF, до 20 МБ"
        >
          <FileUploader
            accept={backUploader.accept}
            maxFiles={1}
            maxSizeBytes={backUploader.maxSizeBytes}
            files={backUploader.files}
            onFilesAdd={backUploader.addFiles}
            onRemove={backUploader.removeFile}
          />
        </FormField>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-x-8 gap-y-6">
        <div className="md:col-span-7">
          <FormField
            label="Повне імʼя у документі"
            required
            helper="Як написано в документі — точно, з пробілами та регістром."
          >
            <Input
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              placeholder="Олександр Петренко"
            />
          </FormField>
        </div>
        <div className="md:col-span-5">
          <FormField
            label="ІПН"
            required
            helper="10 цифр, без пробілів"
          >
            <Input
              value={taxId}
              onChange={(e) => setTaxId(e.target.value.replace(/\D/g, "").slice(0, 10))}
              placeholder="3284756291"
              inputMode="numeric"
            />
          </FormField>
        </div>
      </div>

      <div className="border border-hairline rounded-[var(--radius-md)] bg-canvas p-5">
        <p className="font-mono text-micro uppercase tracking-[0.22em] text-accent mb-2">
          Як знімати документ
        </p>
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-2 text-caption text-ink-soft leading-relaxed">
          <li className="flex gap-2">
            <span className="font-mono text-muted">01</span>
            Усі краї документа в кадрі
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-muted">02</span>
            Без бліків і відображень
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-muted">03</span>
            Текст чіткий і читабельний
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-muted">04</span>
            Без редакторів — оригінальне фото
          </li>
        </ul>
      </div>
    </div>
  );
}

/* ===========================================================
   Step: SELFIE (liveness stub)
   =========================================================== */
function SelfieStep({
  state,
  onStart,
  onRetry,
}: {
  state: SelfieState;
  onStart: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-x-8 gap-y-6">
      {/* Camera frame */}
      <div className="md:col-span-7">
        <div
          className={[
            "relative aspect-square md:aspect-[4/5] rounded-[var(--radius-md)] overflow-hidden border-2 transition-colors",
            state === "done"
              ? "border-success bg-success-soft"
              : state === "failed"
                ? "border-danger bg-danger-soft"
                : state === "verifying"
                  ? "border-accent bg-accent-soft"
                  : "border-hairline-strong bg-canvas",
          ].join(" ")}
        >
          {/* face guide circle */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div
              className={[
                "rounded-full border-2 transition-all",
                "h-2/3 aspect-[4/5]",
                state === "capturing"
                  ? "border-accent animate-pulse"
                  : state === "verifying"
                    ? "border-accent border-dashed"
                    : state === "done"
                      ? "border-success"
                      : state === "failed"
                        ? "border-danger"
                        : "border-ink-soft border-dashed",
              ].join(" ")}
              aria-hidden
            />
          </div>

          {/* state overlay */}
          <div className="absolute inset-0 flex flex-col items-center justify-end p-6 text-center">
            {state === "idle" && (
              <p className="font-mono text-micro uppercase tracking-[0.22em] text-muted">
                Камера готова
              </p>
            )}
            {state === "capturing" && (
              <p className="font-mono text-micro uppercase tracking-[0.22em] text-accent inline-flex items-center gap-2">
                <Loader2 size={12} className="animate-spin" />
                Тримайте обличчя в овалі
              </p>
            )}
            {state === "verifying" && (
              <p className="font-mono text-micro uppercase tracking-[0.22em] text-accent inline-flex items-center gap-2">
                <Loader2 size={12} className="animate-spin" />
                Перевірка liveness…
              </p>
            )}
            {state === "done" && (
              <p className="font-display text-h3 text-success inline-flex items-center gap-2">
                <CheckCircle2 size={20} />
                Готово
              </p>
            )}
            {state === "failed" && (
              <p className="font-display text-h3 text-danger inline-flex items-center gap-2">
                <AlertTriangle size={20} />
                Не вдалось — спробуйте ще
              </p>
            )}
          </div>

          {/* corner marks for "viewfinder" feel */}
          {(["tl", "tr", "bl", "br"] as const).map((c) => (
            <span
              key={c}
              aria-hidden
              className={[
                "absolute h-5 w-5 border-ink",
                c === "tl" && "top-3 left-3 border-l-2 border-t-2",
                c === "tr" && "top-3 right-3 border-r-2 border-t-2",
                c === "bl" && "bottom-3 left-3 border-l-2 border-b-2",
                c === "br" && "bottom-3 right-3 border-r-2 border-b-2",
              ]
                .filter(Boolean)
                .join(" ")}
            />
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {state === "idle" && (
            <Button
              variant="accent"
              size="lg"
              leftIcon={<Camera size={16} />}
              onClick={onStart}
            >
              Запустити камеру
            </Button>
          )}
          {(state === "capturing" || state === "verifying") && (
            <Button variant="secondary" size="lg" disabled>
              Зачекайте…
            </Button>
          )}
          {state === "done" && (
            <Badge tone="success" shape="square">
              <CheckCircle2 size={10} className="mr-1" />
              Liveness пройдено
            </Badge>
          )}
          {state === "failed" && (
            <Button
              variant="accent"
              size="lg"
              leftIcon={<RefreshCw size={16} />}
              onClick={onRetry}
            >
              Спробувати знову
            </Button>
          )}
        </div>
      </div>

      {/* Tips */}
      <aside className="md:col-span-5">
        <div className="border border-hairline rounded-[var(--radius-md)] bg-paper p-5 h-full">
          <p className="font-mono text-micro uppercase tracking-[0.22em] text-accent mb-3">
            Liveness — що це
          </p>
          <p className="text-caption text-ink-soft leading-relaxed mb-4">
            Серія коротких рухів (поворот голови, моргання) підтверджує, що
            це жива людина, а не фото. Запис не передається третім особам і
            видаляється після перевірки.
          </p>
          <p className="font-mono text-micro uppercase tracking-[0.22em] text-muted mb-2">
            Поради
          </p>
          <ul className="text-caption text-ink-soft space-y-2 leading-relaxed">
            <li className="flex gap-2">
              <span className="font-mono text-muted">01</span>
              Природне світло, без контрового сонця.
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-muted">02</span>
              Зніміть окуляри і головний убір.
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-muted">03</span>
              Камера на рівні очей, обличчя в овалі.
            </li>
          </ul>
        </div>
      </aside>
    </div>
  );
}

/* ===========================================================
   Step: PAYOUT
   =========================================================== */
function PayoutStep({
  method,
  setMethod,
  cardNumber,
  setCardNumber,
  iban,
  setIban,
  bankName,
  setBankName,
  accountHolder,
  setAccountHolder,
  confirmPayout,
  setConfirmPayout,
}: {
  method: PayoutMethod;
  setMethod: (m: PayoutMethod) => void;
  cardNumber: string;
  setCardNumber: (v: string) => void;
  iban: string;
  setIban: (v: string) => void;
  bankName: string;
  setBankName: (v: string) => void;
  accountHolder: string;
  setAccountHolder: (v: string) => void;
  confirmPayout: boolean;
  setConfirmPayout: (v: boolean) => void;
}) {
  return (
    <div className="space-y-8">
      <FormField label="Метод виплати" required>
        <RadioCardGroup
          value={method}
          onChange={setMethod}
          columns={2}
          labelSize="lg"
          options={[
            { id: "card", label: "Картка", hint: "Visa / MasterCard, миттєво" },
            { id: "iban", label: "IBAN", hint: "банківський рахунок, до 1 дня" },
          ]}
        />
      </FormField>

      {method === "card" ? (
        <FormField label="Номер картки" required helper="16 цифр, без пробілів">
          <Input
            value={cardNumber}
            onChange={(e) => setCardNumber(e.target.value)}
            placeholder="0000 0000 0000 0000"
            inputMode="numeric"
            className="font-mono tabular-nums tracking-[0.2em]"
          />
        </FormField>
      ) : (
        <FormField label="IBAN" required helper="UA + 27 символів">
          <Input
            value={iban}
            onChange={(e) => setIban(e.target.value)}
            placeholder="UA00 0000 0000 0000 0000 0000 0000 0"
            className="font-mono tabular-nums"
          />
        </FormField>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <FormField label="Банк" required>
          <Input
            value={bankName}
            onChange={(e) => setBankName(e.target.value)}
            placeholder="ПриватБанк"
          />
        </FormField>
        <FormField label="Власник рахунку" required>
          <Input
            value={accountHolder}
            onChange={(e) => setAccountHolder(e.target.value)}
            placeholder="ФОП Петренко О."
          />
        </FormField>
      </div>

      <TermCheckbox
        checked={confirmPayout}
        onChange={setConfirmPayout}
        title="Я підтверджую, що рахунок належить мені"
        body="Імʼя власника має співпадати з даними у документі. Виплати на чужі рахунки заборонені."
        icon={<ShieldCheck size={16} />}
        className="p-5"
      />
    </div>
  );
}

/* ===========================================================
   Step: REVIEW
   =========================================================== */
function ReviewStep({
  docType,
  legalName,
  taxId,
  payoutMethod,
  cardNumber,
  iban,
  bankName,
  accountHolder,
  onJump,
  allValid,
  errors,
}: {
  docType: DocType;
  legalName: string;
  taxId: string;
  payoutMethod: PayoutMethod;
  cardNumber: string;
  iban: string;
  bankName: string;
  accountHolder: string;
  onJump: (id: StepId) => void;
  allValid: boolean;
  errors: Partial<Record<StepId, string[]>>;
}) {
  const sections: { step: StepId; label: string; rows: [string, string][] }[] = [
    {
      step: "doc",
      label: "Документ",
      rows: [
        [
          "Тип",
          docType === "id_card"
            ? "ID-картка"
            : docType === "passport"
              ? "Паспорт-книжка"
              : "Закордонний",
        ],
        ["ПІБ", legalName],
        ["ІПН", taxId],
      ],
    },
    {
      step: "selfie",
      label: "Селфі",
      rows: [["Liveness", "пройдено"]],
    },
    {
      step: "payout",
      label: "Реквізити",
      rows: [
        ["Метод", payoutMethod === "card" ? "Картка" : "IBAN"],
        [
          "Номер",
          payoutMethod === "card"
            ? cardNumber.replace(/(\d{4})/g, "$1 ").trim()
            : iban,
        ],
        ["Банк", bankName],
        ["Власник", accountHolder],
      ],
    },
  ];

  return (
    <div className="space-y-6">
      {sections.map((s) => {
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
                  {s.step === "doc"
                    ? "01"
                    : s.step === "selfie"
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
              <Button variant="link" size="sm" onClick={() => onJump(s.step)}>
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

      <div className="border border-hairline rounded-[var(--radius-md)] bg-canvas p-5 flex gap-3">
        <Lock size={16} className="text-success shrink-0 mt-0.5" />
        <p className="text-caption text-ink-soft leading-relaxed">
          Натискаючи «Надіслати на перевірку», ви погоджуєтесь з обробкою
          персональних даних згідно з нашою{" "}
          <Tooltip content="Документ ще в роботі">
            <span className="text-ink underline decoration-1 underline-offset-2 cursor-help">
              Політикою конфіденційності
            </span>
          </Tooltip>
          . Перевірка займе до 24 годин.
        </p>
      </div>

      {!allValid && (
        <InlineAlert tone="warning" title="Деякі кроки потребують уваги">
          Виправте помилки в позначених секціях, щоб надіслати документи.
        </InlineAlert>
      )}
    </div>
  );
}

/* ===========================================================
   Submitted screen
   =========================================================== */
function SubmittedScreen({ onAgain }: { onAgain: () => void }) {
  const [reKycOpen, setReKycOpen] = React.useState(false);

  return (
    <>
      <TopNav />
      <SuccessScreen
        icon={<ShieldCheck size={32} />}
        iconTone="info"
        kicker="Документи надіслано"
        title={
          <>
            На перевірці
            <br />
            <span className="text-ink-soft italic">до 24 годин</span>
          </>
        }
        description="Ми сповістимо вас у чаті та поштою, як тільки буде результат. Поки що ви можете створювати листинги та брати угоди — payout активується після затвердження."
        badge={<KYCStatusBadge status="submitted" />}
        actions={
          <>
            <Button variant="accent" size="lg">
              До кабінету
            </Button>
            <Button variant="secondary" size="lg" onClick={onAgain}>
              Розпочати спочатку
            </Button>
            <Button variant="ghost" size="lg" onClick={() => setReKycOpen(true)}>
              Що з re-KYC?
            </Button>
          </>
        }
        steps={[
          { n: "01", label: "Перевірка документів", hint: "автоматична + ручна", active: true },
          { n: "02", label: "Звірка реквізитів", hint: "співпадіння імені" },
          { n: "03", label: "Активація виплат", hint: "доступ до payout" },
        ]}
      />

      <Modal
        open={reKycOpen}
        onOpenChange={setReKycOpen}
        title="Re-KYC — що це"
        description="Періодична повторна перевірка для активних виконавців."
        size="md"
        footer={
          <Button variant="accent" onClick={() => setReKycOpen(false)}>
            Зрозуміло
          </Button>
        }
      >
        <div className="space-y-3 text-body text-ink-soft leading-relaxed">
          <p>
            Раз на 18 місяців ми просимо повторно завантажити документ. Це
            швидко: документ + селфі, реквізити лишаються.
          </p>
          <p>
            Ми сповістимо за 30 днів до дедлайну. Поки re-KYC не пройдено,
            payout буде поставлений на паузу, угоди — продовжуватимуться.
          </p>
        </div>
      </Modal>

      <Footer />
      <MobileTabBar messagesUnread={6} />
    </>
  );
}
