"use client";
import * as React from "react";
import { apiFetch, getAccessToken } from "@/lib/api";
import type { UploadedFile } from "@/components/ui/FileUploader";

export type MediaPurpose =
  | "listing_cover"
  | "listing_gallery"
  | "listing_attachment"
  | "kyc_document"
  | "avatar"
  | "dispute_evidence";

const MIME_BY_PURPOSE: Record<MediaPurpose, readonly string[]> = {
  listing_cover: ["image/jpeg", "image/png", "image/webp"],
  listing_gallery: ["image/jpeg", "image/png", "image/webp"],
  listing_attachment: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  kyc_document: ["image/jpeg", "image/png", "application/pdf"],
  avatar: ["image/jpeg", "image/png", "image/webp"],
  dispute_evidence: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
};

const MAX_BYTES_BY_PURPOSE: Record<MediaPurpose, number> = {
  listing_cover: 10 * 1024 * 1024,
  listing_gallery: 10 * 1024 * 1024,
  listing_attachment: 10 * 1024 * 1024,
  kyc_document: 20 * 1024 * 1024,
  avatar: 5 * 1024 * 1024,
  dispute_evidence: 10 * 1024 * 1024,
};

/**
 * Canonical stream URL for a media object. Public for listing_cover /
 * listing_gallery / avatar purposes (anonymous fetch OK); requires Bearer
 * for private purposes (dispute_evidence / kyc_document / listing_attachment).
 */
export function getMediaStreamUrl(mediaId: string): string {
  return `/api/v1/media/${encodeURIComponent(mediaId)}/stream`;
}

export type UploaderOpts = {
  purpose: MediaPurpose;
  /** Hard cap. Overrides spec default if passed lower. */
  maxFiles?: number;
  /** KYC uploads must go through the /kyc/me/uploads/* proxy (REQ-007).
   *  Default 'media' = generic /media/uploads/* endpoints. */
  endpoint?: "media" | "kyc";
};

export type UploaderState = {
  files: UploadedFile[];
  /** Stable derived array — only files whose status==='ready'. */
  mediaIds: string[];
  uploading: boolean;
  /** True if any chip ended in 'error' (excluded from mediaIds). */
  hasErrors: boolean;
  /** MIME string for FileUploader.accept prop. */
  accept: string;
  /** Bytes cap per file (passed to FileUploader.maxSizeBytes is server-side only — UI uses this for hint). */
  maxSizeBytes: number;
  addFiles: (newFiles: File[]) => Promise<void>;
  removeFile: (localId: string) => void;
  reset: () => void;
  /** Lookup the server media_id for a given local file id (returns null if
   *  the upload hasn't completed or the localId is unknown). */
  getMediaId: (localId: string) => string | null;
};

type InitiateResponse = {
  media_id: string;
  method: "POST";
  url: string;
  fields: Record<string, string>;
  expires_at: string;
};

function sizeCapMessage(maxBytes: number): string {
  return `Файл задавеликий (макс. ${Math.round(maxBytes / 1024 / 1024)} МБ)`;
}

