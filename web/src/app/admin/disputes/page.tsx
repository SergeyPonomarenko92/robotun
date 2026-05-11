"use client";
import * as React from "react";
import { Gavel, Loader2, ShieldCheck, ScrollText, ArrowRight } from "lucide-react";

import { TopNav } from "@/components/organisms/TopNav";
import { Footer } from "@/components/organisms/Footer";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { ErrorState } from "@/components/ui/ErrorState";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { MoneyDisplay } from "@/components/ui/MoneyInput";
import { EditorialPageHeader } from "@/components/organisms/EditorialPageHeader";

import { useRequireAuth } from "@/lib/auth";
import { useRouter } from "next/navigation";
import {
  useDisputedDeals,
  resolveDispute,
  type Deal,
  type DisputeReason,
} from "@/lib/deals";

const REASON_LABELS: Record<DisputeReason, string> = {
  not_delivered: "Послугу не надано",
  partial_work: "Виконано частково",
  wrong_quality: "Якість не відповідає опису",
  out_of_scope: "Виконано не те, що домовлялись",
  client_withdrew: "Клієнт відмовився прийняти",
  other: "Інше",
};

export default function AdminDisputesPage() {
  const auth = useRequireAuth("/login");
  const router = useRouter();
  const queue = useDisputedDeals();
  const [active, setActive] = React.useState<Deal | null>(null);

  // Hard gate: not admin → bounce to home with an inline note (router.replace
  // happens after first render so the gate effect is fine here too).
  React.useEffect(() => {
    if (auth && !auth.user.roles.includes("admin")) {
      router.replace("/");
    }
  }, [auth, router]);

  if (!auth || (auth && !auth.user.roles.includes("admin"))) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-muted" />
      </main>
    );
  }

  return (
    <>
      <TopNav
        user={{
          id: auth.user.id,
          displayName: auth.user.display_name,
          email: auth.user.email,
          kycVerified: false,
          hasProviderRole: false,
        }}
      />
      <main className="mx-auto max-w-6xl px-4 md:px-6 pt-6 md:pt-10 pb-20">
        <EditorialPageHeader
          kicker="Module 14 · admin"
          title={
            <>
              Черга
              <br />
              <span className="text-accent italic">диспутів</span>
            </>
          }
          description={
            queue.loading
              ? "Завантажуємо актуальний список…"
              : queue.total === 0
                ? "Зараз диспутів немає — все спокійно."
                : `Активних: ${queue.total}. Розгляд завершує угоду і визначає, куди йдуть кошти.`
          }
          sidecar={
            <Badge tone="danger" size="sm" shape="square">
              admin · MFA очікується у проді
            </Badge>
          }
        />

        {queue.error && (
          <div className="mb-6">
            <ErrorState
              kind="server"
              variant="inline"
              description="Не вдалось завантажити чергу диспутів."
              onRetry={queue.refresh}
            />
          </div>
        )}

        {queue.loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[160px] border border-hairline rounded-[var(--radius-md)] bg-paper animate-pulse"
              />
            ))}
          </div>
        ) : queue.items.length === 0 ? (
          <div className="border border-hairline rounded-[var(--radius-md)] bg-paper p-10 text-center">
            <Gavel size={28} className="mx-auto text-muted mb-3" />
            <p className="font-display text-h3 text-ink tracking-tight">
              Черга порожня
            </p>
            <p className="text-body text-muted mt-2">
              Нові диспути зʼявляться, як тільки клієнт натисне «Відкрити диспут».
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {queue.items.map((d) => (
              <DisputeQueueRow key={d.id} deal={d} onOpen={() => setActive(d)} />
            ))}
          </div>
        )}
      </main>

      {active && (
        <ResolveModal
          deal={active}
          onClose={() => setActive(null)}
          onResolved={() => {
            setActive(null);
            queue.refresh();
          }}
        />
      )}

      <Footer />
    </>
  );
}

function DisputeQueueRow({
  deal,
  onOpen,
}: {
  deal: Deal;
  onOpen: () => void;
}) {
  const both = !!deal.dispute_evidence_client && !!deal.dispute_evidence_provider;
  return (
    <article className="border border-hairline rounded-[var(--radius-md)] bg-paper p-5 md:p-6">
      <div className="flex flex-wrap items-baseline gap-3 mb-3">
        <span className="font-mono text-micro tracking-[0.18em] text-muted">
          {deal.id.slice(0, 8).toUpperCase()}
        </span>
        <Badge tone="danger" size="sm" shape="square">
          диспут
        </Badge>
        {both ? (
          <Badge tone="success" size="sm" shape="square">
            обидві сторони висловились
          </Badge>
        ) : (
          <Badge tone="warning" size="sm" shape="square">
            очікуємо свідчень
          </Badge>
        )}
        <span className="ml-auto font-display text-h3 text-ink font-mono tabular-nums">
          <MoneyDisplay kopecks={deal.budget_kopecks} />
        </span>
      </div>
      <h2 className="font-display text-body-lg text-ink leading-snug">
        {deal.listing_title_snapshot}
      </h2>
      <p className="text-caption text-muted mt-1">
        {deal.client.display_name} ↔ {deal.provider.display_name}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
        <PartyEvidencePreview
          label="Клієнт"
          who={deal.client.display_name}
          ev={deal.dispute_evidence_client}
        />
        <PartyEvidencePreview
          label="Виконавець"
          who={deal.provider.display_name}
          ev={deal.dispute_evidence_provider}
        />
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-hairline pt-4">
        <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted-soft">
          Disputed since {new Date(deal.created_at).toLocaleDateString("uk-UA")}
        </span>
        <Button
          variant="accent"
          size="sm"
          rightIcon={<ArrowRight size={14} />}
          onClick={onOpen}
        >
          Винести рішення
        </Button>
      </div>
    </article>
  );
}

