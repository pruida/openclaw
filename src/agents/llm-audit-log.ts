import path from "node:path";
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { redactImageDataForDiagnostics } from "./payload-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";

// Provider-agnostic audit log for every LLM exchange. Two records per call:
//   stage="request"  — the raw provider payload (model, messages, system,
//                      tools, params) right before it leaves the process
//   stage="response" — the final assistant turn (text + tool_calls + usage)
//                      reconstructed from the session history after streaming
// Both records share the same runId + sessionId so a downstream `jq`/grep
// pipeline can pair them up. Enable with OPENCLAW_LLM_AUDIT_LOG=1.

type AuditStage = "request" | "response";

type AuditEvent = {
  ts: string;
  stage: AuditStage;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  payload?: unknown;
  assistant?: {
    role?: string;
    text?: string;
    content?: unknown;
    tool_calls?: unknown;
    usage?: unknown;
  };
  error?: string;
};

// One log file per UTC date by default (rotation), unless the user pinned a
// specific file with OPENCLAW_LLM_AUDIT_LOG_FILE in which case we honour it
// verbatim. Default pattern is `llm-audit-YYYY-MM-DD.jsonl` which is grep-
// friendly, sorts lexicographically, and lets a separate cron gzip files
// older than N days without coordinating with the running process.
type AuditConfig =
  | { enabled: false }
  | { enabled: true; mode: "fixed"; filePath: string }
  | { enabled: true; mode: "rotate"; baseDir: string; baseName: string; ext: string };

const writers = new Map<string, QueuedFileWriter>();
const log = createSubsystemLogger("agent/llm-audit");

function resolveConfig(env: NodeJS.ProcessEnv): AuditConfig {
  const enabled = parseBooleanValue(env.OPENCLAW_LLM_AUDIT_LOG) ?? false;
  if (!enabled) {
    return { enabled: false };
  }
  const fileOverride = env.OPENCLAW_LLM_AUDIT_LOG_FILE?.trim();
  if (fileOverride) {
    return { enabled: true, mode: "fixed", filePath: resolveUserPath(fileOverride) };
  }
  return {
    enabled: true,
    mode: "rotate",
    baseDir: path.join(resolveStateDir(env), "logs"),
    baseName: "llm-audit",
    ext: "jsonl",
  };
}

function todayString(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function resolveCurrentFilePath(cfg: AuditConfig): string | null {
  if (!cfg.enabled) {
    return null;
  }
  if (cfg.mode === "fixed") {
    return cfg.filePath;
  }
  return path.join(cfg.baseDir, `${cfg.baseName}-${todayString()}.${cfg.ext}`);
}

function getWriter(filePath: string): QueuedFileWriter {
  return getQueuedFileWriter(writers, filePath);
}

function formatError(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (error && typeof error === "object") {
    return safeJsonStringify(error) ?? "unknown error";
  }
  return undefined;
}

// Pull the trailing assistant message off the session history. SessionManager
// aggregates streamed deltas into a single message by the time recordResponse
// fires, so this is where we get the full text + tool_calls + usage.
function extractLastAssistant(messages: AgentMessage[]): AuditEvent["assistant"] | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as {
      role?: unknown;
      content?: unknown;
      text?: unknown;
      tool_calls?: unknown;
      usage?: unknown;
    };
    if (m?.role !== "assistant") {
      continue;
    }
    let text: string | undefined;
    if (typeof m.text === "string") {
      text = m.text;
    } else if (Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const c of m.content) {
        const item = c as { type?: unknown; text?: unknown };
        if (item?.type === "text" && typeof item.text === "string") {
          parts.push(item.text);
        } else if (typeof item?.text === "string") {
          parts.push(item.text);
        }
      }
      if (parts.length > 0) {
        text = parts.join("");
      }
    } else if (typeof m.content === "string") {
      text = m.content;
    }
    return {
      role: "assistant",
      text,
      content: m.content,
      tool_calls: m.tool_calls,
      usage: m.usage,
    };
  }
  return null;
}

export type LLMAuditLogger = {
  enabled: true;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
  recordResponse: (messages: AgentMessage[], error?: unknown) => void;
};

export function createLLMAuditLogger(params: {
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  writer?: QueuedFileWriter;
}): LLMAuditLogger | null {
  const env = params.env ?? process.env;
  const cfg = resolveConfig(env);
  if (!cfg.enabled) {
    return null;
  }

  const base: Omit<AuditEvent, "ts" | "stage"> = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    workspaceDir: params.workspaceDir,
  };

  // Resolve the writer per record() call so a process running across UTC
  // midnight rolls over to the next day's file without restart. Each unique
  // path gets cached in the module-level `writers` map (so repeated writes
  // on the same day reuse one queue).
  const record = (event: AuditEvent) => {
    const line = safeJsonStringify(event);
    if (!line) {
      return;
    }
    const filePath = resolveCurrentFilePath(cfg);
    if (!filePath) {
      return;
    }
    const writer = params.writer ?? getWriter(filePath);
    writer.write(`${line}\n`);
  };

  const wrapStreamFn: LLMAuditLogger["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model: Model<Api>, context, options) => {
      // Capture every provider's outgoing payload, not just Anthropic.
      const nextOnPayload = (payload: unknown) => {
        const redactedPayload = redactImageDataForDiagnostics(payload);
        record({
          ...base,
          ts: new Date().toISOString(),
          stage: "request",
          modelApi: (model as { api?: string | null })?.api ?? params.modelApi ?? null,
          payload: redactedPayload,
        });
        return options?.onPayload?.(payload, model);
      };
      return streamFn(model, context, {
        ...options,
        onPayload: nextOnPayload,
      });
    };
    return wrapped;
  };

  const recordResponse: LLMAuditLogger["recordResponse"] = (messages, error) => {
    const assistant = extractLastAssistant(messages);
    const errorMessage = formatError(error);
    if (!assistant && !errorMessage) {
      return;
    }
    record({
      ...base,
      ts: new Date().toISOString(),
      stage: "response",
      assistant: assistant ?? undefined,
      error: errorMessage,
    });
  };

  const initialPath = resolveCurrentFilePath(cfg);
  log.info("llm audit logger enabled", {
    mode: cfg.mode,
    filePath: initialPath,
  });
  return { enabled: true, wrapStreamFn, recordResponse };
}
