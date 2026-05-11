import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import {
  cancelRequestTransition,
  projectDeal,
  type CancelRequestAction,
} from "../../../_mock/deals";

/**
 * POST /api/v1/deals/{id}/cancel-request
 *
 * Mutual cancel handshake — Module 3 §REQ-009 / PAT-003. Body:
 *   { action: 'request' | 'revoke', reason?: string }
 *
 * - request: records the caller's `cancel_requested_by_{client|provider}_at`
 *   timestamp. If the counterparty's column is already non-null within the
 *   48h TTL, status flips to 'cancelled' atomically.
 * - revoke:  clears the caller's column. Allowed only while status='active'
 *   and the caller's column is set.
 *
 * Error codes:
 *   400 invalid_action      — unknown action
 *   401 unauthorized        — from authorize()
 *   403 forbidden           — caller is neither client nor provider
 *   404 not_found           — deal does not exist
 *   409 invalid_state       — status not 'active'
 *   409 no_active_request   — revoke without a prior request
 */
const VALID_ACTIONS: CancelRequestAction[] = ["request", "revoke"];

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await ctx.params;

  let body: { action?: string; reason?: string };
  try {
    body = (await req.json()) as { action?: string; reason?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const action = body.action as CancelRequestAction | undefined;
  if (!action || !VALID_ACTIONS.includes(action)) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : null;

  const demoActAsProvider = auth.user.email === "provider@robotun.dev";
  const result = cancelRequestTransition(
    id,
    auth.user.id,
    action,
    reason,
    demoActAsProvider
  );
  if ("error" in result) {
    const status =
      result.error === "not_found"
        ? 404
        : result.error === "forbidden"
          ? 403
          : 409;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json(projectDeal(result));
}
