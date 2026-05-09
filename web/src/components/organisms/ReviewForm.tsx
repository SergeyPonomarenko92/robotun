"use client";
import * as React from "react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { FormField } from "@/components/ui/FormField";
import { RatingStars } from "@/components/ui/RatingStars";
import { FileUploader, type UploadedFile } from "@/components/ui/FileUploader";

/** Module 7 §REQ — review body 100..2000, 0..3 attachments */
const MIN_LEN = 100;
const MAX_LEN = 2000;
const MAX_ATTACHMENTS = 3;

type ReviewFormProps = {
  /** Контекст: про кого/що */
  contextLabel?: React.ReactNode;
  defaultRating?: number;
  defaultBody?: string;
  onSubmit?: (data: { rating: number; body: string; attachments: UploadedFile[] }) => void;
  onCancel?: () => void;
  loading?: boolean;
  className?: string;
};

export function ReviewForm({
  contextLabel,
  defaultRating = 0,
  defaultBody = "",
  onSubmit,
  onCancel,
  loading,
  className,
}: ReviewFormProps) {
  const [rating, setRating] = React.useState(defaultRating);
  const [body, setBody] = React.useState(defaultBody);
  const [attachments, setAttachments] = React.useState<UploadedFile[]>([]);

  const tooShort = body.trim().length > 0 && body.trim().length < MIN_LEN;
  const overLimit = body.length > MAX_LEN;
  const valid = rating >= 1 && body.trim().length >= MIN_LEN && !overLimit;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || !onSubmit) return;
    onSubmit({ rating, body: body.trim(), attachments });
  }

  return (
    <form onSubmit={submit} className={cn("flex flex-col gap-5", className)}>
      {contextLabel && (
        <p className="font-mono text-micro uppercase tracking-loose text-muted-soft">
          {contextLabel}
        </p>
      )}
      <FormField
        label="Ваша оцінка"
        helper="1 — погано, 5 — чудово"
        required
      >
        <div className="py-1">
          <RatingStars
            mode="input"
            value={rating}
            onChange={setRating}
            size="lg"
          />
        </div>
      </FormField>

      <FormField
        label="Розкажіть, як пройшло"
        helper={`${MIN_LEN}–${MAX_LEN} символів. Без контактних даних — їх автоматично приховаємо.`}
        error={
          tooShort ? `Ще ${MIN_LEN - body.trim().length} символів` :
          overLimit ? "Перевищено максимум 2000 символів" :
          undefined
        }
        charCount={{ current: body.length, max: MAX_LEN }}
        required
      >
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder="Що сподобалось, що можна покращити, чи рекомендуєте іншим…"
          className="block w-full px-4 py-3 text-body bg-paper border border-hairline-strong rounded-[var(--radius-sm)] focus:border-ink outline-none leading-relaxed resize-none"
        />
      </FormField>

      <FormField
        label="Фото (опц.)"
        helper="До 3 фото, 10 МБ кожне"
        optional
      >
        <FileUploader
          maxFiles={MAX_ATTACHMENTS}
          maxSizeBytes={10 * 1024 * 1024}
          accept="image/jpeg,image/png,image/webp"
          files={attachments}
          onFilesAdd={(files) =>
            setAttachments((cur) => [
              ...cur,
              ...files.map((f) => ({
                id: crypto.randomUUID(),
                file: f,
                status: "ready" as const,
              })),
            ])
          }
          onRemove={(id) => setAttachments((cur) => cur.filter((a) => a.id !== id))}
        />
      </FormField>

      <div className="flex items-center justify-end gap-2 pt-4 border-t border-hairline">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Скасувати
          </Button>
        )}
        <Button type="submit" disabled={!valid} loading={loading}>
          Опублікувати відгук
        </Button>
      </div>
    </form>
  );
}
