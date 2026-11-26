/**
 * Prompt attachments uploaded to the daemon (`PUT /v2/uploads`): the
 * composer sends dropped and pasted files, and long pasted text as
 * Markdown, to `/tmp/todex/file` on the backend's machine and names the
 * returned path in the prompt. A client on the daemon's own machine may
 * instead register a file it already has on disk (`POST /v2/uploads/link`),
 * so the prompt names the original file and nothing is copied.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { PromptContentRef } from './v2';

/** Chunk size and per-file limit of `PUT /v2/uploads`. */
export const PROMPT_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const PROMPT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** Pasted text this long or shorter on one line is typed in as is. */
export const PASTED_TEXT_INLINE_MAX_CHARS = 80;
/** Longer pasted text up to this many characters becomes a text capsule;
 * beyond it the text is uploaded as a Markdown file. */
export const PASTED_TEXT_CAPSULE_MAX_CHARS = 1000;

/** Decoded image bytes one prompt may carry as images (the daemon's limit). */
export const PROMPT_IMAGE_BUDGET_BYTES = 10 * 1024 * 1024;
/** Uploaded images the daemon can hand to the model as an image. */
export const PROMPT_IMAGE_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export type PromptUploadChunkResult = {
  uploadId: string;
  /** Absolute path on the daemon's machine. */
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

/** How much of a file `POST /v2/uploads/link` fingerprints (the daemon's
 * `LINK_FINGERPRINT_BYTES`); the whole file when it is smaller. */
export const PROMPT_LINK_FINGERPRINT_BYTES = 64 * 1024;

/** `POST /v2/uploads/link`: a file on the client's disk, which the daemon
 * checks is the same file on its own machine. */
export type PromptLinkRequest = {
  /** Absolute path, as the daemon sees it (mapped into a container). */
  path: string;
  sizeBytes: number;
  /** {@link promptLinkFingerprint} of the file's head. */
  headSha256: string;
  conversationId?: string;
};

/** Lowercase hex SHA-256 of `head`, the file's first
 * {@link PROMPT_LINK_FINGERPRINT_BYTES} (longer input is cut). */
export function promptLinkFingerprint(head: Uint8Array): string {
  return bytesToHex(sha256(head.subarray(0, PROMPT_LINK_FINGERPRINT_BYTES)));
}

/** Characters as the user counts them: code points, not UTF-16 units. */
export function textLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export type PastedTextDisposition = 'inline' | 'capsule' | 'file';

/** How the composer takes pasted or dropped text. */
export function pastedTextDisposition(text: string): PastedTextDisposition {
  const trimmed = text.replace(/\n+$/, '');
  const length = textLength(trimmed);
  if (!trimmed.includes('\n') && length <= PASTED_TEXT_INLINE_MAX_CHARS) return 'inline';
  return length <= PASTED_TEXT_CAPSULE_MAX_CHARS ? 'capsule' : 'file';
}

/** Whether a failed first chunk means the daemon predates `/v2/uploads`:
 * axum answers an unknown route with a bare 404, while the route itself
 * reports missing uploads with a `NOT_FOUND` code. */
export function isPromptUploadUnsupported(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { httpStatus, backendCode } = error as { httpStatus?: unknown; backendCode?: unknown };
  return (httpStatus === 404 || httpStatus === 405) && !backendCode;
}

/** The prompt item for an uploaded file. `imageBudget` holds the image bytes
 * already in the prompt; a supported image that still fits is sent as
 * `localImage` (the model sees it, and the daemon adds its path), anything
 * else as a `file` reference. */
export function uploadedPromptContent(
  upload: { path: string; name: string; mimeType: string; sizeBytes: number | null },
  imageBudget: { used: number },
): PromptContentRef {
  const size = upload.sizeBytes ?? Number.POSITIVE_INFINITY;
  if (PROMPT_IMAGE_MIME_TYPES.includes(upload.mimeType.toLowerCase()) && imageBudget.used + size <= PROMPT_IMAGE_BUDGET_BYTES) {
    imageBudget.used += size;
    return { type: 'localImage', path: upload.path };
  }
  return { type: 'file', path: upload.path, name: upload.name };
}
