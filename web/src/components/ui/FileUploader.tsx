"use client";
import * as React from "react";
import { UploadCloud } from "lucide-react";
import { cn } from "@/lib/cn";
import { AttachmentChip, type AttachmentStatus } from "./AttachmentChip";

export type UploadedFile = {
  id: string;
  file: File;
  status: AttachmentStatus;
  progress?: number;
  error?: string;
};

type FileUploaderProps = {
  accept?: string;
  multiple?: boolean;
  /** Загальний верхній капс для всіх файлів */
  maxFiles?: number;
  maxSizeBytes?: number;
  hint?: React.ReactNode;
  /** UA copy у dropzone */
  label?: React.ReactNode;
  files?: UploadedFile[];
  onFilesAdd?: (files: File[]) => void;
  onRemove?: (id: string) => void;
  className?: string;
  disabled?: boolean;
};

export function FileUploader({
  accept = "image/jpeg,image/png,image/webp,application/pdf",
  multiple = true,
  maxFiles,
  maxSizeBytes,
  hint,
  label = "Перетягніть файли сюди або натисніть, щоб обрати",
  files = [],
  onFilesAdd,
  onRemove,
  className,
  disabled,
}: FileUploaderProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [drag, setDrag] = React.useState(false);
  const reachedCap = !!(maxFiles && files.length >= maxFiles);
  const remainingSlots = maxFiles ? Math.max(0, maxFiles - files.length) : Infinity;

  function handleFiles(list: FileList | null) {
    if (!list || disabled || reachedCap) return;
    // Slice to cap but do NOT filter oversize files — the orchestrating hook
    // (e.g. useUploader) creates per-file 'error' chips so the user sees
    // explicit "файл задавеликий" feedback instead of silent drop.
    const arr = Array.from(list).slice(0, remainingSlots);
    if (arr.length > 0) onFilesAdd?.(arr);
  }

  return (
    <div className={cn("flex flex-col gap-3 w-full", className)}>
      <button
        type="button"
        disabled={disabled || reachedCap}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled && !reachedCap) setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={cn(
          "relative flex flex-col items-center justify-center gap-3 w-full px-6 py-10 rounded-[var(--radius-md)] border-2 border-dashed transition-colors",
          drag ? "border-ink bg-elevated" : "border-hairline-strong bg-paper",
          disabled || reachedCap
            ? "opacity-60 cursor-not-allowed"
            : "hover:border-ink hover:bg-elevated cursor-pointer"
        )}
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-[var(--radius-md)] bg-canvas border border-hairline text-ink-soft">
          <UploadCloud size={22} />
        </span>
        <div className="text-center">
          <p className="text-body text-ink font-medium">
            {reachedCap ? "Досягнуто ліміт файлів" : label}
          </p>
          {(hint || (maxFiles || maxSizeBytes)) && (
            <p className="text-caption text-muted mt-1">
              {hint}
              {(maxFiles || maxSizeBytes) && (hint ? " · " : "")}
              {maxFiles && `до ${maxFiles} файлів`}
              {maxFiles && maxSizeBytes && ", "}
              {maxSizeBytes &&
                `≤ ${Math.round(maxSizeBytes / 1024 / 1024)} МБ кожен`}
            </p>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={(e) => handleFiles(e.target.files)}
          className="absolute inset-0 opacity-0 pointer-events-none"
          tabIndex={-1}
        />
      </button>

      {files.length > 0 && (
        <ul
          className="flex flex-col gap-2"
          aria-live="polite"
          aria-atomic="false"
        >
          {files.map((f) => (
            <li key={f.id}>
              <AttachmentChip
                fileName={f.file.name}
                sizeBytes={f.file.size}
                mimeType={f.file.type}
                status={f.status}
                progress={f.progress}
                errorMessage={f.error}
                onRemove={onRemove ? () => onRemove(f.id) : undefined}
                className="w-full"
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
