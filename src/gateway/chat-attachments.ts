import fs from "node:fs/promises";
import path from "node:path";
import { estimateBase64DecodedBytes } from "../media/base64.js";
import { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";

export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: unknown;
};

export type ChatImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type ParsedMessageWithImages = {
  message: string;
  images: ChatImageContent[];
};

type AttachmentLog = {
  warn: (message: string) => void;
};

type NormalizedAttachment = {
  label: string;
  mime: string;
  base64: string;
};

function normalizeMime(mime?: string): string | undefined {
  if (!mime) {
    return undefined;
  }
  const cleaned = mime.split(";")[0]?.trim().toLowerCase();
  return cleaned || undefined;
}

function isImageMime(mime?: string): boolean {
  return typeof mime === "string" && mime.startsWith("image/");
}

function isValidBase64(value: string): boolean {
  // Minimal validation; avoid full decode allocations for large payloads.
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function normalizeAttachment(
  att: ChatAttachment,
  idx: number,
  opts: { stripDataUrlPrefix: boolean; requireImageMime: boolean },
): NormalizedAttachment {
  const mime = att.mimeType ?? "";
  const content = att.content;
  const label = att.fileName || att.type || `attachment-${idx + 1}`;

  if (typeof content !== "string") {
    throw new Error(`attachment ${label}: content must be base64 string`);
  }
  if (opts.requireImageMime && !mime.startsWith("image/")) {
    throw new Error(`attachment ${label}: only image/* supported`);
  }

  let base64 = content.trim();
  if (opts.stripDataUrlPrefix) {
    // Strip data URL prefix if present (e.g., "data:image/jpeg;base64,...").
    const dataUrlMatch = /^data:[^;]+;base64,(.*)$/.exec(base64);
    if (dataUrlMatch) {
      base64 = dataUrlMatch[1];
    }
  }
  return { label, mime, base64 };
}

function validateAttachmentBase64OrThrow(
  normalized: NormalizedAttachment,
  opts: { maxBytes: number },
): number {
  if (!isValidBase64(normalized.base64)) {
    throw new Error(`attachment ${normalized.label}: invalid base64 content`);
  }
  const sizeBytes = estimateBase64DecodedBytes(normalized.base64);
  if (sizeBytes <= 0 || sizeBytes > opts.maxBytes) {
    throw new Error(
      `attachment ${normalized.label}: exceeds size limit (${sizeBytes} > ${opts.maxBytes} bytes)`,
    );
  }
  return sizeBytes;
}

/**
 * Parse attachments and extract images as structured content blocks.
 * Returns the message text and an array of image content blocks
 * compatible with Claude API's image format.
 */
export async function parseMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: { maxBytes?: number; log?: AttachmentLog },
): Promise<ParsedMessageWithImages> {
  const maxBytes = opts?.maxBytes ?? 5_000_000; // decoded bytes (5,000,000)
  const log = opts?.log;
  if (!attachments || attachments.length === 0) {
    return { message, images: [] };
  }

  const images: ChatImageContent[] = [];

  for (const [idx, att] of attachments.entries()) {
    if (!att) {
      continue;
    }
    const normalized = normalizeAttachment(att, idx, {
      stripDataUrlPrefix: true,
      requireImageMime: false,
    });
    validateAttachmentBase64OrThrow(normalized, { maxBytes });
    const { base64: b64, label, mime } = normalized;

    const providedMime = normalizeMime(mime);
    const sniffedMime = normalizeMime(await sniffMimeFromBase64(b64));
    if (sniffedMime && !isImageMime(sniffedMime)) {
      log?.warn(`attachment ${label}: detected non-image (${sniffedMime}), dropping`);
      continue;
    }
    if (!sniffedMime && !isImageMime(providedMime)) {
      log?.warn(`attachment ${label}: unable to detect image mime type, dropping`);
      continue;
    }
    if (sniffedMime && providedMime && sniffedMime !== providedMime) {
      log?.warn(
        `attachment ${label}: mime mismatch (${providedMime} -> ${sniffedMime}), using sniffed`,
      );
    }

    images.push({
      type: "image",
      data: b64,
      mimeType: sniffedMime ?? providedMime ?? mime,
    });
  }

  return { message, images };
}

