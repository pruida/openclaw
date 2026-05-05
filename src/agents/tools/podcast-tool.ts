import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { logDebug, logWarn } from "../../logger.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { downloadsRoot } from "./ppt-tool.js";

// NotebookLM-style two-host podcast generator. Three pluggable providers:
//
//   • openai     — tts-1-hd, per-segment synth + ffmpeg concat
//   • elevenlabs — eleven_multilingual_v2, per-segment + ffmpeg concat
//   • gemini     — gemini-2.5-flash-preview-tts (the same engine that
//                  powers NotebookLM internally), one call returns the
//                  full multi-speaker audio
//
// Provider chosen by `OPENCLAW_PODCAST_PROVIDER` env (default: gemini).
// API keys via the usual env vars (OPENAI_API_KEY / ELEVENLABS_API_KEY /
// GEMINI_API_KEY). Voices overridable via OPENCLAW_PODCAST_VOICE_HOST /
// OPENCLAW_PODCAST_VOICE_GUEST; otherwise the per-provider defaults below
// are picked to read like a clearly distinct host + guest.

type Speaker = "host" | "guest";

interface ScriptSegment {
  speaker: Speaker;
  text: string;
}

const SegmentSchema = Type.Object({
  speaker: Type.Union([Type.Literal("host"), Type.Literal("guest")]),
  text: Type.String({ minLength: 1 }),
});

const PodcastSchema = Type.Object({
  title: Type.String({
    description:
      "Episode title — used for the URL filename. Keep it short (< 60 chars); long titles get slugified.",
  }),
  script: Type.Array(SegmentSchema, {
    description:
      'Two-host conversation script. Each segment is { speaker: "host"|"guest", text: "..." }. Alternate naturally; aim for 8-30 segments per minute of audio. Don\'t prefix the text with "Host:" / "Guest:" — the speaker tag handles that.',
    minItems: 1,
  }),
});

interface PodcastProvider {
  name: string;
  generate(script: ScriptSegment[], voices: { host: string; guest: string }): Promise<Buffer>;
}

// ─── ffmpeg helpers ─────────────────────────────────────────────────────

function runFfmpeg(args: string[], stdinBuf?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let stderrBuf = "";
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => {
      stderrBuf += c.toString();
    });
    proc.on("error", (err) =>
      reject(new Error(`ffmpeg spawn failed: ${err.message}`, { cause: err })),
    );
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out));
      } else {
        const tail = stderrBuf.split("\n").slice(-5).join("\n");
        reject(new Error(`ffmpeg exited code=${code}: ${tail}`));
      }
    });
    if (stdinBuf) {
      proc.stdin.end(stdinBuf);
    } else {
      proc.stdin.end();
    }
  });
}

