"use client";
import * as React from "react";
import Link from "next/link";
import {
  Search,
  Loader2,
  AlertTriangle,
  Archive,
  RotateCcw,
  ExternalLink,
} from "lucide-react";

import { AdminShell } from "@/components/organisms/AdminShell";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { MoneyDisplay } from "@/components/ui/MoneyInput";
import {
  useAdminListings,
  archiveListingApi,
  reinstateListingApi,
  type AdminListingRow,
  type AdminListingsFilter,
} from "@/lib/admin-listings";

const FILTERS: { id: AdminListingsFilter; label: string }[] = [
  { id: "active", label: "Активні" },
  { id: "archived", label: "Архівовані" },
  { id: "all", label: "Усі" },
];

export default function AdminListingsPage() {
  const [filter, setFilter] = React.useState<AdminListingsFilter>("active");
  const [qInput, setQInput] = React.useState("");
  const [q, setQ] = React.useState("");
  const [target, setTarget] = React.useState<AdminListingRow | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 250);
    return () => clearTimeout(t);
  }, [qInput]);

  const { items, error, refresh } = useAdminListings(filter, q);

  return (
    <AdminShell
      kicker="Адмін · Лоти"
      title={
        <>
          Модерація
          <br />
          <span className="text-ink-soft italic">оголошень</span>
        </>
      }
      description="Архівування та поновлення лотів. Дії журналяться у admin_actions."
    >
      <section className="mt-6 space-y-5">
        {/* Search */}
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
            aria-hidden
          />
          <Input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Пошук по назві або імені виконавця"
            className="pl-9"
            aria-label="Пошук лотів"
          />
        </div>

        {/* Status filter chips */}
        <div className="flex items-center gap-2">
          <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
            Статус:
          </span>
          {FILTERS.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setFilter(o.id)}
              aria-pressed={filter === o.id}
              className={
                "px-2.5 py-1 rounded-[var(--radius-pill)] text-caption transition-colors duration-[var(--duration-fast)] " +
                (filter === o.id
                  ? "bg-ink text-paper"
                  : "bg-paper text-ink-soft border border-hairline hover:text-ink hover:border-hairline-strong")
              }
            >
              {o.label}
            </button>
          ))}
        </div>

        {/* Results */}
        <ListingsTable
          items={items}
          error={error}
          onAction={(row) => setTarget(row)}
        />
      </section>

      {target && (
        <ModerationModal
          row={target}
          onClose={() => setTarget(null)}
          onDone={() => {
            setTarget(null);
            refresh();
          }}
        />
      )}
    </AdminShell>
  );
}

function ListingsTable({
  items,
  error,
  onAction,
}: {
  items: ReturnType<typeof useAdminListings>["items"];
  error: ReturnType<typeof useAdminListings>["error"];
  onAction: (row: AdminListingRow) => void;
}) {
  if (error) {
    return (
      <div className="border border-danger rounded-[var(--radius-md)] bg-danger-soft p-5 flex items-start gap-3">
        <AlertTriangle size={16} className="text-danger mt-0.5" aria-hidden />
        <div>
          <div className="text-body text-ink">Не вдалось завантажити список</div>
          <div className="text-caption text-muted mt-1">{error}</div>
        </div>
      </div>
    );
  }
  if (items === null) {
    return (
      <div className="border border-hairline rounded-[var(--radius-md)] bg-paper h-40 flex items-center justify-center">
        <Loader2 size={18} className="animate-spin text-muted" aria-hidden />
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="border border-hairline rounded-[var(--radius-md)] bg-paper p-8 text-center">
        <div className="text-body text-ink">Нічого не знайдено</div>
        <div className="text-caption text-muted mt-1">
          Спробуйте змінити запит або фільтр
        </div>
      </div>
    );
  }
  return (
    <div className="border border-hairline rounded-[var(--radius-md)] bg-paper overflow-hidden">
      <ul className="divide-y divide-hairline">
        {items.map((l) => (
          <li
            key={l.id}
            className="flex items-center gap-4 px-5 py-3.5 min-w-0"
          >
            <div className="shrink-0 w-12 h-12 rounded-[var(--radius-sm)] overflow-hidden bg-canvas border border-hairline">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={l.cover_url}
                alt=""
                className="w-full h-full object-cover"
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-body text-ink truncate">{l.title}</span>
                {l.archived && (
                  <Badge tone="danger" size="sm" shape="square">
                    Архівовано
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 text-caption text-muted mt-0.5 min-w-0">
                <Avatar
                  src={l.provider.avatar_url}
                  alt={l.provider.name}
                  size="xs"
                />
                <span className="truncate">{l.provider.name}</span>
                <span className="text-muted-soft">·</span>
                <span>{l.city}</span>
                <span className="text-muted-soft">·</span>
                <span>{l.category}</span>
              </div>
            </div>
            <div className="hidden md:flex flex-col items-end shrink-0 text-caption text-ink-soft">
              <MoneyDisplay kopecks={l.price_from_kopecks} />
              <span className="text-muted">{l.price_unit}</span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Link
                href={`/listings/${l.id}`}
                target="_blank"
                aria-label={`Відкрити лот ${l.title}`}
                className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-muted hover:text-ink hover:bg-canvas"
              >
                <ExternalLink size={14} aria-hidden />
              </Link>
              {l.archived ? (
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<RotateCcw size={12} />}
                  onClick={() => onAction(l)}
                >
                  Поновити
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="danger"
                  leftIcon={<Archive size={12} />}
                  onClick={() => onAction(l)}
                >
                  Архів
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ModerationModal({
  row,
  onClose,
  onDone,
}: {
  row: AdminListingRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const isArchive = !row.archived;
  const title = isArchive ? "Архівувати лот" : "Поновити лот";
  const submitLabel = isArchive ? "Архівувати" : "Поновити";

  const submit = async () => {
    if (busy || reason.trim().length < 10) {
      setErr("Причина має містити мінімум 10 символів");
      return;
    }
    setBusy(true);
    setErr(null);
    const r = isArchive
      ? await archiveListingApi(row.id, reason.trim())
      : await reinstateListingApi(row.id, reason.trim());
    setBusy(false);
    if (r.ok) onDone();
    else setErr(r.error.message);
  };

  return (
    <Modal open onOpenChange={(v) => !v && onClose()} title={title} size="md">
      <div className="space-y-4">
        <div className="border border-hairline rounded-[var(--radius-sm)] bg-canvas px-4 py-3">
          <div className="text-body text-ink">{row.title}</div>
          <div className="text-caption text-muted mt-0.5">
            {row.provider.name} · {row.city}
          </div>
        </div>

        <label className="block">
          <span className="block text-caption text-ink-soft mb-1.5">
            Причина (буде записано в admin_actions)
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-hairline bg-paper text-body text-ink focus:outline-none focus:border-accent"
            placeholder="Мінімум 10 символів — наприклад: «Спам, повторне порушення політики розміщення»"
            aria-label="Причина"
          />
        </label>

        {err && <InlineAlert tone="danger">{err}</InlineAlert>}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Скасувати
          </Button>
          <Button
            onClick={submit}
            disabled={busy}
            variant={isArchive ? "danger" : "primary"}
          >
            {busy ? "…" : submitLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
