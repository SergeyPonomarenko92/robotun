"use client";
import * as React from "react";
import {
  AlertTriangle,
  ShieldAlert,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  Send,
  Scale,
  ArrowRight,
  Sparkles,
} from "lucide-react";

import { TopNav } from "@/components/organisms/TopNav";
import { MobileTabBar } from "@/components/organisms/MobileTabBar";
import { Footer } from "@/components/organisms/Footer";
import { DealStateTracker } from "@/components/organisms/DealStateTracker";
import { DisputeBanner } from "@/components/organisms/DisputeBanner";

import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { FormField } from "@/components/ui/FormField";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Tag } from "@/components/ui/Tag";
import { Avatar } from "@/components/ui/Avatar";
import { MoneyDisplay, MoneyInput } from "@/components/ui/MoneyInput";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { Modal } from "@/components/ui/Modal";
import {
  FileUploader,
  type UploadedFile,
} from "@/components/ui/FileUploader";

const USER = {
  id: "u1",
  displayName: "Сергій П.",
  email: "aks74ym@gmail.com",
  kycVerified: true,
  hasProviderRole: true,
};

const DEAL = {
  id: "DL-7398",
  title: "Siemens iQ500 — повторний ремонт пральної машини",
  priceKopecks: 120000,
  client: {
    id: "u-client",
    name: "Ірина Д.",
    avatarUrl: "https://i.pravatar.cc/120?img=49",
  },
  provider: {
    id: "u-provider",
    name: "Bosch Group Service",
    avatarUrl: "https://i.pravatar.cc/120?img=12",
  },
};

type Role = "client" | "provider" | "admin";
type Phase = "opening" | "responding" | "under_review" | "resolved";

const REASONS = [
  { id: "work_not_delivered", label: "Робота не виконана" },
  { id: "work_quality", label: "Низька якість роботи" },
  { id: "scope_mismatch", label: "Не відповідає домовленості" },
  { id: "payment_issue", label: "Питання оплати" },
  { id: "communication_breakdown", label: "Втрачено комунікацію" },
  { id: "other", label: "Інше" },
] as const;
type ReasonId = (typeof REASONS)[number]["id"];

const STATEMENT_MIN = 30;
const STATEMENT_MAX = 4000;

const CLIENT_STATEMENT =
  "Майстер приїхав 28 квітня, замінив підшипники. Через 5 днів машина знову гудить і тече вода. Гарантія на роботу 12 місяців, але майстер не відповідає в чаті 3 дні. Прошу повернення коштів або повторний виїзд за рахунок виконавця.";

const PROVIDER_STATEMENT =
  "Виконав заміну підшипників 28 квітня. У день виїзду перевірив на 3 циклах прання — машина працювала справно. На повторне звернення відповів 6 травня (затримка через хворобу), запропонував безкоштовний повторний виїзд 8 травня — клієнт відмовився. Готовий приїхати ще раз або частково повернути 50% за матеріали. Долучаю фото виконаної роботи та переписку.";

