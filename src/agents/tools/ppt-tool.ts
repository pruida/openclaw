import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
// pptxgenjs ships dual class+namespace types (`export as namespace …` plus
// `export default …`). Under NodeNext + esModuleInterop, TypeScript resolves
// the default-import binding as the *namespace*, not the class, so a direct
// `new PptxGen()` won't typecheck. Runtime is fine — the CJS module does
// `module.exports = PptxGenJS` and the constructor is right there. We grab
// it via a typed-any escape hatch.
import * as pptxgenjsNs from "pptxgenjs";
import { logDebug } from "../../logger.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PptxGenCtor: new () => any = (pptxgenjsNs as unknown as { default: new () => unknown })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .default as any;

// Generates a .pptx server-side and returns a download URL the client can
// tap. We keep one shared downloads directory under ~/.openclaw/downloads/
// so the HTTP stage in server-http.ts has a fixed root to stat against;
// the per-file random token is the access control. Files are not garbage-
// collected here — disk-guard.sh prunes the parent ~/.openclaw if the FS
// goes over its quota, which is good enough for personal-scale use.

const SlideSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "Slide title shown at the top." })),
  body: Type.Optional(
    Type.String({
      description: "Single paragraph body text. Ignored if `bullets` is also supplied.",
    }),
  ),
  bullets: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "One entry per bullet point. Each string is rendered as one line in a bulleted list.",
    }),
  ),
});

const PptSchema = Type.Object({
  title: Type.String({
    description: "Presentation title — also used for the cover slide and filename.",
  }),
  author: Type.Optional(
    Type.String({ description: "Cover slide author byline. Defaults to OpenClaw." }),
  ),
  subtitle: Type.Optional(
    Type.String({ description: "Subtitle shown beneath the title on the cover." }),
  ),
  slides: Type.Array(SlideSchema, {
    description:
      "Content slides. Each has an optional title plus either bullets or a body paragraph.",
    minItems: 1,
  }),
});

function slugify(input: string): string {
  // ASCII-only slug for the URL/filename. CJK titles get stripped to a
  // generic fallback ("presentation"); the original title still appears
  // verbatim on the cover slide. Cap at 40 chars so the URL stays short.
  const cleaned = input
    .normalize("NFKD")
    .replace(/[^ -]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || "presentation";
}

export function downloadsRoot(): string {
  return path.join(os.homedir(), ".openclaw", "downloads");
}

function publicBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const v = (env.OPENCLAW_PUBLIC_BASE_URL || "").trim();
  if (!v) {
    return undefined;
  }
  // Allow the env to be either https://host or wss://host (matches the WS
  // base most operators already have configured); normalize to https://.
  const httpsified = v.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
  return httpsified.replace(/\/+$/, "");
}

export function createPptTool(): AnyAgentTool {
  return {
    label: "PowerPoint Generator",
    name: "ppt",
    description:
      "Generate a .pptx (PowerPoint) presentation server-side and return a download URL. Provide a title and an array of slides; each slide can have a title plus either a bullet list or a body paragraph. The file is hosted at a random URL token — only the user holding the URL can download it. After calling this tool, include the returned `url` verbatim in your reply so the user gets a clickable link.",
    parameters: PptSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const title = readStringParam(params, "title", { required: true });
      const author = readStringParam(params, "author") || "OpenClaw";
      const subtitle = readStringParam(params, "subtitle");
      const rawSlides = Array.isArray(params.slides) ? params.slides : [];
      if (rawSlides.length === 0) {
        throw new Error("ppt: at least one slide required");
      }

      const pres = new PptxGenCtor();
      pres.author = author;
      pres.title = title;

      const cover = pres.addSlide();
      cover.background = { color: "1A1A2E" };
      cover.addText(title, {
        x: 0.5,
        y: 1.5,
        w: 9,
        h: 1.4,
        fontSize: 36,
        bold: true,
        color: "FFFFFF",
        align: "center",
      });
      if (subtitle) {
        cover.addText(subtitle, {
          x: 0.5,
          y: 3.0,
          w: 9,
          h: 0.6,
          fontSize: 18,
          color: "AABBFF",
          align: "center",
        });
      }
      cover.addText(author, {
        x: 0.5,
        y: 6.5,
        w: 9,
        h: 0.4,
        fontSize: 12,
        color: "888888",
        align: "center",
      });

      for (const raw of rawSlides) {
        const s = raw as { title?: unknown; body?: unknown; bullets?: unknown };
        const slide = pres.addSlide();
        if (typeof s.title === "string" && s.title.trim()) {
          slide.addText(s.title.trim(), {
            x: 0.5,
            y: 0.4,
            w: 9,
            h: 0.8,
            fontSize: 28,
            bold: true,
            color: "1A1A2E",
          });
        }
        const bullets = Array.isArray(s.bullets)
          ? s.bullets.filter((b): b is string => typeof b === "string" && b.length > 0)
          : [];
        if (bullets.length > 0) {
          slide.addText(
            bullets.map((b) => ({
              text: b,
              options: { bullet: true, fontSize: 18 },
            })),
            { x: 0.7, y: 1.5, w: 8.6, h: 5.5, color: "333333" },
          );
        } else if (typeof s.body === "string" && s.body.trim()) {
          slide.addText(s.body.trim(), {
            x: 0.7,
            y: 1.5,
            w: 8.6,
            h: 5.5,
            fontSize: 18,
            color: "333333",
            paraSpaceAfter: 12,
          });
        }
      }

      const token = crypto.randomBytes(16).toString("hex");
      const filename = `${slugify(title)}.pptx`;
      const dir = path.join(downloadsRoot(), token);
      await mkdir(dir, { recursive: true });
      const filePath = path.join(dir, filename);

      // outputType="nodebuffer" guarantees a Node Buffer at runtime; the
      // upstream type union still covers browser/blob, so narrow defensively.
      const written = await pres.write({ outputType: "nodebuffer" });
      let buffer: Buffer;
      if (Buffer.isBuffer(written)) {
        buffer = written;
      } else if (written instanceof Uint8Array) {
        buffer = Buffer.from(written.buffer, written.byteOffset, written.byteLength);
      } else if (written instanceof ArrayBuffer) {
        buffer = Buffer.from(new Uint8Array(written));
      } else {
        throw new Error(`ppt: unexpected write() output type ${typeof written}`);
      }
      await writeFile(filePath, buffer);

      const baseUrl = publicBaseUrl(process.env);
      const relPath = `/downloads/${token}/${encodeURIComponent(filename)}`;
      const url = baseUrl ? `${baseUrl}${relPath}` : relPath;

      logDebug(`[ppt] wrote ${filePath} (${buffer.length} bytes), token=${token}`);

      return jsonResult({
        ok: true,
        url,
        filename,
        sizeBytes: buffer.length,
        slideCount: 1 + rawSlides.length,
        title,
        hint: "Include `url` verbatim in your reply — that's the clickable download link the user will see in the chat.",
      });
    },
  };
}