/// Concat MP3 segments with `silenceMs` of silence between each, return a
/// single MP3 buffer. Uses ffmpeg's concat demuxer for clean joins.
async function concatMp3Segments(segments: Buffer[], silenceMs: number): Promise<Buffer> {
  if (segments.length === 0) {
    throw new Error("podcast: no segments to concat");
  }
  if (segments.length === 1 && silenceMs === 0) {
    return segments[0];
  }
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-podcast-"));
  try {
    // Write each segment + a silence spacer (except the last) to the temp dir.
    const silencePath = path.join(tmpDir, "silence.mp3");
    if (silenceMs > 0) {
      await runFfmpeg([
        "-y",
        "-f",
        "lavfi",
        "-i",
        `anullsrc=r=24000:cl=mono`,
        "-t",
        (silenceMs / 1000).toFixed(3),
        "-c:a",
        "libmp3lame",
        "-b:a",
        "96k",
        silencePath,
      ]);
    }
    const concatLines: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const segPath = path.join(tmpDir, `seg-${i}.mp3`);
      await writeFile(segPath, segments[i]);
      concatLines.push(`file '${segPath.replace(/'/g, "'\\''")}'`);
      if (silenceMs > 0 && i < segments.length - 1) {
        concatLines.push(`file '${silencePath.replace(/'/g, "'\\''")}'`);
      }
    }
    const listPath = path.join(tmpDir, "concat.txt");
    await writeFile(listPath, concatLines.join("\n") + "\n");
    const outPath = path.join(tmpDir, "out.mp3");
    await runFfmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      outPath,
    ]);
    return await readFile(outPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/// Convert raw 24kHz mono PCM (signed 16-bit little-endian — what Gemini's
/// TTS returns) into MP3.
async function pcm16leToMp3(pcm: Buffer, sampleRate: number): Promise<Buffer> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-podcast-pcm-"));
  try {
    const outPath = path.join(tmpDir, "out.mp3");
    await runFfmpeg(
      [
        "-y",
        "-f",
        "s16le",
        "-ar",
        `${sampleRate}`,
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        outPath,
      ],
      pcm,
    );
    return await readFile(outPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ─── OpenAI provider ────────────────────────────────────────────────────

const OPENAI_DEFAULT_VOICES = { host: "onyx", guest: "nova" };

class OpenAIProvider implements PodcastProvider {
  name = "openai";

  async generate(
    script: ScriptSegment[],
    voices: { host: string; guest: string },
  ): Promise<Buffer> {
    const apiKey = (process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) {
      throw new Error("podcast: OPENAI_API_KEY not set on this gateway");
    }
    const segments: Buffer[] = [];
    for (const seg of script) {
      const voice = seg.speaker === "host" ? voices.host : voices.guest;
      const buf = await this.synthesizeOne(seg.text, voice, apiKey);
      segments.push(buf);
    }
    return await concatMp3Segments(segments, 350);
  }

  private async synthesizeOne(text: string, voice: string, apiKey: string): Promise<Buffer> {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1-hd",
        input: text,
        voice,
        response_format: "mp3",
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`podcast: OpenAI TTS HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

// ─── ElevenLabs provider ────────────────────────────────────────────────

// Two well-known prebuilt voices that ship with every ElevenLabs account
// — the agent / operator can override per-segment via env overrides.
const ELEVEN_DEFAULT_VOICES = {
  host: "pNInz6obpgDQGcFmaJgB", // Adam (deep male)
  guest: "21m00Tcm4TlvDq8ikWAM", // Rachel (warm female)
};

class ElevenLabsProvider implements PodcastProvider {
  name = "elevenlabs";

  async generate(
    script: ScriptSegment[],
    voices: { host: string; guest: string },
  ): Promise<Buffer> {
    const apiKey = (process.env.ELEVENLABS_API_KEY || "").trim();
    if (!apiKey) {
      throw new Error("podcast: ELEVENLABS_API_KEY not set on this gateway");
    }
    const segments: Buffer[] = [];
    for (const seg of script) {
      const voice = seg.speaker === "host" ? voices.host : voices.guest;
      const buf = await this.synthesizeOne(seg.text, voice, apiKey);
      segments.push(buf);
    }
    return await concatMp3Segments(segments, 350);
  }

  private async synthesizeOne(text: string, voiceId: string, apiKey: string): Promise<Buffer> {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`podcast: ElevenLabs HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

// ─── Gemini multi-speaker provider (NotebookLM-grade) ───────────────────

const GEMINI_DEFAULT_VOICES = { host: "Charon", guest: "Aoede" };

class GeminiProvider implements PodcastProvider {
  name = "gemini";

  async generate(
    script: ScriptSegment[],
    voices: { host: string; guest: string },
  ): Promise<Buffer> {
    const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
    if (!apiKey) {
      throw new Error("podcast: GEMINI_API_KEY (or GOOGLE_API_KEY) not set on this gateway");
    }
    // Gemini's multi-speaker TTS takes the script as a single text prompt
    // tagged with the speaker alias; the API generates the full duo audio
    // in one shot and returns 24kHz mono PCM.
    const dialogueText = script
      .map((s) => `${s.speaker === "host" ? "Host" : "Guest"}: ${s.text}`)
      .join("\n");

    const body = {
      contents: [
        {
          parts: [
            {
              text:
                "Read aloud as a natural two-person podcast conversation between Host and Guest. " +
                "Match the energy a NotebookLM Audio Overview would: warm, engaged, conversational.\n\n" +
                dialogueText,
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: [
              {
                speaker: "Host",
                voiceConfig: { prebuiltVoiceConfig: { voiceName: voices.host } },
              },
              {
                speaker: "Guest",
                voiceConfig: { prebuiltVoiceConfig: { voiceName: voices.guest } },
              },
            ],
          },
        },
      },
    };

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      "gemini-2.5-flash-preview-tts:generateContent?key=" +
      encodeURIComponent(apiKey);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`podcast: Gemini HTTP ${res.status}: ${errBody.slice(0, 400)}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { mimeType?: string; data?: string };
          }>;
        };
      }>;
    };
    const inlineData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inlineData?.data) {
      throw new Error(`podcast: Gemini returned no audio inlineData`);
    }
    const pcm = Buffer.from(inlineData.data, "base64");
    // Gemini ships PCM at 24 kHz; the rate may show up in mimeType
    // ("audio/L16;codec=pcm;rate=24000"). Parse defensively, fall back to 24k.
    const rateMatch = (inlineData.mimeType ?? "").match(/rate=(\d+)/i);
    const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
    return await pcm16leToMp3(pcm, sampleRate);
  }
}

// ─── Provider selection ─────────────────────────────────────────────────

function selectProvider(): {
  provider: PodcastProvider;
  defaults: { host: string; guest: string };
} {
  const which = (process.env.OPENCLAW_PODCAST_PROVIDER || "gemini").trim().toLowerCase();
  switch (which) {
    case "openai":
      return { provider: new OpenAIProvider(), defaults: OPENAI_DEFAULT_VOICES };
    case "elevenlabs":
      return { provider: new ElevenLabsProvider(), defaults: ELEVEN_DEFAULT_VOICES };
    case "gemini":
    case "notebooklm":
      return { provider: new GeminiProvider(), defaults: GEMINI_DEFAULT_VOICES };
    default:
      throw new Error(
        `podcast: unknown OPENCLAW_PODCAST_PROVIDER="${which}". Expected: openai | elevenlabs | gemini.`,
      );
  }
}

function resolveVoices(defaults: { host: string; guest: string }) {
  return {
    host: (process.env.OPENCLAW_PODCAST_VOICE_HOST || "").trim() || defaults.host,
    guest: (process.env.OPENCLAW_PODCAST_VOICE_GUEST || "").trim() || defaults.guest,
  };
}

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
  return cleaned || "podcast";
}

export function createPodcastTool(): AnyAgentTool {
  return {
    label: "Podcast Generator",
    name: "podcast",
    description:
      'Generate a NotebookLM-style two-host podcast (host + guest, conversational tone) from a structured script and return a tappable MP3 download URL. Provide `title` and `script` (array of {speaker:"host"|"guest", text:string}); aim for 8-30 segments per minute of audio for natural pacing. Don\'t prefix the text with role labels — the schema handles that. The TTS provider is set per-gateway via OPENCLAW_PODCAST_PROVIDER (openai / elevenlabs / gemini, default gemini which is the engine NotebookLM uses internally). After calling, include the returned `url` verbatim in your reply so the user gets a clickable audio card in chat.',
    parameters: PodcastSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const title = readStringParam(params, "title", { required: true });
      const rawScript = Array.isArray(params.script) ? (params.script as unknown[]) : [];
      if (rawScript.length === 0) {
        throw new Error("podcast: script must have at least one segment");
      }
      const script: ScriptSegment[] = rawScript.map((raw, idx) => {
        const s = raw as { speaker?: unknown; text?: unknown };
        const sp = s.speaker;
        if (sp !== "host" && sp !== "guest") {
          throw new Error(`podcast: script[${idx}].speaker must be "host" or "guest"`);
        }
        if (typeof s.text !== "string" || !s.text.trim()) {
          throw new Error(`podcast: script[${idx}].text must be non-empty`);
        }
        return { speaker: sp, text: s.text };
      });

      const { provider, defaults } = selectProvider();
      const voices = resolveVoices(defaults);

      logDebug(
        `[podcast] provider=${provider.name} voices=${voices.host}/${voices.guest} segments=${script.length}`,
      );

      let mp3: Buffer;
      try {
        mp3 = await provider.generate(script, voices);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn(`[podcast] generation failed via ${provider.name}: ${msg}`);
        throw err;
      }

      const filename = `${slugify(title)}.mp3`;
      const token = crypto.randomBytes(16).toString("hex");
      const dir = path.join(downloadsRoot(), token);
      await mkdir(dir, { recursive: true });
      const dest = path.join(dir, filename);
      await writeFile(dest, mp3);

      const baseUrl = publicBaseUrl(process.env);
      const relPath = `/downloads/${token}/${encodeURIComponent(filename)}`;
      const url = baseUrl ? `${baseUrl}${relPath}` : relPath;

      logDebug(`[podcast] wrote ${dest} (${mp3.length} bytes)`);

      return jsonResult({
        ok: true,
        url,
        filename,
        provider: provider.name,
        sizeBytes: mp3.length,
        segmentCount: script.length,
        voices,
        hint: "Include `url` verbatim in your reply — that's the tappable MP3 the user will play.",
      });
    },
  };
}