export default function DisputeFlowPage() {
  const [role, setRole] = React.useState<Role>("provider");
  const [phase, setPhase] = React.useState<Phase>("under_review");

  // form state for active party (whichever role is currently filing)
  const [reason, setReason] = React.useState<ReasonId>("work_quality");
  const [statement, setStatement] = React.useState(
    role === "client" ? CLIENT_STATEMENT : PROVIDER_STATEMENT
  );
  const [files, setFiles] = React.useState<UploadedFile[]>([]);
  const [confirmHonest, setConfirmHonest] = React.useState(true);
  const [submitOpen, setSubmitOpen] = React.useState(false);

  // admin resolution state
  const [outcome, setOutcome] = React.useState<
    "release_to_provider" | "refund_to_client" | "split"
  >("split");
  const [splitToProvider, setSplitToProvider] = React.useState<number | null>(60000);

  React.useEffect(() => {
    setStatement(role === "client" ? CLIENT_STATEMENT : PROVIDER_STATEMENT);
  }, [role]);

  // ---------- visibility rule (REQ-006) ----------
  // Counterparty statement hidden until provider responded OR window closed.
  // For demo: phase 'opening' (just opened by client) — provider hasn't responded.
  // phase 'responding' — provider seeing client's statement now (provider opens to write).
  // phase 'under_review' — both visible to admin; for parties: visible since provider responded.
  // phase 'resolved' — everything visible.
  const counterpartyVisible =
    role === "admin" || phase === "under_review" || phase === "resolved" ||
    (role === "provider" && phase === "responding");

  const ownStatementSubmitted =
    (role === "client" && (phase === "responding" || phase === "under_review" || phase === "resolved")) ||
    (role === "provider" && (phase === "under_review" || phase === "resolved"));

  // ---------- form validation ----------
  const errors: string[] = [];
  if (statement.trim().length < STATEMENT_MIN)
    errors.push(`Опишіть позицію — мін. ${STATEMENT_MIN} символів`);
  if (statement.length > STATEMENT_MAX)
    errors.push(`Не більше ${STATEMENT_MAX} символів`);
  if (!confirmHonest) errors.push("Підтвердіть достовірність позиції");
  const valid = errors.length === 0;

  const addFiles = (incoming: File[]) => {
    const uploaded: UploadedFile[] = incoming.map((f, i) => ({
      id: `f-${Date.now()}-${i}`,
      file: f,
      status: "ready",
      progress: 100,
    }));
    setFiles((prev) => [...prev, ...uploaded].slice(0, 5));
  };

  // ---------- copy templates ----------
  const bannerMode =
    phase === "opening"
      ? "client_waiting_response"
      : phase === "responding"
        ? "provider_must_respond"
        : phase === "under_review"
          ? "admin_review"
          : "resolution_published";

  const responseDueAt = "2026-05-13T08:00:00Z";
  const resolveBy = "2026-05-24T08:00:00Z";

  const showFormForActiveParty =
    (role === "client" && phase === "opening") ||
    (role === "provider" && phase === "responding");

  return (
    <>
      <TopNav user={USER} notificationsUnread={3} messagesUnread={12} />

      <main className="mx-auto max-w-7xl px-4 md:px-6 pt-6 md:pt-8 pb-32 md:pb-20">
        <Breadcrumbs
          className="mb-6"
          items={[
            { label: "Угоди", href: "#" },
            { label: DEAL.id, href: "/deal" },
            { label: "Спір" },
          ]}
        />

        {/* Editorial header */}
        <header className="grid grid-cols-12 gap-x-6 gap-y-6 mb-10 md:mb-14 items-end">
          <div className="col-span-12 lg:col-span-8">
            <p className="font-mono text-micro uppercase tracking-[0.22em] text-accent mb-3">
              Спір по угоді {DEAL.id}
            </p>
            <h1 className="font-display text-h1 md:text-display text-ink leading-[0.98] tracking-tight">
              Розгляд спору
              <br />
              <span className="text-ink-soft italic">{DEAL.title}</span>
            </h1>
          </div>
          <aside className="col-span-12 lg:col-span-4 space-y-3">
            <RoleSwitcher value={role} onChange={setRole} />
            <PhaseSwitcher value={phase} onChange={setPhase} />
          </aside>
        </header>

        {/* Banner */}
        <div className="mb-10">
          <DisputeBanner
            mode={bannerMode}
            dueAt={
              phase === "opening" || phase === "responding"
                ? responseDueAt
                : phase === "under_review"
                  ? resolveBy
                  : undefined
            }
            primaryAction={
              showFormForActiveParty ? (
                <Button variant="accent" rightIcon={<Send size={14} />}>
                  Подати відповідь
                </Button>
              ) : undefined
            }
            secondaryAction={
              <Button variant="ghost">Що це означає?</Button>
            }
          />
        </div>

        {/* Deal state tracker */}
        <div className="mb-12">
          <DealStateTracker
            status={phase === "resolved" ? "completed" : "disputed"}
            countdown={
              phase === "responding"
                ? { label: "Провайдер має відповісти", expiresAt: responseDueAt }
                : phase === "under_review"
                  ? { label: "Адмін розглядає", expiresAt: resolveBy }
                  : undefined
            }
          />
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-10 lg:gap-12">
          {/* LEFT: tabs */}
          <section className="min-w-0">
            <Tabs defaultValue="evidence">
              <TabsList>
                <TabsTrigger value="evidence">Докази</TabsTrigger>
                <TabsTrigger value="timeline">Хронологія</TabsTrigger>
                {phase === "resolved" && (
                  <TabsTrigger value="resolution">Рішення</TabsTrigger>
                )}
                {role === "admin" && phase === "under_review" && (
                  <TabsTrigger value="verdict">Винести рішення</TabsTrigger>
                )}
              </TabsList>

              <TabsContent value="evidence">
                <div className="mt-2 space-y-6">
                  {/* Active form OR own submitted */}
                  {showFormForActiveParty && !ownStatementSubmitted ? (
                    <EvidenceForm
                      role={role}
                      reason={reason}
                      setReason={setReason}
                      statement={statement}
                      setStatement={setStatement}
                      files={files}
                      addFiles={addFiles}
                      removeFile={(id) =>
                        setFiles((p) => p.filter((f) => f.id !== id))
                      }
                      confirmHonest={confirmHonest}
                      setConfirmHonest={setConfirmHonest}
                      errors={errors}
                      valid={valid}
                      onSubmit={() => setSubmitOpen(true)}
                    />
                  ) : (
                    <EvidenceCard
                      role={role}
                      partyRole={role === "admin" ? "client" : role}
                      author={role === "client" ? DEAL.client : DEAL.provider}
                      reason={reason}
                      statement={
                        role === "provider" ? PROVIDER_STATEMENT : CLIENT_STATEMENT
                      }
                      submittedAt="2026-05-08T10:30:00Z"
                      isOwn={role !== "admin"}
                    />
                  )}

                  {/* Counterparty card (gated) */}
                  {role !== "admin" ? (
                    counterpartyVisible ? (
                      <EvidenceCard
                        role={role}
                        partyRole={role === "client" ? "provider" : "client"}
                        author={
                          role === "client" ? DEAL.provider : DEAL.client
                        }
                        reason={reason}
                        statement={
                          role === "client"
                            ? PROVIDER_STATEMENT
                            : CLIENT_STATEMENT
                        }
                        submittedAt="2026-05-09T14:12:00Z"
                      />
                    ) : (
                      <HiddenCounterparty />
                    )
                  ) : (
                    /* admin sees both immediately */
                    <EvidenceCard
                      role="admin"
                      partyRole="provider"
                      author={DEAL.provider}
                      reason="work_quality"
                      statement={PROVIDER_STATEMENT}
                      submittedAt="2026-05-09T14:12:00Z"
                    />
                  )}
                </div>
              </TabsContent>

              <TabsContent value="timeline">
                <Timeline phase={phase} />
              </TabsContent>

              {phase === "resolved" && (
                <TabsContent value="resolution">
                  <ResolutionCard role={role} />
                </TabsContent>
              )}

              {role === "admin" && phase === "under_review" && (
                <TabsContent value="verdict">
                  <AdminVerdict
                    outcome={outcome}
                    setOutcome={setOutcome}
                    splitToProvider={splitToProvider}
                    setSplitToProvider={setSplitToProvider}
                    onPublish={() => setPhase("resolved")}
                  />
                </TabsContent>
              )}
            </Tabs>
          </section>

          {/* RIGHT: rail */}
          <aside className="space-y-4 lg:sticky lg:top-24 self-start">
            {/* Deal summary */}
            <article className="border border-hairline rounded-[var(--radius-md)] bg-paper p-5">
              <p className="font-mono text-micro uppercase tracking-[0.22em] text-muted mb-2">
                Угода
              </p>
              <p className="font-display text-body-lg text-ink leading-tight">
                {DEAL.title}
              </p>
              <div className="mt-3 flex items-baseline gap-1">
                <MoneyDisplay
                  kopecks={DEAL.priceKopecks}
                  emphasize
                  className="font-display text-h2 text-ink leading-none"
                />
                <span className="text-caption text-muted ml-1">в холді</span>
              </div>
              <ul className="mt-4 space-y-2">
                <li className="flex items-center gap-3 text-caption">
                  <Avatar
                    src={DEAL.client.avatarUrl}
                    alt={DEAL.client.name}
                    size="xs"
                  />
                  <span className="text-muted">Клієнт</span>
                  <span className="ml-auto text-ink">{DEAL.client.name}</span>
                </li>
                <li className="flex items-center gap-3 text-caption">
                  <Avatar
                    src={DEAL.provider.avatarUrl}
                    alt={DEAL.provider.name}
                    size="xs"
                  />
                  <span className="text-muted">Виконавець</span>
                  <span className="ml-auto text-ink truncate">
                    {DEAL.provider.name}
                  </span>
                </li>
              </ul>
            </article>

            {/* Visibility / SLA explainer */}
            <article className="border border-hairline rounded-[var(--radius-md)] bg-canvas p-5">
              <p className="font-mono text-micro uppercase tracking-[0.22em] text-accent mb-2">
                Як це працює
              </p>
              <ul className="text-caption text-ink-soft space-y-2 leading-relaxed">
                <li className="flex gap-2">
                  <span className="font-mono text-muted">01</span>
                  Клієнт і виконавець подають свої позиції.
                </li>
                <li className="flex gap-2">
                  <span className="font-mono text-muted">02</span>
                  Контр-сторона стає видимою після відповіді або 3-х днів.
                </li>
                <li className="flex gap-2">
                  <span className="font-mono text-muted">03</span>
                  Адмін виносить рішення протягом 14 днів.
                </li>
                <li className="flex gap-2">
                  <span className="font-mono text-muted">04</span>
                  Усі повідомлення в чаті — видимі модератору.
                </li>
              </ul>
            </article>

            <article className="border border-hairline rounded-[var(--radius-md)] bg-canvas p-4 flex gap-3">
              <Sparkles size={16} className="text-accent shrink-0 mt-0.5" />
              <p className="text-caption text-ink-soft leading-relaxed">
                Чесні позиції з фото / переписками вирішуються швидше.
                Емоції — ні.
              </p>
            </article>
          </aside>
        </div>
      </main>

      {/* Confirm submit modal */}
      <Modal
        open={submitOpen}
        onOpenChange={setSubmitOpen}
        title="Подати позицію?"
        description="Після подання редагувати не можна — лише одна спроба."
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setSubmitOpen(false)}>
              Назад
            </Button>
            <Button
              variant="accent"
              rightIcon={<CheckCircle2 size={16} />}
              onClick={() => {
                setSubmitOpen(false);
                if (role === "client") setPhase("responding");
                else if (role === "provider") setPhase("under_review");
              }}
            >
              Так, подати
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-body text-ink-soft leading-relaxed">
          <p>
            Ваша позиція буде передана адміністратору і{" "}
            {role === "client"
              ? "виконавцю після його відповіді або через 3 дні"
              : "клієнту відразу"}
            .
          </p>
          <div className="border border-warning rounded-[var(--radius-sm)] bg-warning-soft p-4 flex gap-3">
            <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
            <p className="text-caption text-ink-soft">
              Замінити заяву та докази буде неможливо. Уточнення можна
              надсилати в чаті — вони видимі модератору.
            </p>
          </div>
        </div>
      </Modal>

      <Footer />
      <MobileTabBar messagesUnread={12} />
    </>
  );
}

