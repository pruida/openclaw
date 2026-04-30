import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAttachmentHint,
  buildMessageWithAttachments,
  type ChatAttachment,
  cleanupSessionUploads,
  extractNonImageAttachments,
  parseMessageWithAttachments,
  sessionUploadsDir,
} from "./chat-attachments.js";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

async function parseWithWarnings(message: string, attachments: ChatAttachment[]) {
  const logs: string[] = [];
  const parsed = await parseMessageWithAttachments(message, attachments, {
    log: { warn: (warning) => logs.push(warning) },
  });
  return { parsed, logs };
}

describe("buildMessageWithAttachments", () => {
  it("embeds a single image as data URL", () => {
    const msg = buildMessageWithAttachments("see this", [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "dot.png",
        content: PNG_1x1,
      },
    ]);
    expect(msg).toContain("see this");
    expect(msg).toContain(`data:image/png;base64,${PNG_1x1}`);
    expect(msg).toContain("![dot.png]");
  });

  it("rejects non-image mime types", () => {
    const bad: ChatAttachment = {
      type: "file",
      mimeType: "application/pdf",
      fileName: "a.pdf",
      content: "AAA",
    };
    expect(() => buildMessageWithAttachments("x", [bad])).toThrow(/image/);
  });
});

describe("parseMessageWithAttachments", () => {
  it("strips data URL prefix", async () => {
    const parsed = await parseMessageWithAttachments(
      "see this",
      [
        {
          type: "image",
          mimeType: "image/png",
          fileName: "dot.png",
          content: `data:image/png;base64,${PNG_1x1}`,
        },
      ],
      { log: { warn: () => {} } },
    );
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
  });

  it("sniffs mime when missing", async () => {
    const { parsed, logs } = await parseWithWarnings("see this", [
      {
        type: "image",
        fileName: "dot.png",
        content: PNG_1x1,
      },
    ]);
    expect(parsed.message).toBe("see this");
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
    expect(logs).toHaveLength(0);
  });

  it("drops non-image payloads and logs", async () => {
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    const { parsed, logs } = await parseWithWarnings("x", [
      {
        type: "file",
        mimeType: "image/png",
        fileName: "not-image.pdf",
        content: pdf,
      },
    ]);
    expect(parsed.images).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/non-image/i);
  });

  it("prefers sniffed mime type and logs mismatch", async () => {
    const { parsed, logs } = await parseWithWarnings("x", [
      {
        type: "image",
        mimeType: "image/jpeg",
        fileName: "dot.png",
        content: PNG_1x1,
      },
    ]);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/mime mismatch/i);
  });

  it("drops unknown mime when sniff fails and logs", async () => {
    const unknown = Buffer.from("not an image").toString("base64");
    const { parsed, logs } = await parseWithWarnings("x", [
      { type: "file", fileName: "unknown.bin", content: unknown },
    ]);
    expect(parsed.images).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/unable to detect image mime type/i);
  });

  it("keeps valid images and drops invalid ones", async () => {
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    const { parsed, logs } = await parseWithWarnings("x", [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "dot.png",
        content: PNG_1x1,
      },
      {
        type: "file",
        mimeType: "image/png",
        fileName: "not-image.pdf",
        content: pdf,
      },
    ]);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
    expect(logs.some((l) => /non-image/i.test(l))).toBe(true);
  });
});

describe("shared attachment validation", () => {
  it("rejects invalid base64 content for both builder and parser", async () => {
    const bad: ChatAttachment = {
      type: "image",
      mimeType: "image/png",
      fileName: "dot.png",
      content: "%not-base64%",
    };

    expect(() => buildMessageWithAttachments("x", [bad])).toThrow(/base64/i);
    await expect(
      parseMessageWithAttachments("x", [bad], { log: { warn: () => {} } }),
    ).rejects.toThrow(/base64/i);
  });

  it("rejects images over limit for both builder and parser without decoding base64", async () => {
    const big = "A".repeat(10_000);
    const att: ChatAttachment = {
      type: "image",
      mimeType: "image/png",
      fileName: "big.png",
      content: big,
    };

    const fromSpy = vi.spyOn(Buffer, "from");
    try {
      expect(() => buildMessageWithAttachments("x", [att], { maxBytes: 16 })).toThrow(
        /exceeds size limit/i,
      );
      await expect(
        parseMessageWithAttachments("x", [att], { maxBytes: 16, log: { warn: () => {} } }),
      ).rejects.toThrow(/exceeds size limit/i);
      const base64Calls = fromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64");
      expect(base64Calls).toHaveLength(0);
    } finally {
      fromSpy.mockRestore();
    }
  });
});