/**
 * @deprecated Use parseMessageWithAttachments instead.
 * This function converts images to markdown data URLs which Claude API cannot process as images.
 */
export function buildMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: { maxBytes?: number },
): string {
  const maxBytes = opts?.maxBytes ?? 2_000_000; // 2 MB
  if (!attachments || attachments.length === 0) {
    return message;
  }

  const blocks: string[] = [];

  for (const [idx, att] of attachments.entries()) {
    if (!att) {
      continue;
    }
    const normalized = normalizeAttachment(att, idx, {
      stripDataUrlPrefix: false,
      requireImageMime: true,
    });
    validateAttachmentBase64OrThrow(normalized, { maxBytes });
    const { base64, label, mime } = normalized;

    const safeLabel = label.replace(/\s+/g, "_");
    const dataUrl = `![${safeLabel}](data:${mime};base64,${base64})`;
    blocks.push(dataUrl);
  }

  if (blocks.length === 0) {
    return message;
  }
  const separator = message.trim().length > 0 ? "\n\n" : "";
  return `${message}${separator}${blocks.join("\n\n")}`;
}

// ============================================================================
// Non-image attachment support
//
// `parseMessageWithAttachments` handles images by passing them through as
// structured Claude/OpenAI vision blocks. Everything else (PDF, CSV, .py,
// .log, .docx …) used to be dropped with a "non-image" warning, which left
// users wondering why "请分析这个 PDF" returned "I haven't received any
// file." The fix: write each non-image attachment to a per-session
// subdirectory under the agent's workspace, then append a hint to the
// user's message telling the agent where to find them. The agent (claude
// code / codex / gemini) reads them via its normal `read` / `cat` tools.
// ============================================================================

const UPLOADS_SUBDIR = "uploads";
const NON_IMAGE_DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file

export type ExtractNonImageAttachmentsResult = {
  /** Absolute paths of files written to the workspace. */
  writtenPaths: string[];
  /** Per-attachment errors (oversize, decode failures). */
  errors: Array<{ label: string; error: string }>;
};

/** Strip path separators / nul / weird whitespace; keep CJK & ASCII. */
function sanitizeUploadFilename(raw: string, idx: number): string {
  // Drop any path components — only the basename (last segment) is kept.
  // `..` collapse plus path.join confinement at the call site cover
  // path-traversal, so explicit control-byte stripping is not load-bearing.
  const base = (raw || "").split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/\.\.+/g, ".").trim();
  if (!cleaned) {
    return `attachment-${idx + 1}.bin`;
  }
  // Cap length so absurd filenames don't blow ext4's 255-byte limit.
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

/** Make session keys safe as a dir name: `agent:main:web-XYZ` -> `agent_main_web-XYZ`. */
function sanitizeSessionKeyForFs(sessionKey: string): string {
  return (sessionKey || "session").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "session";
}

/**
 * Per-session uploads directory under the agent's workspace.
 * E.g. `~/.openclaw/workspace/uploads/agent_main_web-abc/`.
 * Caller is responsible for creating it (we do, via mkdir recursive).
 */
export function sessionUploadsDir(workspaceDir: string, sessionKey: string): string {
  return path.join(workspaceDir, UPLOADS_SUBDIR, sanitizeSessionKeyForFs(sessionKey));
}

/**
 * Write every non-image attachment to <workspaceDir>/uploads/<sessionKey>/<filename>.
 * Image attachments are skipped — `parseMessageWithAttachments` already handled them.
 *
 * Atomic: each file is written to a `.tmp` sibling then renamed, so a crash
 * mid-write never leaves a half-decoded PDF on disk.
 *
 * Failures (oversize, bad base64) are reported via the returned `errors`
 * array AND logged at warn level — they never throw.
 */
