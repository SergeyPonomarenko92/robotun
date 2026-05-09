"use client";
import * as React from "react";
import {
  X,
  Paperclip,
  ImageIcon,
  FileText,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Стани відповідають Module 6 Media Pipeline §4.6 state machine:
 * awaiting_upload → uploading → awaiting_scan → ready | threat | scan_error
 * Плюс UI-only стан "removing" (анімація видалення).
 */
export type AttachmentStatus =
  | "uploading"
  | "scanning"
  | "ready"
  | "threat"
  | "error";

type AttachmentChipProps = {
  fileName: string;
  sizeBytes?: number;
  mimeType?: string;
  status: AttachmentStatus;
  /** 0..100 — для uploading */
  progress?: number;
  errorMessage?: string;
  onRemove?: () => void;
  className?: string;
};

function fileIcon(mime?: string) {
  if (!mime) return <Paperclip size={16} />;
  if (mime.startsWith("image/")) return <ImageIcon size={16} />;
  return <FileText size={16} />;
}

function formatSize(b?: number) {
  if (b == null) return "";
  const u = ["B", "KB", "MB", "GB"];
  let n = b;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

const STATUS_META: Record<
  AttachmentStatus,
  { icon: React.ReactNode; label: string; cls: string }
> = {
  uploading: {
    icon: <Loader2 size={14} className="animate-spin" />,
    label: "Завантаження",
    cls: "border-info bg-info-soft text-info",
  },
  scanning: {
    icon: <ShieldCheck size={14} />,
    label: "Перевірка",
    cls: "border-warning bg-warning-soft text-warning",
  },
  ready: {
    icon: <ShieldCheck size={14} />,
    label: "Готово",
    cls: "border-hairline bg-canvas text-ink-soft",
  },
  threat: {
    icon: <ShieldAlert size={14} />,
    label: "Загроза",
    cls: "border-danger bg-danger-soft text-danger",
  },
  error: {
    icon: <AlertTriangle size={14} />,
    label: "Помилка",
    cls: "border-danger bg-danger-soft text-danger",
  },
};

export function AttachmentChip({
  fileName,
  sizeBytes,
  mimeType,
  status,
  progress,
  errorMessage,
  onRemove,
  className,
}: AttachmentChipProps) {
  const meta = STATUS_META[status];
  return (
    <div
      className={cn(
        "relative inline-flex items-center gap-2.5 rounded-[var(--radius-sm)] border px-2.5 py-2 max-w-full overflow-hidden",
        meta.cls,
        className
      )}
    >
      <span className="shrink-0 text-current opacity-70">{fileIcon(mimeType)}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-body text-ink truncate">{fileName}</span>
          {sizeBytes != null && (
            <span className="text-micro font-mono text-muted-soft tabular-nums shrink-0">
              {formatSize(sizeBytes)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-caption mt-0.5">
          {meta.icon}
          <span className="font-medium tracking-wide uppercase text-[10px]">
            {status === "error" && errorMessage ? errorMessage : meta.label}
          </span>
          {status === "uploading" && typeof progress === "number" && (
            <span className="font-mono text-muted tabular-nums ml-1">
              {Math.round(progress)}%
            </span>
          )}
        </div>
      </div>
      {onRemove && (
        <button
          type="button"
          aria-label={`Прибрати ${fileName}`}
          onClick={onRemove}
          className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-xs)] text-current opacity-60 hover:opacity-100 hover:bg-current/10"
        >
          <X size={14} />
        </button>
      )}
      {status === "uploading" && typeof progress === "number" && (
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-0.5 bg-current opacity-50 transition-[width] duration-[var(--duration-base)]"
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      )}
    </div>
  );
}
