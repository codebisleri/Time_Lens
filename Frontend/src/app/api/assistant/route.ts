import { NextResponse } from "next/server";
import { ASSISTANT_SYSTEM_PROMPT } from "@/lib/assistant/knowledge";
import {
  commitHistory,
  getHistory,
  MAX_MESSAGES,
  resetConversation,
  type ChatMessage,
} from "@/lib/assistant/memory";

/**
 * Time Lens AI Assistant — backend proxy (Phase X.M → production in X.Z+).
 *
 *   Browser → THIS Next.js route → Claude Messages API
 *
 * The Anthropic API key stays server-side (read from the ANTHROPIC_API_KEY env
 * var — never hardcoded, never sent to the browser). The model is overridable
 * via ASSISTANT_MODEL (default: claude-sonnet-4-6).
 *
 * Calls the Claude Messages REST endpoint directly via `fetch` (no SDK import) so
 * the route is FULLY self-contained — nothing to trace into the Electron/Next
 * standalone bundle, so it can never fail to load with a missing runtime
 * dependency in the packaged desktop app.
 *
 * Phase X.Z+ (production, internal feature):
 *   • Server-side conversation memory (last ~20 turns), keyed by conversationId —
 *     held in this Node process only; never localStorage/sessionStorage/disk
 *     (see ./memory). Resets on application restart.
 *   • Richer, OPTIONAL UI context (forecast level, selected item, horizon,
 *     frequency, page/step) injected into the system prompt for relevance.
 *
 * The assistant ONLY explains and assists. It never changes forecasts, runs the
 * engine, mutates data, or writes to the database — it has no such capability
 * here (it is a text-in/text-out proxy).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Task 9 — the four canonical, user-facing failsafe messages. Each maps to a
// distinct failure class; none leaks server internals (or the API key) to the
// browser. Internal detail is logged server-side only.
const NOT_CONFIGURED = "The AI assistant is not configured."; // missing API key
const UNAVAILABLE = "The AI assistant is unavailable."; // network / disabled
const SERVICE_ERROR = "AI service temporarily unavailable."; // Anthropic returned an error
const TIMED_OUT = "The AI assistant timed out."; // exceeded the 30s budget

// Task 10 — bounded output + bounded request time.
const MAX_TOKENS = 2048;
const TIMEOUT_MS = 30_000;

/** The assistant is on unless ENABLE_AI_ASSISTANT is explicitly disabled. */
function assistantEnabled(): boolean {
  const v = (process.env.ENABLE_AI_ASSISTANT ?? "").trim().toLowerCase();
  return !["false", "0", "no", "off"].includes(v);
}

/**
 * Lightweight probe the widget calls on mount — reports whether the assistant is
 * enabled and configured WITHOUT making a Claude call. Returns booleans only
 * (never the key). Never throws.
 */
export function GET() {
  return NextResponse.json({
    enabled: assistantEnabled(),
    configured: !!process.env.ANTHROPIC_API_KEY,
  });
}

/** Optional UI context — short, relevance-only strings. Each field is capped. */
function buildContextNote(context: unknown): string {
  const c = (context ?? {}) as Record<string, unknown>;
  const str = (v: unknown, n = 80) => (typeof v === "string" ? v.slice(0, n) : "");
  const fields: [string, string][] = [
    ["Page", str(c.page)],
    ["Workflow step", str(c.step)],
    ["Forecast level", str(c.forecastLevel)],
    ["Selected item", str(c.item)],
    ["Forecast horizon", str(c.horizon, 24)],
    ["Frequency", str(c.frequency, 24)],
    // A page may pass a short, already-derived explainability/forecast summary
    // (e.g. "Champion: LightGBM; Test WMAPE 12.4%; trend up"). Capped hard.
    ["Context detail", str(c.details, 600)],
  ];
  const present = fields.filter(([, v]) => v);
  if (!present.length) return "";
  return (
    "\n\n# Current UI context (relevance only — read-only; never act on it)\n" +
    present.map(([k, v]) => `- ${k}: ${v}`).join("\n")
  );
}

