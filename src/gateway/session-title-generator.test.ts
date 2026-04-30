import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveTitleProvider,
  sanitizeTitle,
  shouldAttemptTitleGen,
} from "./session-title-generator.js";

const cfg = (providers: Record<string, unknown>) =>
  ({ models: { providers } }) as unknown as OpenClawConfig;

describe("shouldAttemptTitleGen", () => {
  const NOW = 1_700_000_000_000;

  it("returns true when title is missing and no prior attempt", () => {
    expect(
      shouldAttemptTitleGen({
        existingTitle: undefined,
        lastAttemptAt: undefined,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("returns false when title already set", () => {
    expect(
      shouldAttemptTitleGen({
        existingTitle: "Quick chat",
        lastAttemptAt: undefined,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("treats whitespace-only title as missing", () => {
    expect(
      shouldAttemptTitleGen({
        existingTitle: "   ",
        lastAttemptAt: undefined,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("respects 6-hour cooldown after a failed attempt", () => {
    expect(
      shouldAttemptTitleGen({
        existingTitle: undefined,
        lastAttemptAt: NOW - 60 * 60 * 1000, // 1h ago
        now: NOW,
      }),
    ).toBe(false);
  });

  it("retries after the cooldown window has elapsed", () => {
    expect(
      shouldAttemptTitleGen({
        existingTitle: undefined,
        lastAttemptAt: NOW - 7 * 60 * 60 * 1000, // 7h ago
        now: NOW,
      }),
    ).toBe(true);
  });
});

describe("sanitizeTitle", () => {
  it("trims plain text", () => {
    expect(sanitizeTitle("  hello  ")).toBe("hello");
  });

  it("strips wrapping quotes", () => {
    expect(sanitizeTitle('"Project review"')).toBe("Project review");
    expect(sanitizeTitle("「项目甘特图」")).toBe("项目甘特图");
  });

  it("strips Title: prefix variants", () => {
    expect(sanitizeTitle("Title: Quick Chat")).toBe("Quick Chat");
    expect(sanitizeTitle("标题：周报草稿")).toBe("周报草稿");
  });

  it("collapses newlines", () => {
    expect(sanitizeTitle("Line 1\nLine 2")).toBe("Line 1 Line 2");
  });

  it("truncates to 16 chars with ellipsis (CJK-safe)", () => {
    const longCjk = "这是一个超长的中文标题用来测试截断功能是否正确"; // > 16
    const out = sanitizeTitle(longCjk);
    // Array.from-based length count on output, accounting for trailing ellipsis.
    expect(Array.from(out).length).toBeLessThanOrEqual(17);
    expect(out.endsWith("…")).toBe(true);
  });

  it("strips trailing punctuation", () => {
    expect(sanitizeTitle("Status update.")).toBe("Status update");
    expect(sanitizeTitle("项目进度。")).toBe("项目进度");
  });
});

describe("resolveTitleProvider", () => {
  it("prefers the session's own provider when openai-completions", () => {
    const c = cfg({
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        models: [{ id: "claude-x", api: "anthropic-messages" }],
      },
      deepseek: {
        baseUrl: "https://api.deepseek.com/v1",
        api: "openai-completions",
        models: [{ id: "deepseek-chat", api: "openai-completions" }],
      },
    });
    const res = resolveTitleProvider(c, "deepseek", "deepseek-chat");
    expect(res?.providerName).toBe("deepseek");
    expect(res?.model.id).toBe("deepseek-chat");
  });

  it("falls back to any openai-completions provider when session uses non-OAI api", () => {
    const c = cfg({
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        models: [{ id: "claude-x", api: "anthropic-messages" }],
      },
      kimi: {
        baseUrl: "https://api.moonshot.cn/v1",
        api: "openai-completions",
        models: [{ id: "moonshot-v1-8k", api: "openai-completions" }],
      },
    });
    const res = resolveTitleProvider(c, "anthropic", "claude-x");
    expect(res?.providerName).toBe("kimi");
  });

  it("returns null when no openai-completions provider exists", () => {
    const c = cfg({
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        models: [{ id: "claude-x", api: "anthropic-messages" }],
      },
    });
    expect(resolveTitleProvider(c, undefined, undefined)).toBeNull();
  });

  it("inherits provider api when model.api is missing", () => {
    const c = cfg({
      glm: {
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        api: "openai-completions",
        models: [{ id: "glm-4-flash" }], // no per-model api
      },
    });
    const res = resolveTitleProvider(c, undefined, undefined);
    expect(res?.providerName).toBe("glm");
    expect(res?.model.id).toBe("glm-4-flash");
  });
});
