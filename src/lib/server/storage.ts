import "server-only";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import { connectDB, STORAGE_BUCKET } from "../db/supabase";

/**
 * Supabase Storage is the single attachment store (it replaces GridFS).
 *
 * Every object lives in the private `ticket-attachments` bucket, so it is only
 * reachable through `/api/files/[id]`, which enforces a session. That is the
 * whole point of routing downloads through the API: a public bucket or a
 * Cloudinary unsigned preset would leak the file to anyone holding the URL.
 *
 * The object's **path** is the file id stored on tickets/remarks. `storeBuffer`
 * keeps the original filename inside that path (after a `__` separator) so a
 * download can still set a sensible `Content-Disposition`.
 */

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

/** Separator between the generated id and the sanitised original filename. */
const NAME_SEPARATOR = "__";

export type StoredFile = {
  fileId: string;
  filename: string;
  contentType: string;
  size: number;
};

/** A single sanitised path segment (no slashes, no traversal). */
function safeSegment(value: string, max = 120): string {
  return value
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, max)
    .trim() || "attachment";
}

/**
 * Folder for an object, so attachments stay grouped per record.
 *
 * `tags.ticket` (e.g. an inbound webhook's message id or a ticket id) becomes
 * the folder name when present; everything else lands in `tickets/`.
 */
function folderFor(tags?: Record<string, string>): string {
  const raw = tags?.ticket ?? tags?.folder ?? "";
  const clean = safeSegment(raw, 40).replace(/[^\w-]/g, "");
  return clean ? `tickets/${clean}` : "tickets";
}

/** Rebuilds the display filename from an object path. */
function filenameFromPath(path: string): string {
  const last = path.split("/").pop() ?? "";
  const index = last.indexOf(NAME_SEPARATOR);
  const name = index >= 0 ? last.slice(index + NAME_SEPARATOR.length) : last;
  return name || "attachment";
}

/**
 * Validates a stored file id (an object path) before it reaches the storage API,
 * so a crafted id like `../../etc/passwd` can never escape the bucket.
 */
export function isValidFileId(value: string): boolean {
  if (!value || value.length > 400) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//")) return false;
  if (value.includes("..")) return false;
  return value.split("/").every((segment) => /^[A-Za-z0-9_.\-]+$/.test(segment));
}

/**
 * Uploads an in-memory buffer.
 *
 * The buffer is rejected *before* anything is written when the declared type or
 * size is out of policy, so an oversized or unexpected file never occupies
 * storage.
 */
export async function storeBuffer(params: {
  buffer: Buffer;
  filename: string;
  contentType: string;
  /** Free-form provenance, e.g. a `ticket` id that becomes the folder. */
  tags?: Record<string, string>;
}): Promise<StoredFile> {
  const { buffer, filename } = params;

  if (buffer.length === 0) {
    throw new Error("Cannot store an empty file.");
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(
      `File is too large. Maximum size is ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`,
    );
  }
  const contentType = params.contentType || "application/octet-stream";
  if (!ALLOWED_ATTACHMENT_TYPES.includes(contentType)) {
    throw new Error(`File type "${contentType}" is not allowed.`);
  }

  const supabase = await connectDB();
  const safeName = safeSegment(filename, 180);
  const path = `${folderFor(params.tags)}/${randomUUID()}${NAME_SEPARATOR}${safeName}`;

  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, buffer, {
    contentType,
    upsert: false,
  });
  if (error) throw new Error(`Attachment upload failed: ${error.message}`);

  return { fileId: path, filename: safeName, contentType, size: buffer.length };
}

export async function readFile(fileId: string): Promise<{
  stream: Readable;
  filename: string;
  contentType: string;
  size: number;
} | null> {
  if (!isValidFileId(fileId)) return null;

  const supabase = await connectDB();
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(fileId);
  if (error || !data) return null;

  const buffer = Buffer.from(await data.arrayBuffer());

  return {
    stream: Readable.from(buffer),
    filename: filenameFromPath(fileId),
    contentType: data.type || "application/octet-stream",
    size: buffer.length,
  };
}

export async function deleteFile(fileId: string): Promise<void> {
  if (!isValidFileId(fileId)) return;
  const supabase = await connectDB();
  await supabase.storage.from(STORAGE_BUCKET).remove([fileId]);
}

export { MAX_FILE_BYTES };
