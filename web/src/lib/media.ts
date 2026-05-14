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
  | "dispute_evidence"
  | "message_attachment";

const MIME_BY_PURPOSE: Record<MediaPurpose, readonly string[]> = {
  listing_cover: ["image/jpeg", "image/png", "image/webp"],
  listing_gallery: ["image/jpeg", "image/png", "image/webp"],
  listing_attachment: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  kyc_document: ["image/jpeg", "image/png", "application/pdf"],
  avatar: ["image/jpeg", "image/png", "image/webp"],
  dispute_evidence: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  message_attachment: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
};

const MAX_BYTES_BY_PURPOSE: Record<MediaPurpose, number> = {
  listing_cover: 10 * 1024 * 1024,
  listing_gallery: 10 * 1024 * 1024,
  listing_attachment: 10 * 1024 * 1024,
  kyc_document: 20 * 1024 * 1024,
  avatar: 5 * 1024 * 1024,
  dispute_evidence: 10 * 1024 * 1024,
  message_attachment: 10 * 1024 * 1024,
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
  // localIds the user removed (or unmounted) — used to abort in-flight poll
  // loops so a late "ready" promote can't resurrect a removed chip.
  const cancelledRef = React.useRef<Set<string>>(new Set());
  const mountedRef = React.useRef(true);
  React.useEffect(() => () => { mountedRef.current = false; }, []);

  const updateFile = React.useCallback(
    (localId: string, patch: Partial<UploadedFile>) => {
      if (!mountedRef.current || cancelledRef.current.has(localId)) return;
      setFiles((prev) => prev.map((f) => (f.id === localId ? { ...f, ...patch } : f)));
    },
    []
  );

  const addFiles = React.useCallback(
    async (incoming: File[]) => {
      if (incoming.length === 0) return;

      // Pre-generate stable ids so the setFiles updater is pure (strict-mode
      // double-invoke safe) and we can read `queued` after the commit.
      const candidates = incoming.map((file) => ({
        localId: crypto.randomUUID(),
        file,
      }));
      const cap = maxFiles ?? Infinity;

      // Atomic cap reservation: do the cap check *inside* a setFiles updater so
      // two near-simultaneous addFiles() calls don't both see the pre-update
      // length and overshoot maxFiles. Closure-based `files.length` is stale
      // between updates — this pattern reserves slots in the same tick.
      // The updater reserves a prefix of `candidates`; `queued` mirrors that
      // prefix length below using the same arithmetic (single source of truth
      // is `cap - prev.length` which we capture via a ref).
      const reservedCountRef = { value: 0 };
      setFiles((prev) => {
        const remaining = Math.max(0, cap - prev.length);
        const take = Math.min(remaining, candidates.length);
        reservedCountRef.value = take;
        return [
          ...prev,
          ...candidates.slice(0, take).map(({ localId, file }) => ({
            id: localId,
            file,
            status: "uploading" as const,
          })),
        ];
      });
      const queued = candidates.slice(0, reservedCountRef.value);
      if (queued.length === 0) return;

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
          type ConfirmStatus =
            | "awaiting_scan"
            | "ready"
            | "quarantine_rejected"
            | "scan_error_permanent";
          let confirmRes: { status: ConfirmStatus };
          try {
            confirmRes = await apiFetch<{ status: ConfirmStatus }>(confirmPath, {
              method: "POST",
              body: JSON.stringify({ media_id: init.media_id }),
            });
          } catch {
            updateFile(localId, {
              status: "error",
              error: "Помилка підтвердження — спробуйте знову",
            });
            void apiFetch(`/media/${init.media_id}`, { method: "DELETE" }).catch(() => {});
            return;
          }

          if (cancelledRef.current.has(localId)) {
            // User removed the chip mid-flight — drop the media so it doesn't
            // leak into mediaIds via a late state arrival.
            void apiFetch(`/media/${init.media_id}`, { method: "DELETE" }).catch(() => {});
            return;
          }
          localToMediaRef.current.set(localId, init.media_id);
          // Mirror onto the state row so derivations (mediaIds, getMediaId)
          // can read from React state instead of a ref during render.
          updateFile(localId, { media_id: init.media_id });

          // 4b. Sync terminal failure (non-KYC purposes resolve immediately).
          if (confirmRes.status === "quarantine_rejected") {
            updateFile(localId, {
              status: "threat",
              error: "Виявлено загрозу — файл відхилено",
            });
            return;
          }
          if (confirmRes.status === "scan_error_permanent") {
            updateFile(localId, {
              status: "error",
              error: "Перевірка не вдалася — спробуйте інший файл",
            });
            return;
          }

          // 5. If awaiting_scan (KYC mock + production async scan path),
          //    show "scanning" chip and poll GET /media/{id} until ready or
          //    a terminal failure (quarantine_rejected / scan_error_permanent).
          //    8 attempts × 500ms = 4s ceiling; the mock promotes after 1.5s.
          if (confirmRes.status === "awaiting_scan") {
            updateFile(localId, { status: "scanning" });
            let resolved: "ready" | "threat" | "scan_error" | null = null;
            for (let attempt = 0; attempt < 8; attempt++) {
              await new Promise((r) => setTimeout(r, 500));
              if (cancelledRef.current.has(localId)) return; // user removed / unmounted
              try {
                const meta = await apiFetch<{ status: string }>(
                  `/media/${init.media_id}`
                );
                if (meta.status === "ready") {
                  resolved = "ready";
                  break;
                }
                if (meta.status === "quarantine_rejected") {
                  resolved = "threat";
                  break;
                }
                if (meta.status === "scan_error_permanent") {
                  resolved = "scan_error";
                  break;
                }
              } catch {
                // transient — keep trying
              }
            }
            if (resolved === "threat") {
              updateFile(localId, {
                status: "threat",
                error: "Виявлено загрозу — файл відхилено",
              });
              return;
            }
            if (resolved === "scan_error") {
              updateFile(localId, {
                status: "error",
                error: "Перевірка не вдалася — спробуйте інший файл",
              });
              return;
            }
            if (resolved !== "ready") {
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
    [
      maxFiles,
      maxSizeBytes,
      allowedMimes,
      purpose,
      updateFile,
      initiatePath,
      confirmPath,
    ]
  );

  const removeFile = React.useCallback((localId: string) => {
    cancelledRef.current.add(localId);
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
    setFiles((prev) => {
      for (const f of prev) cancelledRef.current.add(f.id);
      return [];
    });
    localToMediaRef.current.clear();
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
      if (f.media_id) out.push(f.media_id);
    }
    return out;
  }, [files]);

  const uploading = files.some(
    (f) => f.status === "uploading" || f.status === "scanning"
  );
  const hasErrors = files.some((f) => f.status === "error" || f.status === "threat");

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
