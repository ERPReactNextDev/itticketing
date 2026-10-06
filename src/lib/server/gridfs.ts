import "server-only";
import { Readable } from "stream";
import { GridFSBucket, GridFSFile, ObjectId, type MongoClient } from "mongodb";
import { connectDB } from "../db/mongoose";

/**
 * GridFS is the single attachment store. Replaces Supabase Storage and the
 * Cloudinary unsigned-preset uploads that previously bypassed the backend
 * entirely (those URLs leaked to the browser and had no access control).
 */

const BUCKET_NAME = "fs";
const MAX_FILE_BYTES = Number(process.env.MAX_ATTACHMENT_BYTES ?? 10 * 1024 * 1024);
export const ALLOWED_ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

let bucketPromise: Promise<GridFSBucket> | null = null;

async function getBucket(): Promise<GridFSBucket> {
  if (!bucketPromise) {
    bucketPromise = (async () => {
      const mongoose = await connectDB();
      const client = mongoose.connection.getClient() as unknown as MongoClient;
      return new GridFSBucket(client.db(), { bucketName: BUCKET_NAME });
    })();
  }
  return bucketPromise;
}

export type StoredFile = {
  fileId: string;
  filename: string;
  contentType: string;
  size: number;
};

/**
 * Streams an upload into GridFS.
 *
 * The stream is rejected *before* writing when the declared type or size is
 * out of policy, so an oversized or unexpected file never occupies storage.
 */
export async function storeBuffer(params: {
  buffer: Buffer;
  filename: string;
  contentType: string;
  /** Free-form provenance, e.g. `ticket:<id>`, `proof-of-completion`. */
  tags?: Record<string, string>;
}): Promise<StoredFile> {
  const { buffer, filename, contentType } = params;

  if (buffer.length === 0) {
    throw new Error("Cannot store an empty file.");
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(
      `File is too large. Maximum size is ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`,
    );
  }
  const effectiveType = contentType || "application/octet-stream";
  if (!ALLOWED_ATTACHMENT_TYPES.includes(effectiveType)) {
    throw new Error(`File type "${effectiveType}" is not allowed.`);
  }

  const bucket = await getBucket();
  const safeName = filename.replace(/[^\w.\- ]+/g, "_").slice(0, 180);
  const fileId = new ObjectId();

  await new Promise<void>((resolve, reject) => {
    const upload = bucket.openUploadStreamWithId(fileId, safeName, {
      // mongodb v7 has no top-level `contentType` on the file document, so the
      // MIME type is carried inside `metadata` and read back from there.
      metadata: {
        contentType: effectiveType,
        uploadedAt: new Date(),
        ...(params.tags ?? {}),
      },
    });
    Readable.from(buffer)
      .pipe(upload)
      .on("error", reject)
      .on("finish", () => resolve());
  });

  return {
    fileId: String(fileId),
    filename: safeName,
    contentType: effectiveType,
    size: buffer.length,
  };
}

export async function readFile(fileId: string): Promise<{
  stream: Readable;
  filename: string;
  contentType: string;
  size: number;
} | null> {
  let id: ObjectId;
  try {
    id = new ObjectId(fileId);
  } catch {
    return null;
  }

  const bucket = await getBucket();

  // Read the file document once: existence, metadata and length together.
  const file = await new Promise<GridFSFile | null>((resolve) => {
    bucket
      .find({ _id: id })
      .limit(1)
      .next()
      .then((doc) => resolve((doc as GridFSFile | null) ?? null))
      .catch(() => resolve(null));
  });
  if (!file) return null;

  const metadata = (file.metadata ?? {}) as { contentType?: string };

  return {
    stream: bucket.openDownloadStream(id),
    filename: file.filename ?? "attachment",
    contentType: metadata.contentType ?? "application/octet-stream",
    size: file.length ?? 0,
  };
}

export async function deleteFile(fileId: string): Promise<void> {
  let id: ObjectId;
  try {
    id = new ObjectId(fileId);
  } catch {
    return;
  }
  const bucket = await getBucket();
  await bucket.delete(id).catch(() => undefined);
}

/** True when the ObjectId string is well-formed. */
export function isValidFileId(value: string): boolean {
  return ObjectId.isValid(value) && String(new ObjectId(value)) === value;
}

export { MAX_FILE_BYTES };