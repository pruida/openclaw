// Orchestrates the best-effort, fire-and-forget AI title generation for a
// session right after chat.final. All errors are swallowed and logged at warn
// level — titles are a UX nicety, never load-bearing.
//
// Caller side (chat.ts):
//   void maybeGenerateSessionTitle({ sessionKey, logGateway: ctx.logGateway });
//
// Idempotency: skipped when SessionEntry.generatedTitle already exists, or
// when a recent attempt is still inside the cooldown window.

import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { updateSessionStore } from "../config/sessions.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { generateSessionTitle, shouldAttemptTitleGen } from "./session-title-generator.js";
import {
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  readSessionMessages,
  resolveSessionModelRef,
} from "./session-utils.js";

export type MaybeGenerateSessionTitleParams = {
  sessionKey: string;
  logGateway: Pick<SubsystemLogger, "warn" | "debug">;
};

type TranscriptMsg = {
  role?: unknown;
  content?: unknown;
};

function extractText(msg: TranscriptMsg): string {
  const c = msg?.content;
  if (typeof c === "string") {
    return c.trim();
  }
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const part of c) {
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof (part as { text: unknown }).text === "string"
      ) {
        parts.push((part as { text: string }).text);
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}

/**
 * Walk transcript forward and return [firstUserText, firstAssistantText].
 * Either may be empty if the session lacks one or both roles.
 */
function findFirstExchange(messages: unknown[]): {
  firstUser: string;
  firstAssistant: string;
} {
  let firstUser = "";
  let firstAssistant = "";
  for (const m of messages) {
    if (!m || typeof m !== "object") {
      continue;
    }
    const msg = m as TranscriptMsg;
    const role = typeof msg.role === "string" ? msg.role : "";
    const text = extractText(msg);
    if (!text) {
      continue;
    }
    if (role === "user" && !firstUser) {
      firstUser = text;
    } else if (role === "assistant" && firstUser && !firstAssistant) {
      firstAssistant = text;
    }
    if (firstUser && firstAssistant) {
      break;
    }
  }
  return { firstUser, firstAssistant };
}

export async function maybeGenerateSessionTitle(
  params: MaybeGenerateSessionTitleParams,
): Promise<void> {
  try {
    const { cfg, storePath, entry, canonicalKey } = loadSessionEntry(params.sessionKey);
    if (!entry?.sessionId) {
      return;
    }

    const now = Date.now();
    if (
      !shouldAttemptTitleGen({
        existingTitle: entry.generatedTitle,
        lastAttemptAt: entry.generatedTitleAt,
        now,
      })
    ) {
      return;
    }

    const messages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
    const { firstUser, firstAssistant } = findFirstExchange(messages);
    if (!firstUser || !firstAssistant) {
      return;
    }

    const parsed = parseAgentSessionKey(canonicalKey ?? params.sessionKey);
    const agentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const { provider, model } = resolveSessionModelRef(cfg, entry, agentId);

    const title = await generateSessionTitle({
      cfg,
      sessionProviderName: provider,
      sessionModel: model,
      firstUserMessage: firstUser,
      firstAssistantMessage: firstAssistant,
    });

    // Always update generatedTitleAt so failed attempts don't retry instantly.
    await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
        cfg,
        key: params.sessionKey,
        store,
      });
      const e = store[primaryKey];
      if (!e) {
        return;
      }
      e.generatedTitleAt = now;
      if (title) {
        e.generatedTitle = title;
      }
    });
  } catch (err) {
    params.logGateway.warn(`[session-title] runner error: ${String(err)}`);
  }
}