describe("extractNonImageAttachments", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocw-uploads-"));
  });
  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  // Helper: encode a Buffer to base64.
  const b64 = (buf: Buffer | string) => Buffer.from(buf).toString("base64");

  it("writes a PDF attachment to <workspace>/uploads/<sessionKey>/<filename>", async () => {
    // Minimal valid-ish PDF byte signature so the mime-sniffer doesn't think it's an image.
    const pdfBytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0x20)]);
    const att: ChatAttachment = {
      type: "file",
      mimeType: "application/pdf",
      fileName: "report.pdf",
      content: b64(pdfBytes),
    };
    const out = await extractNonImageAttachments([att], workspaceDir, "agent:main:web-abc");
    expect(out.errors).toEqual([]);
    expect(out.writtenPaths).toHaveLength(1);
    const target = out.writtenPaths[0];
    expect(target).toContain(path.join("uploads", "agent_main_web-abc", "report.pdf"));
    const written = await fs.readFile(target);
    expect(written.equals(pdfBytes)).toBe(true);
  });

  it("skips attachments whose mime is image/*", async () => {
    const att: ChatAttachment = {
      type: "image",
      mimeType: "image/png",
      fileName: "x.png",
      content: PNG_1x1,
    };
    const out = await extractNonImageAttachments([att], workspaceDir, "s1");
    expect(out.writtenPaths).toEqual([]);
  });

  it("strips path-traversal segments from the filename", async () => {
    const att: ChatAttachment = {
      type: "file",
      mimeType: "text/plain",
      fileName: "../../etc/passwd",
      content: b64("hello"),
    };
    const out = await extractNonImageAttachments([att], workspaceDir, "s1");
    expect(out.writtenPaths).toHaveLength(1);
    // Path must stay inside our uploads dir.
    expect(out.writtenPaths[0].startsWith(workspaceDir)).toBe(true);
    expect(out.writtenPaths[0]).not.toContain("etc/passwd");
  });

  it("rejects oversize attachments via the errors array (no throw)", async () => {
    const att: ChatAttachment = {
      type: "file",
      mimeType: "text/plain",
      fileName: "big.txt",
      content: b64(Buffer.alloc(1024, 0x41)),
    };
    const out = await extractNonImageAttachments([att], workspaceDir, "s1", {
      maxBytes: 100,
    });
    expect(out.writtenPaths).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].error).toMatch(/exceeds size limit/);
  });

  it("returns empty when given empty inputs (early-exits)", async () => {
    expect(await extractNonImageAttachments([], workspaceDir, "s")).toEqual({
      writtenPaths: [],
      errors: [],
    });
    expect(await extractNonImageAttachments(undefined, workspaceDir, "s")).toEqual({
      writtenPaths: [],
      errors: [],
    });
    expect(await extractNonImageAttachments([{ content: "AAAA" }], "", "s")).toEqual({
      writtenPaths: [],
      errors: [],
    });
  });
});

describe("buildAttachmentHint", () => {
  it("produces empty string for no paths", () => {
    expect(buildAttachmentHint([])).toBe("");
  });
  it("includes every path on its own line", () => {
    const out = buildAttachmentHint(["/tmp/a.pdf", "/tmp/b.csv"]);
    expect(out).toContain("/tmp/a.pdf");
    expect(out).toContain("/tmp/b.csv");
    expect(out).toMatch(/workspace/i);
  });
});

describe("sessionUploadsDir", () => {
  it("sanitizes colon-separated session keys for filesystem use", () => {
    const dir = sessionUploadsDir("/tmp/ws", "agent:main:web-abc");
    expect(dir).toBe(path.join("/tmp/ws", "uploads", "agent_main_web-abc"));
  });
});

describe("cleanupSessionUploads", () => {
  it("removes the per-session uploads dir if it exists", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "ocw-cleanup-"));
    try {
      const dir = sessionUploadsDir(ws, "s1");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "x.txt"), "hi");
      await cleanupSessionUploads(ws, "s1");
      await expect(fs.stat(dir)).rejects.toThrow();
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
  it("is a no-op when the dir doesn't exist (no throw)", async () => {
    await expect(cleanupSessionUploads("/nonexistent", "s")).resolves.toBeUndefined();
  });
});