export async function extractNonImageAttachments(
  attachments: ChatAttachment[] | undefined,
  workspaceDir: string,
  sessionKey: string,
  opts?: { maxBytes?: number; log?: AttachmentLog },
): Promise<ExtractNonImageAttachmentsResult> {
  const result: ExtractNonImageAttachmentsResult = { writtenPaths: [], errors: [] };
  if (!attachments || attachments.length === 0 || !workspaceDir) {
    return result;
  }
  const maxBytes = opts?.maxBytes ?? NON_IMAGE_DEFAULT_MAX_BYTES;
  const log = opts?.log;

  const targetDir = sessionUploadsDir(workspaceDir, sessionKey);
  let dirReady = false;

  for (const [idx, att] of attachments.entries()) {
    if (!att) {
      continue;
    }
    const providedMime = normalizeMime(att.mimeType);
    if (providedMime && isImageMime(providedMime)) {
      continue; // images go through parseMessageWithAttachments
    }
    const label = att.fileName || att.type || `attachment-${idx + 1}`;
    let normalized: NormalizedAttachment;
    try {
      normalized = normalizeAttachment(att, idx, {
        stripDataUrlPrefix: true,
        requireImageMime: false,
      });
      validateAttachmentBase64OrThrow(normalized, { maxBytes });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn(`attachment ${label}: ${msg}`);
      result.errors.push({ label, error: msg });
      continue;
    }

    // Sniff to confirm it's truly not an image despite mime hint.
    const sniffedMime = normalizeMime(await sniffMimeFromBase64(normalized.base64));
    if (sniffedMime && isImageMime(sniffedMime)) {
      continue; // surprise image, let the image path handle it next round
    }

    if (!dirReady) {
      try {
        await fs.mkdir(targetDir, { recursive: true });
        dirReady = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log?.warn(`attachment ${label}: cannot create uploads dir (${msg})`);
        result.errors.push({ label, error: `mkdir failed: ${msg}` });
        return result; // no point trying further if dir is unwritable
      }
    }

    const safeName = sanitizeUploadFilename(normalized.label, idx);
    const finalPath = path.join(targetDir, safeName);
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
    try {
      await fs.writeFile(tmpPath, Buffer.from(normalized.base64, "base64"));
      await fs.rename(tmpPath, finalPath);
      result.writtenPaths.push(finalPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn(`attachment ${label}: write failed (${msg})`);
      result.errors.push({ label, error: msg });
      try {
        await fs.unlink(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }

  return result;
}

/**
 * Compose a hint to append to the user's message so the agent knows the
 * files exist and where to find them. Bilingual instruction so models that
 * default to either language pick it up.
 */
export function buildAttachmentHint(writtenPaths: string[]): string {
  if (writtenPaths.length === 0) {
    return "";
  }
  const list = writtenPaths.map((p) => `- ${p}`).join("\n");
  return [
    "",
    "",
    "[The following files have been saved to my workspace for you to read with your file tools / 以下文件已保存到我的工作区，请用你的读文件工具查看]:",
    list,
  ].join("\n");
}

/**
 * Best-effort cleanup of a session's uploads dir. Called from sessions.delete.
 * Failures are swallowed — the worst case is a few stranded files in a
 * subdirectory the user can manually rm.
 */
export async function cleanupSessionUploads(
  workspaceDir: string,
  sessionKey: string,
  log?: AttachmentLog,
): Promise<void> {
  if (!workspaceDir) {
    return;
  }
  const targetDir = sessionUploadsDir(workspaceDir, sessionKey);
  try {
    await fs.rm(targetDir, { recursive: true, force: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn(`uploads cleanup for ${sessionKey} failed: ${msg}`);
  }
}