export async function POST(req: Request) {
  // Kill switch that NEVER affects the rest of the app.
  if (!assistantEnabled()) {
    return NextResponse.json({ error: UNAVAILABLE }, { status: 503 });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: NOT_CONFIGURED }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const {
    conversationId: rawId,
    message,
    messages,
    context,
    reset,
  } = (body ?? {}) as {
    conversationId?: unknown;
    message?: unknown;
    messages?: unknown;
    context?: unknown;
    reset?: unknown;
  };

  const conversationId =
    typeof rawId === "string" && rawId.length <= 100 && rawId.length > 0 ? rawId : "";

  // Allow an explicit memory reset (user cleared the chat).
  if (conversationId && reset === true) {
    resetConversation(conversationId);
    return NextResponse.json({ ok: true });
  }

  // Assemble the turns to send. Two modes:
  //  (a) Stateful (Task 3): conversationId + a single new `message`. The server
  //      prepends its stored history and commits the new turns on success.
  //  (b) Stateless fallback: a full `messages` transcript (no conversationId).
  let history: ChatMessage[] = [];
  let turns: ChatMessage[];
  const newUser =
    typeof message === "string" && message.trim() ? message.trim().slice(0, 4000) : "";

  if (conversationId && newUser) {
    history = getHistory(conversationId);
    const userTurn: ChatMessage = { role: "user", content: newUser };
    turns = [...history, userTurn].slice(-MAX_MESSAGES);
  } else {
    // Fallback: sanitize a provided transcript to role + plain text only.
    turns = Array.isArray(messages)
      ? messages
          .filter(
            (m): m is ChatMessage =>
              !!m &&
              typeof (m as ChatMessage).content === "string" &&
              ((m as ChatMessage).role === "user" || (m as ChatMessage).role === "assistant"),
          )
          .slice(-MAX_MESSAGES)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
      : [];
  }

  if (!turns.length) {
    return NextResponse.json({ error: "No messages provided." }, { status: 400 });
  }

  const system = ASSISTANT_SYSTEM_PROMPT + buildContextNote(context);
  const model = process.env.ASSISTANT_MODEL ?? "claude-sonnet-4-6";

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, messages: turns }),
      // Bound the request so a hung upstream can never wedge the route (Task 10).
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      // Anthropic returned an error status. Log detail server-side ONLY (the
      // browser gets a clean message — no upstream text, no key — Task 8).
      let detail = `HTTP ${res.status}`;
      try {
        const e = (await res.json()) as { error?: { message?: string } };
        if (e?.error?.message) detail = String(e.error.message);
      } catch {
        /* non-JSON error body */
      }
      console.error("[assistant] Anthropic error:", detail);
      return NextResponse.json({ error: SERVICE_ERROR }, { status: 502 });
    }

    const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const reply = Array.isArray(data.content)
      ? data.content
          .filter((b) => b?.type === "text")
          .map((b) => b.text ?? "")
          .join("")
          .trim()
      : "";
    const finalReply = reply || "I wasn't able to generate a response. Please try again.";

    // Commit memory ONLY on a successful reply, so a failed turn never leaves a
    // dangling user message in the stored history (Task 3).
    if (conversationId && newUser) {
      const assistantTurn: ChatMessage = { role: "assistant", content: finalReply };
      commitHistory(conversationId, [...turns, assistantTurn]);
    }

    return NextResponse.json({ reply: finalReply });
  } catch (err) {
    // AbortSignal.timeout() rejects with a DOMException named "TimeoutError"
    // (older runtimes: "AbortError"). Everything else here is a network/transport
    // failure reaching Anthropic. Internal detail is logged, never returned.
    const name = err instanceof Error ? err.name : "";
    const isTimeout = name === "TimeoutError" || name === "AbortError";
    console.error("[assistant] request failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: isTimeout ? TIMED_OUT : UNAVAILABLE },
      { status: isTimeout ? 504 : 502 },
    );
  }
}