export function useUploader(opts: UploaderOpts): UploaderState {
  const { purpose, maxFiles, endpoint = "media" } = opts;
  const maxSizeBytes = MAX_BYTES_BY_PURPOSE[purpose];
  const accept = MIME_BY_PURPOSE[purpose].join(",");
  const allowedMimes = MIME_BY_PURPOSE[purpose];

  const initiatePath =
    endpoint === "kyc" ? "/kyc/me/uploads/initiate" : "/media/uploads/initiate";
  const confirmPath =
    endpoint === "kyc" ? "/kyc/me/uploads/confirm" : "/media/uploads/confirm";

  const [files, setFiles] = React.useState<UploadedFile[]>([]);
  // Local→server mediaId mapping. Ref (not state) so concurrent updates don't
  // race. mediaIds[] is derived from files+ref together via useMemo.
  const localToMediaRef = React.useRef<Map<string, string>>(new Map());

  const updateFile = React.useCallback(
    (localId: string, patch: Partial<UploadedFile>) => {
      setFiles((prev) => prev.map((f) => (f.id === localId ? { ...f, ...patch } : f)));
    },
    []
  );

  const addFiles = React.useCallback(
    async (incoming: File[]) => {
      if (incoming.length === 0) return;

      // Local cap check — applied synchronously before issuing initiates.
      // FileUploader also slices to remainingSlots, but we double-guard for
      // direct programmatic calls.
      const currentCount = files.length;
      const cap = maxFiles ?? Infinity;
      const remaining = Math.max(0, cap - currentCount);
      const accepted = incoming.slice(0, remaining);
      if (accepted.length === 0) return;

      // Seed pending chips synchronously so the UI reflects all queued uploads
      // before any network call.
      const queued: { localId: string; file: File }[] = accepted.map((file) => ({
        localId: crypto.randomUUID(),
        file,
      }));
      setFiles((prev) => [
        ...prev,
        ...queued.map(({ localId, file }) => ({
          id: localId,
          file,
          status: "uploading" as const,
        })),
      ]);

      await Promise.all(
        queued.map(async ({ localId, file }) => {
          // 1. Local validate (size + MIME). Server validates again.
          if (file.size > maxSizeBytes) {
            updateFile(localId, {
              status: "error",
              error: sizeCapMessage(maxSizeBytes),
            });
            return;
          }
          if (!allowedMimes.includes(file.type)) {
            updateFile(localId, {
              status: "error",
              error: "Дозволені формати: зображення та PDF",
            });
            return;
          }

          // 2. Initiate.
          let init: InitiateResponse;
          try {
            init = await apiFetch<InitiateResponse>(initiatePath, {
              method: "POST",
              body: JSON.stringify({
                purpose,
                mime_type: file.type,
                byte_size: file.size,
                original_filename: file.name,
              }),
            });
          } catch {
            updateFile(localId, { status: "error", error: "Помилка ініціалізації" });
            return;
          }

          // 3. POST blob to the presigned URL with FormData (matches S3 POST shape).
          //    Real S3: no Authorization header — auth lives in policy/signature.
          //    Mock: our endpoint requires the JWT to keep ownership consistent.
          try {
            const fd = new FormData();
            for (const [k, v] of Object.entries(init.fields)) fd.append(k, v);
            fd.append("file", file);
            const token = getAccessToken();
            const headers: Record<string, string> = {};
            if (token) headers["Authorization"] = `Bearer ${token}`;
            const res = await fetch(init.url, { method: init.method, body: fd, headers });
            if (!res.ok) throw new Error("upload_failed");
          } catch {
            updateFile(localId, {
              status: "error",
              error: "Помилка завантаження — спробуйте знову",
            });
            // Best-effort orphan delete so the server slot doesn't leak.
            void apiFetch(`/media/${init.media_id}`, { method: "DELETE" }).catch(() => {});
            return;
          }

          // 4. Confirm.
          let confirmRes: { status: "awaiting_scan" | "ready" };
          try {
            confirmRes = await apiFetch<{ status: "awaiting_scan" | "ready" }>(
              confirmPath,
              {
                method: "POST",
                body: JSON.stringify({ media_id: init.media_id }),
              }
            );
          } catch {
            updateFile(localId, {
              status: "error",
              error: "Помилка підтвердження — спробуйте знову",
            });
            void apiFetch(`/media/${init.media_id}`, { method: "DELETE" }).catch(() => {});
            return;
          }

          localToMediaRef.current.set(localId, init.media_id);

          // 5. If awaiting_scan (KYC mock + production async scan path),
          //    show "scanning" chip and poll GET /media/{id} until ready.
          //    8 attempts × 500ms = 4s ceiling; the mock promotes after 1.5s.
          if (confirmRes.status === "awaiting_scan") {
            updateFile(localId, { status: "scanning" });
            let promoted = false;
            for (let attempt = 0; attempt < 8; attempt++) {
              await new Promise((r) => setTimeout(r, 500));
              try {
                const meta = await apiFetch<{ status: string }>(
                  `/media/${init.media_id}`
                );
                if (meta.status === "ready") {
                  promoted = true;
                  break;
                }
              } catch {
                // transient — keep trying
              }
            }
            if (!promoted) {
              updateFile(localId, {
                status: "error",
                error: "Перевірка не завершилась — спробуйте знову",
              });
              return;
            }
          }

          updateFile(localId, { status: "ready" });
        })
      );
    },
    [files.length, maxFiles, maxSizeBytes, allowedMimes, purpose, updateFile]
  );

  const removeFile = React.useCallback((localId: string) => {
    const mediaId = localToMediaRef.current.get(localId);
    localToMediaRef.current.delete(localId);
    setFiles((prev) => prev.filter((f) => f.id !== localId));
    if (mediaId) {
      // Fire-and-forget; orphan sweep is the backstop in production.
      void apiFetch(`/media/${mediaId}`, { method: "DELETE" }).catch(() => {});
    }
  }, []);

  const reset = React.useCallback(() => {
    // Best-effort: clean uploaded media so we don't orphan slots.
    for (const mediaId of localToMediaRef.current.values()) {
      void apiFetch(`/media/${mediaId}`, { method: "DELETE" }).catch(() => {});
    }
    localToMediaRef.current.clear();
    setFiles([]);
  }, []);

  // Cleanup on unmount.
  React.useEffect(() => {
    return () => {
      // Don't auto-delete on unmount: the parent (DisputePanel) may unmount
      // legitimately after success — we already called reset() there. For an
      // accidental unmount mid-upload, the orphan sweep cleans up.
    };
  }, []);

  const mediaIds = React.useMemo(() => {
    const out: string[] = [];
    for (const f of files) {
      if (f.status !== "ready") continue;
      const mid = localToMediaRef.current.get(f.id);
      if (mid) out.push(mid);
    }
    return out;
  }, [files]);

  const uploading = files.some(
    (f) => f.status === "uploading" || f.status === "scanning"
  );
  const hasErrors = files.some((f) => f.status === "error");

  const getMediaId = React.useCallback(
    (localId: string) => localToMediaRef.current.get(localId) ?? null,
    []
  );

  return {
    files,
    mediaIds,
    uploading,
    hasErrors,
    accept,
    maxSizeBytes,
    addFiles,
    removeFile,
    reset,
    getMediaId,
  };
}
