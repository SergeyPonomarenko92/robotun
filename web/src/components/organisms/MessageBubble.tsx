import * as React from "react";
import { ShieldAlert, Eye, AlertTriangle, Check, CheckCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/Avatar";

/**
 * Message visual states per Module 10 (Messaging) + Module 14 (Disputes UI):
 *  - normal
 *  - sending (optimistic)
 *  - failed
 *  - auto_redacted (contact-info detection)
 *  - gdpr_erased (body NULL)
 *  - admin_visible (badge for moderators only — Disputes audit)
 */
export type MessageBubbleData = {
  id: string;
  body?: string | null;
  /** ISO */
  createdAt: string;
  senderIsMe: boolean;
  senderName?: string;
  senderAvatarUrl?: string;
  /** read | delivered | sent */
  delivery?: "sending" | "sent" | "delivered" | "read" | "failed";
  /** Module 10 — body=null after GDPR erasure */
  gdprErased?: boolean;
  /** Module 10 — contact info detected and stripped */
  autoRedacted?: boolean;
  /** Module 14 — admin can see this row even though parties don't have contact-info etc */
  adminVisible?: boolean;
  /** Видно тільки адміну */
  viewerIsAdmin?: boolean;
  /** Edited indicator (≤10min edit window) */
  edited?: boolean;
  attachments?: { id: string; name: string; thumbUrl?: string }[];
};

type Props = {
  data: MessageBubbleData;
  /** Сусіднє повідомлення з тим самим автором (для grouping) */
  groupedWithPrev?: boolean;
  className?: string;
};

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
}

export function MessageBubble({ data, groupedWithPrev, className }: Props) {
  const own = data.senderIsMe;
  const erased = data.gdprErased;
  const redacted = data.autoRedacted;
  const adminBadgeVisible = data.adminVisible && data.viewerIsAdmin;

  return (
    <div
      className={cn(
        "flex gap-2 max-w-[85%] md:max-w-[70%]",
        own ? "ml-auto flex-row-reverse" : "",
        className
      )}
    >
      {!own && !groupedWithPrev ? (
        <Avatar
          shape="circle"
          size="sm"
          alt={data.senderName ?? ""}
          src={data.senderAvatarUrl}
          className="shrink-0 mt-0.5"
        />
      ) : !own ? (
        <span className="shrink-0 w-8" aria-hidden />
      ) : null}

      <div className={cn("flex flex-col min-w-0", own ? "items-end" : "items-start")}>
        {!own && !groupedWithPrev && data.senderName && (
          <p className="text-caption text-muted mb-1 px-1">{data.senderName}</p>
        )}

        <div
          className={cn(
            "rounded-[var(--radius-md)] px-3.5 py-2.5 text-body leading-relaxed break-words",
            own
              ? "bg-ink text-paper"
              : "bg-paper border border-hairline text-ink",
            erased && (own ? "bg-ink/40" : "bg-canvas border-dashed text-muted italic"),
            redacted && !erased && (own ? "ring-2 ring-warning/60 bg-ink/80" : "bg-warning-soft border-warning text-warning")
          )}
        >
          {erased ? (
            <span className="inline-flex items-center gap-1.5 text-paper/80">
              <Eye size={14} /> [повідомлення видалено]
            </span>
          ) : redacted ? (
            <span className="inline-flex items-center gap-1.5">
              <ShieldAlert size={14} /> [контактні дані приховано]
            </span>
          ) : (
            data.body
          )}

          {data.attachments && data.attachments.length > 0 && !erased && (
            <ul className="mt-2 grid grid-cols-2 gap-1">
              {data.attachments.map((a) => (
                <li
                  key={a.id}
                  className={cn(
                    "rounded-[var(--radius-xs)] overflow-hidden border",
                    own ? "border-paper/20" : "border-hairline"
                  )}
                >
                  {a.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.thumbUrl} alt={a.name} className="h-20 w-full object-cover" />
                  ) : (
                    <div className="h-20 flex items-center justify-center text-caption font-mono text-muted bg-canvas">
                      {a.name}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={cn("mt-1 px-1 flex items-center gap-1.5 text-micro font-mono text-muted-soft tabular-nums", own ? "flex-row-reverse" : "")}>
          <span>{fmtTime(data.createdAt)}</span>
          {data.edited && <span>· редаговано</span>}
          {own && data.delivery && (
            <span className="inline-flex items-center" aria-label={data.delivery}>
              {data.delivery === "sending" && (
                <span className="inline-block h-2 w-2 rounded-full bg-muted-soft animate-pulse" aria-hidden />
              )}
              {data.delivery === "sent" && <Check size={12} />}
              {data.delivery === "delivered" && <CheckCheck size={12} />}
              {data.delivery === "read" && <CheckCheck size={12} className="text-info" />}
              {data.delivery === "failed" && <AlertTriangle size={12} className="text-danger" />}
            </span>
          )}
          {adminBadgeVisible && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--radius-xs)] bg-warning-soft text-warning border border-warning text-[10px] uppercase tracking-loose">
              admin-visible
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
