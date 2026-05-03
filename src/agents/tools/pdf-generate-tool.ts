import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm, copyFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { logDebug } from "../../logger.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { downloadsRoot } from "./ppt-tool.js";

// Generate a .pdf server-side by rendering HTML through headless Chrome
// (`google-chrome --headless --print-to-pdf`). Pairs with the existing
// /downloads/<token>/<filename> HTTP route and the iOS LinkPreviewCard's
// PDF-icon recognition. The agent should prefer this over hand-rolled
// bash + here-document scripts (which have failed repeatedly with
// EOF-delimiter / write-tool param errors in production).

const PdfSchema = Type.Object({
  title: Type.String({
    description:
      "Document title — used for the URL filename and as the visible <title> if html omits one.",
  }),
  html: Type.String({
    description:
      "Full HTML document to render. Include `<style>` blocks for typography / layout. Chrome prints what `@media print` says, so use `@page { size: A4; margin: 18mm; }` plus print-friendly styles. Embed images as data URIs or via absolute https:// URLs (the renderer is online).",
  }),
  filename: Type.Optional(
    Type.String({
      description: "Override download filename (defaults to `<sanitized title>.pdf`).",
    }),
  ),
});

const CHROME_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const CHROME_RENDER_TIMEOUT_MS = 60_000;

function publicBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const v = (env.OPENCLAW_PUBLIC_BASE_URL || "").trim();
  if (!v) {
    return undefined;
  }
  const httpsified = v.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
  return httpsified.replace(/\/+$/, "");
}

function slugify(input: string): string {
  const cleaned = input
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned || "document";
}

async function findChrome(): Promise<string> {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* not present */
    }
  }
  throw new Error(
    `pdf: no Chrome/Chromium binary found. Install google-chrome-stable on the gateway, or set the binary in one of: ${CHROME_CANDIDATES.join(", ")}.`,
  );
}

function runChromeToPdf(chromeBin: string, srcHtml: string, outPdf: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Headless Chrome accepts a file:// or data: URL. file:// is simpler;
    // Chrome reads from the temp HTML we just wrote. Flags chosen for
    // server-side rendering: --no-sandbox is required when running as
    // root or in some container modes; --disable-gpu skips a flake on
    // Linux without /dev/dri.
    const proc = spawn(
      chromeBin,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--no-pdf-header-footer",
        "--no-margins=false",
        `--print-to-pdf=${outPdf}`,
        `file://${srcHtml}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderrBuf = "";
    proc.stdout.on("data", () => {
      /* ignored */
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error(`pdf: chrome render timed out after ${CHROME_RENDER_TIMEOUT_MS}ms`));
    }, CHROME_RENDER_TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`pdf: chrome spawn failed: ${err.message}`, { cause: err }));
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const tail = stderrBuf.split("\n").slice(-5).join("\n");
        reject(new Error(`pdf: chrome exited code=${code}; stderr tail: ${tail}`));
      }
    });
  });
}

export function createPdfGenerateTool(): AnyAgentTool {
  return {
    label: "PDF Generator",
    name: "pdf_generate",
    description:
      "Generate a .pdf server-side from a full HTML document and return a tappable download URL. Provide `title` (used for the filename and URL slug) and `html` (a complete `<!DOCTYPE html>…</html>` document with inline `<style>`). Rendering uses headless Chrome's `--print-to-pdf`, so any CSS that targets `@media print` (especially `@page { size: A4; margin: …; }`) works the way it would in a desktop browser. Use this INSTEAD OF rolling your own `exec` + bash + here-document + python pipeline — those repeatedly fail in production with EOF and parameter errors. After calling this tool, include the returned `url` verbatim in your reply so the user gets a clickable PDF download card in chat.",
    parameters: PdfSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const title = readStringParam(params, "title", { required: true });
      const html = readStringParam(params, "html", { required: true });
      const overrideFilename = readStringParam(params, "filename");

      // Lightweight HTML sanity check — refuse partial fragments early so
      // the model gets a clear error instead of a Chrome about:blank PDF.
      const trimmed = html.trimStart().slice(0, 256).toLowerCase();
      if (!(trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html"))) {
        throw new Error(
          "pdf: `html` must be a complete HTML document starting with <!DOCTYPE html> or <html>. Got a fragment.",
        );
      }

      const chromeBin = await findChrome();

      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-"));
      const srcHtml = path.join(tmpDir, "src.html");
      const outPdf = path.join(tmpDir, "out.pdf");
      await writeFile(srcHtml, html, "utf8");

      try {
        await runChromeToPdf(chromeBin, srcHtml, outPdf);
      } catch (err) {
        // Best-effort cleanup before re-throwing
        await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }

      const filename = overrideFilename ? overrideFilename : `${slugify(title)}.pdf`;
      const token = crypto.randomBytes(16).toString("hex");
      const dir = path.join(downloadsRoot(), token);
      await mkdir(dir, { recursive: true });
      const dest = path.join(dir, filename);
      await copyFile(outPdf, dest);
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);

      const baseUrl = publicBaseUrl(process.env);
      const relPath = `/downloads/${token}/${encodeURIComponent(filename)}`;
      const url = baseUrl ? `${baseUrl}${relPath}` : relPath;

      logDebug(`[pdf_generate] rendered ${dest} via ${chromeBin}`);

      return jsonResult({
        ok: true,
        url,
        filename,
        title,
        hint: "Include `url` verbatim in your reply — that's the clickable PDF download link the user will tap.",
      });
    },
  };
}
