/**
 * MinIO/S3 client + helpers for Module 6 Media pipeline.
 *
 * Buckets are auto-created on startup (`ensureBuckets`). In production AWS
 * the buckets are pre-provisioned by infra; this auto-create is a dev
 * convenience tied to MinIO.
 */
import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
  PutBucketPolicyCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";

export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true, // required for MinIO
});

export type BucketAlias = "quarantine" | "public-media" | "kyc-private";

export function bucketNameFor(alias: BucketAlias): string {
  switch (alias) {
    case "quarantine":
      return env.S3_BUCKET_QUARANTINE;
    case "public-media":
      return env.S3_BUCKET_PUBLIC;
    case "kyc-private":
      return env.S3_BUCKET_KYC;
  }
}

export async function ensureBuckets(): Promise<void> {
  for (const alias of ["quarantine", "public-media", "kyc-private"] as const) {
    const name = bucketNameFor(alias);
    try {
      await s3.send(new HeadBucketCommand({ Bucket: name }));
    } catch {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: name }));
      } catch (e) {
        // Bucket may have been created concurrently; ignore "already owned".
        const code = (e as { name?: string }).name ?? "";
        if (!code.includes("BucketAlreadyOwned") && !code.includes("BucketAlreadyExists")) {
          throw e;
        }
      }
    }
  }
}

/**
 * Presigned POST for direct browser upload to quarantine. Caller HEAD-checks
 * the object on /uploads/confirm before flipping status to awaiting_scan.
 */
export async function presignUpload(args: {
  bucket: BucketAlias;
  key: string;
  contentType: string;
  maxBytes: number;
  expiresSeconds?: number;
}) {
  const { url, fields } = await createPresignedPost(s3, {
    Bucket: bucketNameFor(args.bucket),
    Key: args.key,
    Conditions: [
      ["content-length-range", 1, args.maxBytes],
      { "Content-Type": args.contentType },
    ],
    Fields: { "Content-Type": args.contentType },
    Expires: args.expiresSeconds ?? 600,
  });
  return { url, fields };
}

/** Quick HEAD to verify the object exists in quarantine after client upload. */
export async function objectExists(args: { bucket: BucketAlias; key: string }): Promise<{
  exists: boolean;
  contentLength?: number;
}> {
  try {
    const r = await s3.send(
      new HeadObjectCommand({ Bucket: bucketNameFor(args.bucket), Key: args.key })
    );
    return { exists: true, contentLength: r.ContentLength };
  } catch {
    return { exists: false };
  }
}

export async function presignDownload(args: {
  bucket: BucketAlias;
  key: string;
  expiresSeconds?: number;
}): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucketNameFor(args.bucket), Key: args.key }),
    { expiresIn: args.expiresSeconds ?? 300 }
  );
}

export async function deleteObject(args: { bucket: BucketAlias; key: string }) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucketNameFor(args.bucket), Key: args.key }));
  } catch {
    // best effort
  }
}

/** Streaming download → Buffer. Used by the ClamAV scan worker. */
export async function downloadObject(args: {
  bucket: BucketAlias;
  key: string;
}): Promise<Buffer> {
  const out = await s3.send(
    new GetObjectCommand({ Bucket: bucketNameFor(args.bucket), Key: args.key })
  );
  const body = out.Body;
  if (!body) throw new Error("empty_body");
  const chunks: Buffer[] = [];
  // Node 22's stream from S3 SDK is an AsyncIterable<Uint8Array>.
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
