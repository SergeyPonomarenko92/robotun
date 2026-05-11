/**
 * Module 12 mock — admin_actions append-only audit log.
 *
 * Real backend: partitioned table, INSERT-only via REVOKE on UPDATE/DELETE
 * (mirrors KYC SEC-006), with a denormalized target_user_id column for
 * support-role timeline filtering and an admin_audit_search_index projection.
 * Mock holds a flat list on globalThis; helpers expose append + query.
 */

export type AdminActionType =
  | "mfa.challenge.issued"
  | "mfa.challenge.consumed"
  | "dispute.resolved"
  | "payout.completed";

export type AdminAction = {
  id: string;
  actor_admin_id: string;
  action: AdminActionType;
  target_type: "deal" | "user" | "payout" | null;
  target_id: string | null;
  /** Denormalized — supports timeline-by-user queries without JOIN. */
  target_user_id: string | null;
  metadata: Record<string, string | number | boolean | null>;
  created_at: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __ROBOTUN_ADMIN_ACTIONS__: AdminAction[] | undefined;
}
function db(): AdminAction[] {
  if (!globalThis.__ROBOTUN_ADMIN_ACTIONS__)
    globalThis.__ROBOTUN_ADMIN_ACTIONS__ = [];
  return globalThis.__ROBOTUN_ADMIN_ACTIONS__;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}

export function logAdminAction(input: {
  actor_admin_id: string;
  action: AdminActionType;
  target_type?: AdminAction["target_type"];
  target_id?: string | null;
  target_user_id?: string | null;
  metadata?: AdminAction["metadata"];
}): AdminAction {
  const row: AdminAction = {
    id: uuid(),
    actor_admin_id: input.actor_admin_id,
    action: input.action,
    target_type: input.target_type ?? null,
    target_id: input.target_id ?? null,
    target_user_id: input.target_user_id ?? null,
    metadata: input.metadata ?? {},
    created_at: new Date().toISOString(),
  };
  db().push(row);
  return row;
}

export function listAdminActions(opts: {
  limit?: number;
  cursor?: string | null;
  /** Filter on target_user_id (support role uses this for per-user timeline). */
  target_user_id?: string | null;
  /** Filter on action prefix (e.g. "mfa." or "dispute."). */
  action_prefix?: string | null;
}): { items: AdminAction[]; next_cursor: string | null; total: number } {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 20));
  let pool = db().slice();
  if (opts.target_user_id)
    pool = pool.filter((a) => a.target_user_id === opts.target_user_id);
  if (opts.action_prefix)
    pool = pool.filter((a) => a.action.startsWith(opts.action_prefix!));
  pool.sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  let start = 0;
  if (opts.cursor) {
    try {
      const n = Number.parseInt(
        Buffer.from(opts.cursor, "base64url").toString("utf8"),
        10
      );
      if (Number.isFinite(n) && n > 0 && n < pool.length) start = n;
    } catch {
      /* bad cursor */
    }
  }
  const slice = pool.slice(start, start + limit);
  const nextIdx = start + limit;
  return {
    items: slice,
    next_cursor:
      nextIdx < pool.length
        ? Buffer.from(String(nextIdx), "utf8").toString("base64url")
        : null,
    total: pool.length,
  };
}
