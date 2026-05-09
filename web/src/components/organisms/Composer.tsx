"use client";
import * as React from "react";
import { Paperclip, Send, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { AttachmentChip, type AttachmentStatus } from "@/components/ui/AttachmentChip";

export type ComposerAttachment = {
  id: string;
  fileName: string;
  sizeBytes?: number;
  mimeType?: string;
  status: AttachmentStatus;
  progress?: number;
};

type ComposerProps = {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  attachments?: ComposerAttachment[];
  onAttachmentsAdd?: (files: File[]) => void;
  onAttachmentRemove?: (id: string) => void;
  /** Module 10: лімит chars (5000 default) */
  maxLength?: number;
  /** Якщо conv заблоковано */
  blocked?: boolean;
  /** UI-rate-limit: backoff seconds left */
  rateLimitedSeconds?: number;
  /** Виявлено контактну інфо у поточному text — show inline warning */
  contactInfoDetected?: boolean;
  loading?: boolean;
  placeholder?: string;
  className?: string;
};

export function Composer({
  value,
  onChange,
  onSend,
  attachments = [],
  onAttachmentsAdd,
  onAttachmentRemove,
  maxLength = 5000,
  blocked,
  rateLimitedSeconds,
  contactInfoDetected,
  loading,
  placeholder = "Напишіть повідомлення… (Enter — надіслати, Shift+Enter — новий рядок)",
  className,
}: ComposerProps) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const taRef = React.useRef<HTMLTextAreaElement>(null);

  // auto-grow
  React.useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !loading && !blocked && !rateLimitedSeconds) {
      e.preventDefault();
      if (value.trim().length > 0 || attachments.some((a) => a.status === "ready")) {
        onSend();
      }
    }
  }

  const overLimit = value.length > maxLength;
  const sendDisabled = blocked || loading || overLimit || !!rateLimitedSeconds || (value.trim().length === 0 && attachments.filter((a) => a.status === "ready").length === 0);

  if (blocked) {
    return (
      <footer
        className={cn(
          "border-t border-hairline bg-paper px-4 py-6 text-center text-body text-muted",
          className
        )}
      >
        Чат заблоковано. Звʼязок з цим користувачем недоступний.
      </footer>
    );
  }

  return (
    <footer className={cn("border-t border-hairline bg-paper", className)}>
      {contactInfoDetected && (
        <div className="px-4 pt-3">
          <p className="text-caption text-warning bg-warning-soft border border-warning rounded-[var(--radius-sm)] px-3 py-2 inline-block">
            Виявлено контактні дані. Вони будуть автоматично приховані для отримувача.
          </p>
        </div>
      )}

      {attachments.length > 0 && (
        <ul className="px-4 pt-3 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <li key={a.id}>
              <AttachmentChip
                fileName={a.fileName}
                sizeBytes={a.sizeBytes}
                mimeType={a.mimeType}
                status={a.status}
                progress={a.progress}
                onRemove={onAttachmentRemove ? () => onAttachmentRemove(a.id) : undefined}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2 p-3 md:p-4">
        <button
          type="button"
          aria-label="Прикріпити файл"
          onClick={() => fileRef.current?.click()}
          className="shrink-0 inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-sm)] text-ink-soft hover:bg-canvas hover:text-ink transition-colors"
        >
          <Paperclip size={18} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files && onAttachmentsAdd) {
              onAttachmentsAdd(Array.from(e.target.files));
              e.target.value = "";
            }
          }}
        />

        <div className="flex-1 min-w-0 relative">
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKey}
            rows={1}
            placeholder={placeholder}
            className={cn(
              "block w-full resize-none px-4 py-2.5 text-body bg-canvas border rounded-[var(--radius-md)] outline-none focus:border-ink transition-colors leading-relaxed",
              overLimit ? "border-danger focus:border-danger" : "border-hairline-strong"
            )}
            style={{ minHeight: 44, maxHeight: 220 }}
          />
          {(value.length > maxLength * 0.8 || overLimit) && (
            <span
              className={cn(
                "absolute bottom-1.5 right-3 text-micro font-mono tabular-nums",
                overLimit ? "text-danger" : "text-muted-soft"
              )}
            >
              {value.length}/{maxLength}
            </span>
          )}
        </div>

        <Button
          variant={sendDisabled ? "secondary" : "primary"}
          size="md"
          disabled={sendDisabled}
          onClick={onSend}
          aria-label="Надіслати"
        >
          {loading ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />}
        </Button>
      </div>

      {rateLimitedSeconds && rateLimitedSeconds > 0 && (
        <div className="px-4 pb-3 text-caption text-muted">
          Зачекайте {rateLimitedSeconds} с перед наступним повідомленням
        </div>
      )}
    </footer>
  );
}