/* ===========================================================
   Role / Phase switchers (demo controls)
   =========================================================== */

function RoleSwitcher({
  value,
  onChange,
}: {
  value: Role;
  onChange: (r: Role) => void;
}) {
  return (
    <div>
      <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted block mb-1">
        Точка зору
      </span>
      <div
        role="tablist"
        className="inline-flex border border-hairline rounded-[var(--radius-pill)] bg-paper p-1"
      >
        {(["client", "provider", "admin"] as Role[]).map((r) => (
          <button
            key={r}
            type="button"
            role="tab"
            aria-selected={value === r}
            onClick={() => onChange(r)}
            className={[
              "px-3 h-7 rounded-[var(--radius-pill)] text-caption transition-colors",
              value === r ? "bg-ink text-paper" : "text-muted hover:text-ink",
            ].join(" ")}
          >
            {r === "client" ? "Клієнт" : r === "provider" ? "Виконавець" : "Адмін"}
          </button>
        ))}
      </div>
    </div>
  );
}

function PhaseSwitcher({
  value,
  onChange,
}: {
  value: Phase;
  onChange: (p: Phase) => void;
}) {
  return (
    <div>
      <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted block mb-1">
        Фаза спору
      </span>
      <div className="flex flex-wrap gap-1">
        {(
          [
            { id: "opening", l: "Відкриття" },
            { id: "responding", l: "Відповідь" },
            { id: "under_review", l: "Розгляд" },
            { id: "resolved", l: "Винесено" },
          ] as { id: Phase; l: string }[]
        ).map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            className={[
              "px-2.5 h-7 rounded-[var(--radius-sm)] text-caption border transition-colors",
              value === p.id
                ? "border-ink bg-ink text-paper"
                : "border-hairline bg-paper text-muted hover:text-ink",
            ].join(" ")}
          >
            {p.l}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ===========================================================
   Evidence form (active party)
   =========================================================== */
function EvidenceForm({
  role,
  reason,
  setReason,
  statement,
  setStatement,
  files,
  addFiles,
  removeFile,
  confirmHonest,
  setConfirmHonest,
  errors,
  valid,
  onSubmit,
}: {
  role: Role;
  reason: ReasonId;
  setReason: (r: ReasonId) => void;
  statement: string;
  setStatement: (s: string) => void;
  files: UploadedFile[];
  addFiles: (f: File[]) => void;
  removeFile: (id: string) => void;
  confirmHonest: boolean;
  setConfirmHonest: (v: boolean) => void;
  errors: string[];
  valid: boolean;
  onSubmit: () => void;
}) {
  return (
    <article className="border border-hairline rounded-[var(--radius-md)] bg-paper">
      <header className="px-6 py-4 border-b border-hairline flex items-center gap-3">
        <span className="font-mono text-micro uppercase tracking-[0.22em] text-accent">
          Ваша позиція
        </span>
        <h3 className="font-display text-h3 text-ink leading-none">
          {role === "client" ? "Опишіть проблему" : "Подайте відповідь"}
        </h3>
        <Badge tone="warning" size="sm" shape="square" className="ml-auto">
          одна спроба
        </Badge>
      </header>

      <div className="p-6 space-y-6">
        {role === "client" && (
          <FormField label="Причина спору" required>
            <div className="flex flex-wrap gap-2">
              {REASONS.map((r) => (
                <Tag
                  key={r.id}
                  variant="soft"
                  interactive
                  selected={reason === r.id}
                  onClick={() => setReason(r.id)}
                >
                  {r.label}
                </Tag>
              ))}
            </div>
          </FormField>
        )}

        <FormField
          label={role === "client" ? "Деталі" : "Ваша версія подій"}
          required
          helper="Конкретні факти, дати, посилання на чат. Без емоцій — це адмін все одно прочитає."
          charCount={{ current: statement.length, max: STATEMENT_MAX }}
        >
          <textarea
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            maxLength={STATEMENT_MAX}
            rows={8}
            className="w-full rounded-[var(--radius-sm)] border border-hairline-strong bg-paper px-3 py-2.5 text-body text-ink placeholder:text-muted-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink resize-y"
            placeholder="30–4000 символів"
          />
        </FormField>

        <FormField
          label="Файли (опціонально)"
          hint="фото, скріни чату, інвойс — до 5 файлів, max 10 МБ"
        >
          <FileUploader
            accept="image/jpeg,image/png,image/webp,application/pdf"
            multiple
            maxFiles={5}
            maxSizeBytes={10 * 1024 * 1024}
            files={files}
            onFilesAdd={addFiles}
            onRemove={removeFile}
          />
        </FormField>

        <label className="flex items-start gap-4 border border-hairline rounded-[var(--radius-md)] bg-canvas p-4 cursor-pointer">
          <input
            type="checkbox"
            checked={confirmHonest}
            onChange={(e) => setConfirmHonest(e.target.checked)}
            className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span className="min-w-0">
            <span className="block font-display text-body-lg text-ink leading-tight">
              Підтверджую достовірність позиції
            </span>
            <span className="block text-caption text-muted mt-1 leading-relaxed">
              Подача неправдивих даних — підстава для блокування акаунту і
              може мати юридичні наслідки.
            </span>
          </span>
        </label>

        {errors.length > 0 && (
          <InlineAlert tone="warning" title="Перевірте поля">
            <ul className="list-disc ml-4 space-y-0.5">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </InlineAlert>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost">Зберегти чернетку</Button>
          <Button
            variant="accent"
            rightIcon={<Send size={14} />}
            disabled={!valid}
            onClick={onSubmit}
          >
            Подати позицію
          </Button>
        </div>
      </div>
    </article>
  );
}

/* ===========================================================
   Evidence card (submitted)
   =========================================================== */
function EvidenceCard({
  role,
  partyRole,
  author,
  reason,
  statement,
  submittedAt,
  isOwn,
}: {
  role: Role;
  partyRole: "client" | "provider";
  author: { name: string; avatarUrl?: string };
  reason: ReasonId | string;
  statement: string;
  submittedAt: string;
  isOwn?: boolean;
}) {
  void role;
  const reasonLabel =
    REASONS.find((r) => r.id === reason)?.label || "Без вказаної причини";
  return (
    <article className="border border-hairline rounded-[var(--radius-md)] bg-paper">
      <header className="px-6 py-4 border-b border-hairline flex items-center gap-3 flex-wrap">
        <Avatar src={author.avatarUrl} alt={author.name} size="sm" />
        <div className="min-w-0">
          <p className="font-display text-body-lg text-ink leading-tight">
            {author.name}
          </p>
          <p className="text-caption text-muted">
            {partyRole === "client" ? "Клієнт" : "Виконавець"} · подано{" "}
            {fmtDate(submittedAt)}
          </p>
        </div>
        {isOwn && (
          <Badge tone="ink" size="sm" shape="square" className="ml-auto">
            ваша позиція
          </Badge>
        )}
        {!isOwn && (
          <Badge tone="neutral" size="sm" shape="square" className="ml-auto">
            контрсторона
          </Badge>
        )}
      </header>

      <div className="p-6 space-y-4">
        {partyRole === "client" && (
          <div>
            <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted mb-1">
              Причина
            </p>
            <p className="font-display text-body-lg text-ink">{reasonLabel}</p>
          </div>
        )}
        <div>
          <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted mb-2">
            Заява
          </p>
          <p className="text-body text-ink-soft leading-relaxed whitespace-pre-line">
            {statement}
          </p>
        </div>

        <div>
          <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted mb-2">
            Докази (3)
          </p>
          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="aspect-[4/3] rounded-[var(--radius-sm)] bg-cover bg-center border border-hairline"
                style={{
                  backgroundImage: `url(https://picsum.photos/seed/ev-${partyRole}-${i}/300/200)`,
                }}
                aria-label={`Доказ ${i}`}
                role="img"
              />
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}

/* ===========================================================
   Hidden counterparty placeholder
   =========================================================== */
function HiddenCounterparty() {
  return (
    <article className="border border-dashed border-hairline-strong rounded-[var(--radius-md)] bg-canvas p-8 text-center">
      <span
        className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-paper border border-hairline mb-4"
        aria-hidden
      >
        <EyeOff size={20} className="text-muted" />
      </span>
      <h3 className="font-display text-h3 text-ink leading-tight">
        Позиція контр-сторони ще не доступна
      </h3>
      <p className="mt-2 text-caption text-muted leading-relaxed max-w-md mx-auto">
        Ви побачите її, як тільки виконавець подасть відповідь або через
        3&nbsp;дні з моменту відкриття спору. Це чесно для обох сторін — ми не
        даємо однієї стороні переписувати позицію під аргументи іншої.
      </p>
      <div className="mt-4 inline-flex items-center gap-2 font-mono text-micro uppercase tracking-[0.18em] text-muted">
        <Clock size={12} />
        <span>залишилось ~2 дні 18 год</span>
      </div>
    </article>
  );
}

/* ===========================================================
   Timeline
   =========================================================== */
function Timeline({ phase }: { phase: Phase }) {
  const events = [
    { at: "2026-05-08 10:30", label: "Клієнт відкрив спір", on: true },
    { at: "2026-05-08 10:32", label: "Чат позначено admin_visible", on: true },
    {
      at: "2026-05-09 14:12",
      label: "Виконавець подав відповідь",
      on: phase !== "opening",
    },
    {
      at: "2026-05-09 14:13",
      label: "Адмін отримав справу на розгляд",
      on: phase === "under_review" || phase === "resolved",
    },
    {
      at: "2026-05-10 09:00",
      label: "Рішення винесено",
      on: phase === "resolved",
    },
  ];

  return (
    <ol className="mt-4 border border-hairline rounded-[var(--radius-md)] bg-paper">
      {events.map((e, i) => (
        <li
          key={i}
          className={[
            "px-5 py-4 flex items-start gap-4 border-b border-hairline last:border-b-0",
            e.on ? "" : "opacity-50",
          ].join(" ")}
        >
          <span
            className={[
              "h-7 w-7 rounded-full inline-flex items-center justify-center border-2 shrink-0 mt-0.5",
              e.on
                ? "border-ink bg-ink text-paper"
                : "border-hairline-strong bg-paper text-muted",
            ].join(" ")}
            aria-hidden
          >
            {e.on ? <CheckCircle2 size={14} /> : <Clock size={14} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-display text-body-lg text-ink leading-tight">
              {e.label}
            </p>
            <p className="font-mono text-caption text-muted mt-0.5">{e.at}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ===========================================================
   Admin verdict
   =========================================================== */
function AdminVerdict({
  outcome,
  setOutcome,
  splitToProvider,
  setSplitToProvider,
  onPublish,
}: {
  outcome: "release_to_provider" | "refund_to_client" | "split";
  setOutcome: (o: "release_to_provider" | "refund_to_client" | "split") => void;
  splitToProvider: number | null;
  setSplitToProvider: (v: number | null) => void;
  onPublish: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const total = DEAL.priceKopecks;
  const toClient =
    outcome === "refund_to_client"
      ? total
      : outcome === "release_to_provider"
        ? 0
        : Math.max(0, total - (splitToProvider ?? 0));
  const toProvider =
    outcome === "release_to_provider"
      ? total
      : outcome === "refund_to_client"
        ? 0
        : (splitToProvider ?? 0);

  return (
    <div className="mt-2 space-y-6">
      <article className="border border-hairline rounded-[var(--radius-md)] bg-paper p-6">
        <div className="flex items-center gap-3 mb-5">
          <span className="font-mono text-micro uppercase tracking-[0.22em] text-accent">
            Рішення
          </span>
          <h3 className="font-display text-h2 text-ink leading-none tracking-tight">
            Винести вердикт
          </h3>
          <Scale size={18} className="text-muted ml-auto" />
        </div>

        <FormField label="Тип рішення" required>
          <div role="radiogroup" className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {(
              [
                {
                  id: "release_to_provider" as const,
                  label: "На користь виконавця",
                  hint: "Кошти повністю → виконавцю",
                },
                {
                  id: "split" as const,
                  label: "Розділити",
                  hint: "Часткова виплата кожному",
                },
                {
                  id: "refund_to_client" as const,
                  label: "На користь клієнта",
                  hint: "Кошти повністю → клієнту",
                },
              ]
            ).map((o) => {
              const active = outcome === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setOutcome(o.id)}
                  className={[
                    "text-left rounded-[var(--radius-md)] border px-4 py-4 transition-all",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
                    active
                      ? "border-ink bg-ink text-paper"
                      : "border-hairline bg-paper text-ink hover:border-ink",
                  ].join(" ")}
                >
                  <span className="font-display text-body-lg leading-none block">
                    {o.label}
                  </span>
                  <span
                    className={[
                      "mt-2 block text-caption leading-snug",
                      active ? "text-paper/75" : "text-muted",
                    ].join(" ")}
                  >
                    {o.hint}
                  </span>
                </button>
              );
            })}
          </div>
        </FormField>

        {outcome === "split" && (
          <div className="mt-6">
            <FormField
              label="Сума виконавцю"
              required
              helper={`Решта (${(((total - (splitToProvider ?? 0)) / 100)).toLocaleString("uk-UA")} ₴) повертається клієнту.`}
            >
              <MoneyInput
                valueKopecks={splitToProvider}
                onChangeKopecks={setSplitToProvider}
                minKopecks={0}
                maxKopecks={total}
                size="lg"
              />
            </FormField>
          </div>
        )}

        <div className="mt-6 grid grid-cols-2 gap-3">
          <div className="border border-hairline rounded-[var(--radius-sm)] bg-canvas p-4">
            <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
              Клієнту
            </p>
            <MoneyDisplay
              kopecks={toClient}
              emphasize
              className="font-display text-h2 text-ink leading-none tracking-tight mt-1"
            />
          </div>
          <div className="border border-hairline rounded-[var(--radius-sm)] bg-canvas p-4">
            <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
              Виконавцю
            </p>
            <MoneyDisplay
              kopecks={toProvider}
              emphasize
              className="font-display text-h2 text-ink leading-none tracking-tight mt-1"
            />
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button variant="ghost">Зберегти чернетку</Button>
          <Button
            variant="accent"
            rightIcon={<ShieldAlert size={14} />}
            onClick={() => setConfirmOpen(true)}
          >
            Опублікувати рішення
          </Button>
        </div>
      </article>

      <Modal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Опублікувати рішення?"
        description="Рішення остаточне — переглянути не можна."
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
                onPublish();
              }}
            >
              Опублікувати
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-body text-ink-soft leading-relaxed">
          <p>
            Обидві сторони отримають рішення в чаті, поштою та push. Кошти
            будуть переведені негайно.
          </p>
          <div className="border border-warning rounded-[var(--radius-sm)] bg-warning-soft p-4 flex gap-3">
            <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
            <p className="text-caption text-ink-soft">
              Apel'яції MVP не передбачає. Помилка в рішенні виправляється
              лише через службу підтримки з MFA challenge.
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/* ===========================================================
   Resolution card (resolved phase)
   =========================================================== */
function ResolutionCard({ role }: { role: Role }) {
  const toClient = 60000;
  const toProvider = 60000;
  const winnerForRole =
    role === "client"
      ? toClient > toProvider
      : role === "provider"
        ? toProvider > toClient
        : null;

  return (
    <div className="mt-2 space-y-6">
      <article className="border-2 border-success rounded-[var(--radius-md)] bg-success-soft p-6">
        <div className="flex items-center gap-3 mb-3">
          <span
            className="h-10 w-10 inline-flex items-center justify-center rounded-full bg-paper text-success"
            aria-hidden
          >
            <ShieldAlert size={20} />
          </span>
          <div>
            <p className="font-mono text-micro uppercase tracking-[0.22em] text-success">
              Рішення винесено
            </p>
            <h3 className="font-display text-h2 text-ink leading-tight tracking-tight">
              {winnerForRole === null
                ? "Розділ навпіл"
                : winnerForRole
                  ? "Часткова виплата на вашу користь"
                  : "Часткова виплата на користь контр-сторони"}
            </h3>
          </div>
        </div>
        <p className="text-body text-ink-soft leading-relaxed">
          Адмін розглянув обидві позиції і вирішив розділити суму:{" "}
          600&nbsp;₴ — клієнту, 600&nbsp;₴ — виконавцю. Підстава: підтверджена
          часткова робота з позиції виконавця, але невирішений рецидив поломки
          з позиції клієнта.
        </p>
      </article>

      <div className="grid grid-cols-2 gap-3">
        <div className="border border-hairline rounded-[var(--radius-md)] bg-paper p-5">
          <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
            Клієнту повернено
          </p>
          <MoneyDisplay
            kopecks={toClient}
            emphasize
            className="font-display text-h1 text-ink leading-none tracking-tight mt-2"
          />
          <p className="mt-2 text-caption text-success inline-flex items-center gap-1">
            <CheckCircle2 size={12} />
            переказ виконано
          </p>
        </div>
        <div className="border border-hairline rounded-[var(--radius-md)] bg-paper p-5">
          <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
            Виконавцю
          </p>
          <MoneyDisplay
            kopecks={toProvider}
            emphasize
            className="font-display text-h1 text-ink leading-none tracking-tight mt-2"
          />
          <p className="mt-2 text-caption text-success inline-flex items-center gap-1">
            <CheckCircle2 size={12} />
            нараховано в гаманець
          </p>
        </div>
      </div>

      <article className="border border-hairline rounded-[var(--radius-md)] bg-paper p-5 flex items-start gap-3">
        <Eye size={16} className="text-accent shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="font-display text-body-lg text-ink leading-tight">
            Рішення остаточне
          </p>
          <p className="text-caption text-muted mt-1 leading-relaxed">
            Apel'яції MVP не передбачає. У разі PSP-chargeback справа автоматично
            відкриється повторно у Платіжному модулі, без впливу на цей вердикт.
          </p>
        </div>
      </article>

      <div className="flex justify-end">
        <Button variant="link" rightIcon={<ArrowRight size={14} />}>
          Залишити відгук
        </Button>
      </div>
    </div>
  );
}

/* ===========================================================
   utils
   =========================================================== */
function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("uk-UA", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}
