// Best-effort AI session title generator.
//
// Fires after a chat.final to summarize the first user/assistant exchange into
// a short title (≤ 16 chars), then writes it back into SessionEntry. Failures
// are silently swallowed: titles are a UX nicety, never mission-critical.
//
// Strategy: re-uses whichever openai-completions provider the session is
// already configured to use. If the session's provider is non-OpenAI-compat
// (anthropic, ollama, …), we just skip — clients fall back to derivedTitle.

import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import { logWarn } from "../logger.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";

const TITLE_MAX_CHARS = 16;
const TITLE_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h
const FETCH_TIMEOUT_MS = 15_000;

const TITLE_SYSTEM_PROMPT =
  "Generate a concise title (≤ 12 chars, no quotes, no punctuation) summarizing this conversation. " +
  "Use the same language as the user. Reply with ONLY the title, nothing else.";

export type GenerateTitleParams = {
  cfg: OpenClawConfig;
  /** Resolved model id from the session (e.g. "deepseek-chat"). May be undefined. */
  sessionModel?: string;
  /** Resolved provider name from the session (e.g. "deepseek"). May be undefined. */
  sessionProviderName?: string;
  firstUserMessage: string;
  firstAssistantMessage: string;
};

export type ResolvedTitleProvider = {
  providerName: string;
  provider: ModelProviderConfig;
  model: ModelDefinitionConfig;
};

/**
 * Pick a provider+model to drive title generation. Prefers the session's own
 * provider; falls back to the first openai-completions provider with a model.
 */
export function resolveTitleProvider(
  cfg: OpenClawConfig,
  sessionProviderName: string | undefined,
  sessionModelId: string | undefined,
): ResolvedTitleProvider | null {
  const providers = cfg.models?.providers ?? {};
  const candidates: Array<[string, ModelProviderConfig]> = [];

  if (sessionProviderName && providers[sessionProviderName]) {
    candidates.push([sessionProviderName, providers[sessionProviderName]]);
  }
  for (const [name, prov] of Object.entries(providers)) {
    if (name !== sessionProviderName) {
      candidates.push([name, prov]);
    }
  }

  for (const [name, prov] of candidates) {
    const provApi = prov.api;
    const baseUrl = (prov.baseUrl ?? "").trim();
    if (!baseUrl) {
      continue;
    }

    const matchingModel =
      (sessionModelId &&
        prov.models?.find(
          (m) => m.id === sessionModelId && (m.api ?? provApi) === "openai-completions",
        )) ||
      prov.models?.find((m) => (m.api ?? provApi) === "openai-completions");

    if (matchingModel) {
      return { providerName: name, provider: prov, model: matchingModel };
    }
  }
  return null;
}

function buildCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/chat/completions`;
}

export function sanitizeTitle(raw: string): string {
  let s = raw.trim();
  // Drop newlines first; some models reply with multi-line "Title:\n  <title>".
  s = s.replace(/\s*\n+\s*/g, " ").trim();
  // Strip "Title:" / "标题:" / "题目:" prefixes (case-insensitive).
  s = s.replace(/^(title|标题|题目|主题)\s*[:：-]\s*/i, "").trim();
  // Strip wrapping quotes/backticks (ASCII + CJK).
  s = s.replace(/^["'`「『《“'']+|["'`」』》”'']+$/g, "").trim();
  // Strip leading markdown noise.
  s = s.replace(/^[*\-•·#>\s]+/, "").trim();
  // Trailing punctuation that often leaks in.
  s = s.replace(/[。.！!？?,，;；:：]+$/g, "").trim();
  // Truncate (Array.from is unicode-safe — emoji/CJK each count as 1).
  const codepoints = Array.from(s);
  if (codepoints.length > TITLE_MAX_CHARS) {
    s = `${codepoints.slice(0, TITLE_MAX_CHARS).join("")}…`;
  }
  return s;
}

export function shouldAttemptTitleGen(params: {
  existingTitle: string | undefined;
  lastAttemptAt: number | undefined;
  now: number;
}): boolean {
  if (params.existingTitle && params.existingTitle.trim().length > 0) {
    return false;
  }
  if (
    typeof params.lastAttemptAt === "number" &&
    Number.isFinite(params.lastAttemptAt) &&
    params.now - params.lastAttemptAt < TITLE_RETRY_COOLDOWN_MS
  ) {
    return false;
  }
  return true;
}

/**
 * Calls the resolved provider's openai-completions endpoint to generate a
 * short title. Returns sanitized title or null on any failure.
 */
export async function generateSessionTitle(params: GenerateTitleParams): Promise<string | null> {
  const resolved = resolveTitleProvider(
    params.cfg,
    params.sessionProviderName,
    params.sessionModel,
  );
  if (!resolved) {
    return null;
  }

  const apiKey = normalizeSecretInput(resolved.provider.apiKey);
  if (!apiKey) {
    return null;
  }

  const url = buildCompletionsUrl(resolved.provider.baseUrl);
  const userPrompt = [
    `User: ${params.firstUserMessage.slice(0, 800)}`,
    "",
    `Assistant: ${params.firstAssistantMessage.slice(0, 800)}`,
  ].join("\n");

  const body = {
    model: resolved.model.id,
    messages: [
      { role: "system", content: TITLE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 32,
    temperature: 0.3,
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    if (resolved.provider.headers) {
      for (const [k, v] of Object.entries(resolved.provider.headers)) {
        const value = normalizeSecretInput(v);
        if (value) {
          headers[k] = value;
        }
      }
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      logWarn(
        `[session-title] generation failed: ${res.status} ${res.statusText} for provider ${resolved.providerName}`,
      );
      return null;
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    if (typeof content !== "string" || content.trim().length === 0) {
      return null;
    }
    const title = sanitizeTitle(content);
    return title.length > 0 ? title : null;
  } catch (err) {
    logWarn(`[session-title] generation error: ${String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
