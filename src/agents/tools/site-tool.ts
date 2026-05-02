import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { logDebug } from "../../logger.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// Generates a static single-page website server-side and returns a browse
// URL the user can tap to view it. Pairs with the GET /sites/<token>/[path]
// route in src/gateway/server-http.ts. Each site lives under its own token
// directory so the model can write index.html plus any number of relative
// asset files (styles.css, app.js, images, …) without colliding with other
// generated sites.
//
// Compared to the `ppt` tool, the response Content-Type matches the file
// extension and we skip Content-Disposition so the browser renders rather
// than downloading. Token is the access-control: 32 random hex chars,
// non-guessable, no auth header required.

const SiteFileSchema = Type.Object({
  path: Type.String({
    description:
      'Relative path inside the site root (e.g. "styles.css", "img/hero.svg"). Must not start with / and must not contain `..`. The main page must be named `index.html`.',
  }),
  content: Type.String({
    description:
      'Plain text contents of the file. For binary assets, base64-encode and decorate the path with `.base64` (e.g. "hero.png.base64"); the server strips that suffix before saving.',
  }),
});

const SiteSchema = Type.Object({
  title: Type.String({
    description:
      "Site title — used for the URL slug and as the visible <title> if you don't set one.",
  }),
  html: Type.Optional(
    Type.String({
      description:
        "Full inline HTML document — `<!DOCTYPE html>` through `</html>`, with `<style>` / `<script>` blocks embedded. Recommended for one-shot landing pages. If supplied, it is saved as index.html and `files` is ignored.",
    }),
  ),
  files: Type.Optional(
    Type.Array(SiteFileSchema, {
      description:
        'Multi-file alternative. Provide an array of {path, content} entries; one of them MUST be path="index.html". Use this when you want to split styles.css / app.js out of the main page or include extra subpages.',
    }),
  ),
});

const TOKEN_BYTES = 16;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // per-file cap; total site is bounded by sum of these
const MAX_FILES_PER_SITE = 20;

export function sitesRoot(): string {
  return path.join(os.homedir(), ".openclaw", "sites");
}

function publicBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const v = (env.OPENCLAW_PUBLIC_BASE_URL || "").trim();
  if (!v) {
    return undefined;
  }
  const httpsified = v.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
  return httpsified.replace(/\/+$/, "");
}

function sanitizeRelPath(raw: string): string | null {
  // Strip leading /, reject .. segments, reject NUL/backslash, reject empty.
  const trimmed = raw.replace(/^\/+/, "");
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes("..") || trimmed.includes("\0") || trimmed.includes("\\")) {
    return null;
  }
  // Disallow absolute-feeling paths via Windows drive letters even on linux.
  if (/^[A-Za-z]:/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

interface SiteFileInput {
  path: string;
  content: string;
}

export function createSiteTool(): AnyAgentTool {
  return {
    label: "Website Generator",
    name: "site",
    description:
      'Build a static website server-side and return a browse URL. Two input modes: (a) `html` — a single inline HTML document (most common), saved as index.html; (b) `files` — an array of {path, content} for multi-file sites with separate stylesheets / scripts / subpages. The site is hosted at a random URL token and rendered live in the browser when the user taps the returned `url`. Include `<meta property="og:title">` and `<meta property="og:image">` in your HTML for a richer link-preview card in chat. After calling this tool, include the returned `url` verbatim in your reply so the user gets a clickable link.',
    parameters: SiteSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const title = readStringParam(params, "title", { required: true });
      const html = readStringParam(params, "html");
      const filesRaw = Array.isArray(params.files) ? (params.files as unknown[]) : [];

      let files: SiteFileInput[];
      if (html) {
        files = [{ path: "index.html", content: html }];
      } else {
        if (filesRaw.length === 0) {
          throw new Error("site: provide either `html` or a non-empty `files` array");
        }
        if (filesRaw.length > MAX_FILES_PER_SITE) {
          throw new Error(`site: too many files (max ${MAX_FILES_PER_SITE})`);
        }
        files = filesRaw.map((raw, idx) => {
          const f = raw as { path?: unknown; content?: unknown };
          if (typeof f.path !== "string" || typeof f.content !== "string") {
            throw new Error(`site: files[${idx}] must have string path and content`);
          }
          return { path: f.path, content: f.content };
        });
        if (!files.some((f) => f.path.replace(/^\/+/, "") === "index.html")) {
          throw new Error('site: files[] must include an "index.html" entry');
        }
      }

      const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
      const dir = path.join(sitesRoot(), token);
      await mkdir(dir, { recursive: true });

      let totalBytes = 0;
      for (const f of files) {
        const isBase64 = f.path.endsWith(".base64");
        const cleanPath = sanitizeRelPath(isBase64 ? f.path.slice(0, -".base64".length) : f.path);
        if (!cleanPath) {
          throw new Error(`site: invalid file path: ${f.path}`);
        }
        const buffer = isBase64 ? Buffer.from(f.content, "base64") : Buffer.from(f.content, "utf8");
        if (buffer.length > MAX_FILE_BYTES) {
          throw new Error(`site: ${cleanPath} exceeds per-file cap (${MAX_FILE_BYTES} bytes)`);
        }
        totalBytes += buffer.length;
        const outPath = path.join(dir, cleanPath);
        // Ensure subdirectories exist for nested paths like "img/hero.svg".
        await mkdir(path.dirname(outPath), { recursive: true });
        // Defense in depth: re-resolve and verify still inside the token dir.
        const resolved = path.resolve(outPath);
        if (!resolved.startsWith(`${dir}${path.sep}`) && resolved !== path.join(dir, cleanPath)) {
          throw new Error(`site: refused write outside site root: ${cleanPath}`);
        }
        await writeFile(outPath, buffer);
      }

      const baseUrl = publicBaseUrl(process.env);
      // Trailing slash matters: `/sites/<token>/` resolves to index.html and
      // makes relative asset URLs (./styles.css) work as the model expects.
      const relPath = `/sites/${token}/`;
      const url = baseUrl ? `${baseUrl}${relPath}` : relPath;

      logDebug(`[site] wrote ${files.length} file(s), ${totalBytes} bytes total, token=${token}`);

      return jsonResult({
        ok: true,
        url,
        title,
        token,
        fileCount: files.length,
        totalBytes,
        hint: "Include `url` verbatim in your reply — that's the clickable link the user will tap to open the site.",
      });
    },
  };
}
