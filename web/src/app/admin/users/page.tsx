"use client";
import * as React from "react";
import Link from "next/link";
import { Search, Loader2, AlertTriangle } from "lucide-react";

import { AdminShell } from "@/components/organisms/AdminShell";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import {
  useAdminUsers,
  type AdminUserStatus,
  type AdminUserRole,
} from "@/lib/admin-users";

const STATUS_LABEL: Record<AdminUserStatus, string> = {
  active: "Активний",
  pending: "Очікує",
  suspended: "Зупинений",
  deleted: "Видалений",
};
const STATUS_TONE: Record<AdminUserStatus, "success" | "warning" | "danger" | "neutral"> = {
  active: "success",
  pending: "warning",
  suspended: "danger",
  deleted: "neutral",
};

const ROLE_FILTERS: { id: AdminUserRole | "all"; label: string }[] = [
  { id: "all", label: "Усі" },
  { id: "client", label: "Клієнти" },
  { id: "provider", label: "Виконавці" },
  { id: "admin", label: "Адміни" },
];

const STATUS_FILTERS: { id: AdminUserStatus | "all"; label: string }[] = [
  { id: "all", label: "Усі" },
  { id: "active", label: "Активні" },
  { id: "pending", label: "Очікують" },
  { id: "suspended", label: "Зупинені" },
];

export default function AdminUsersPage() {
  const [qInput, setQInput] = React.useState("");
  const [q, setQ] = React.useState("");
  const [role, setRole] = React.useState<AdminUserRole | "all">("all");
  const [status, setStatus] = React.useState<AdminUserStatus | "all">("all");

  // Debounce q so each keystroke doesn't refetch.
  React.useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 250);
    return () => clearTimeout(t);
  }, [qInput]);

  const { items, error } = useAdminUsers({
    q: q || undefined,
    role: role === "all" ? null : role,
    status: status === "all" ? null : status,
  });

  return (
    <AdminShell
      kicker="Адмін · Користувачі"
      title={
        <>
          Каталог
          <br />
          <span className="text-ink-soft italic">облікових записів</span>
        </>
      }
      description="Пошук користувачів, перегляд деталей, зупинка та поновлення доступу."
    >
      <section className="mt-6 space-y-5">
        {/* Search bar */}
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
            aria-hidden
          />
          <Input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Пошук по email або імʼю"
            className="pl-9"
            aria-label="Пошук користувачів"
          />
        </div>

        {/* Filter chips */}
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <FilterRow
            label="Роль"
            options={ROLE_FILTERS}
            value={role}
            onChange={setRole}
          />
          <FilterRow
            label="Статус"
            options={STATUS_FILTERS}
            value={status}
            onChange={setStatus}
          />
        </div>

        {/* Results */}
        <UsersTable items={items} error={error} />
      </section>
    </AdminShell>
  );
}

function FilterRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
        {label}:
      </span>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => {
          const active = o.id === value;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => onChange(o.id)}
              aria-pressed={active}
              className={
                "px-2.5 py-1 rounded-[var(--radius-pill)] text-caption transition-colors duration-[var(--duration-fast)] " +
                (active
                  ? "bg-ink text-paper"
                  : "bg-paper text-ink-soft border border-hairline hover:text-ink hover:border-hairline-strong")
              }
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function UsersTable({
  items,
  error,
}: {
  items: ReturnType<typeof useAdminUsers>["items"];
  error: ReturnType<typeof useAdminUsers>["error"];
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
          Спробуйте змінити запит або фільтри
        </div>
      </div>
    );
  }
  return (
    <div className="border border-hairline rounded-[var(--radius-md)] bg-paper overflow-hidden">
      <header className="hidden md:grid grid-cols-[1fr_120px_120px_140px] gap-4 px-5 py-3 border-b border-hairline bg-canvas">
        <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
          Користувач
        </span>
        <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
          Роль
        </span>
        <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
          Статус
        </span>
        <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted text-right">
          Зареєстрований
        </span>
      </header>
      <ul className="divide-y divide-hairline">
        {items.map((u) => (
          <li key={u.id}>
            <Link
              href={`/admin/users/${encodeURIComponent(u.id)}`}
              className="grid grid-cols-1 md:grid-cols-[1fr_120px_120px_140px] gap-4 px-5 py-3 hover:bg-canvas focus-visible:bg-canvas focus-visible:outline-none"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Avatar src={u.avatar_url} alt={u.display_name} size="sm" />
                <div className="min-w-0">
                  <div className="text-body text-ink truncate">{u.display_name}</div>
                  <div className="text-caption text-muted truncate">{u.email}</div>
                </div>
              </div>
              <div className="flex items-center md:justify-start gap-1 flex-wrap">
                {u.roles.map((r) => (
                  <Badge key={r} tone="neutral" size="sm" shape="square">
                    {r}
                  </Badge>
                ))}
              </div>
              <div className="flex items-center">
                <Badge
                  tone={STATUS_TONE[u.status]}
                  size="sm"
                  shape="square"
                >
                  {STATUS_LABEL[u.status]}
                </Badge>
              </div>
              <div className="flex items-center md:justify-end text-caption text-muted tabular-nums">
                {new Date(u.created_at).toLocaleDateString("uk-UA")}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