function PartyEvidencePreview({
  label,
  who,
  ev,
}: {
  label: string;
  who: string;
  ev: Deal["dispute_evidence_client"];
}) {
  return (
    <div className="border border-hairline rounded-[var(--radius-sm)] bg-canvas p-4 min-h-[120px]">
      <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted mb-1">
        {label} · {who}
      </p>
      {ev ? (
        <>
          <p className="text-caption text-ink-soft font-medium">
            {REASON_LABELS[ev.reason]}
          </p>
          <p className="mt-2 text-body text-ink-soft leading-relaxed line-clamp-4">
            {ev.statement}
          </p>
        </>
      ) : (
        <p className="text-caption text-muted leading-relaxed">
          Ще не надав свідчень.
        </p>
      )}
    </div>
  );
}

function ResolveModal({
  deal,
  onClose,
  onResolved,
}: {
  deal: Deal;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [verdict, setVerdict] = React.useState<"refund_client" | "release_to_provider">(
    "release_to_provider"
  );
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const submit = async () => {
    if (busy || reason.trim().length < 10) return;
    setBusy(true);
    setErr(null);
    const result = await resolveDispute(deal.id, { verdict, reason });
    setBusy(false);
    if (result.ok) {
      onResolved();
    } else {
      setErr(result.error.message);
    }
  };

  return (
    <Modal
      open={true}
      onOpenChange={(open) => !open && onClose()}
      title="Винести рішення по диспуту"
      description={`Угода ${deal.id.slice(0, 8).toUpperCase()} · ${deal.listing_title_snapshot}`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Назад
          </Button>
          <Button
            variant={verdict === "refund_client" ? "danger" : "accent"}
            loading={busy}
            onClick={submit}
            disabled={reason.trim().length < 10}
          >
            {verdict === "refund_client"
              ? "Підтвердити повернення клієнту"
              : "Підтвердити виплату виконавцю"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => setVerdict("release_to_provider")}
            className={[
              "text-left border rounded-[var(--radius-sm)] p-4 transition-colors",
              verdict === "release_to_provider"
                ? "border-accent bg-accent-soft/40"
                : "border-hairline bg-canvas hover:border-hairline-strong",
            ].join(" ")}
          >
            <div className="flex items-center gap-2 mb-1">
              <ShieldCheck size={14} className="text-success" />
              <span className="font-display text-body-lg text-ink leading-none">
                Виплата виконавцю
              </span>
            </div>
            <p className="text-caption text-muted leading-relaxed">
              Угода переходить у «завершено». Виконавець отримує{" "}
              <MoneyDisplay kopecks={Math.round(deal.budget_kopecks * 0.95)} /> на available.
            </p>
          </button>
          <button
            type="button"
            onClick={() => setVerdict("refund_client")}
            className={[
              "text-left border rounded-[var(--radius-sm)] p-4 transition-colors",
              verdict === "refund_client"
                ? "border-danger bg-danger-soft/40"
                : "border-hairline bg-canvas hover:border-hairline-strong",
            ].join(" ")}
          >
            <div className="flex items-center gap-2 mb-1">
              <ScrollText size={14} className="text-danger" />
              <span className="font-display text-body-lg text-ink leading-none">
                Повернення клієнту
              </span>
            </div>
            <p className="text-caption text-muted leading-relaxed">
              Угода переходить у «скасовано». Кошти повертаються клієнту, виконавцю — нуль.
            </p>
          </button>
        </div>

        <label className="block">
          <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
            Обґрунтування рішення (мін. 10 символів)
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            placeholder="Коротко: чому саме таке рішення, на що спирались — буде в audit log."
            className="mt-2 w-full rounded-[var(--radius-sm)] border border-hairline bg-paper px-3 py-2 text-body text-ink resize-none focus:outline-none focus:border-accent placeholder:text-muted-soft"
          />
        </label>

        {err && <InlineAlert tone="danger" title="Не вдалось закрити диспут">{err}</InlineAlert>}

        <p className="text-caption text-muted-soft leading-relaxed">
          У проді тут вимагається MFA challenge (Module 12 §SEC-006). Мок пропускає цей крок.
        </p>
      </div>
    </Modal>
  );
}
