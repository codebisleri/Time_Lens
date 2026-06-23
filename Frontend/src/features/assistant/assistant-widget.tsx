"use client";

import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Check, Copy, Eraser, Send, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import { Markdown } from "./markdown";

/**
 * Time Lens AI Assistant — floating help widget (Phase X.M · Tasks 6–7).
 *
 * DEMO build. A floating button opens a chat panel that talks to the
 * /api/assistant proxy. It sends ONLY the transcript + the current page /
 * workflow step (Task 7) — never datasets, forecasts, or financial values.
 * Features: welcome message, conversation history, typing indicator, clear chat,
 * copy response, Markdown rendering, loading + error states.
 */

interface Msg {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

// Map a route to a friendly page name + workflow step (context only — no data).
const PAGE_CONTEXT: { match: (p: string) => boolean; page: string; step: string }[] = [
  { match: (p) => p.startsWith("/overview"), page: "Overview", step: "Welcome" },
  { match: (p) => p.startsWith("/data"), page: "Input Data & Configuration", step: "Step 1 · Input & Configure" },
  { match: (p) => p.startsWith("/eda"), page: "EDA", step: "Step 2 · EDA" },
  { match: (p) => p.startsWith("/profile"), page: "Profile & Route", step: "Step 3 · Profile & Route" },
  { match: (p) => p.startsWith("/forecast-submission"), page: "Forecast Submission", step: "Step 4 · Forecast" },
  { match: (p) => p.startsWith("/forecast"), page: "Forecast", step: "Step 4 · Forecast" },
  { match: (p) => p.startsWith("/scenario"), page: "Scenario Planning", step: "Step 5 · Scenario Planning" },
  { match: (p) => p.startsWith("/report"), page: "Reports", step: "Step 6 · Reports" },
  { match: (p) => p.startsWith("/performance"), page: "Performance", step: "Review" },
  { match: (p) => p.startsWith("/sku"), page: "Item Explorer", step: "Review" },
  { match: (p) => p.startsWith("/dashboard"), page: "Dashboard", step: "Overview" },
];

function contextFor(pathname: string): { page: string; step: string } {
  const hit = PAGE_CONTEXT.find((c) => c.match(pathname));
  return hit ? { page: hit.page, step: hit.step } : { page: "Time Lens", step: "—" };
}

/** New conversation id (in-memory only — never localStorage/sessionStorage). */
function newConversationId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const WELCOME =
  "Hello, I am the **Time Lens AI Assistant**.\n\nAsk me about:\n- forecasting & models\n- segments (e.g. *What is Stable High?*)\n- anomalies\n- reports & metrics (e.g. *What is WMAPE?*)\n- terminology";

function AssistantWidgetInner() {
  const pathname = usePathname() ?? "";
  const { label: forecastLevel } = useForecastLevel();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  // Conversation id for SERVER-SIDE memory (Task 3). Held in a ref — process
  // memory only, never localStorage/sessionStorage. A fresh id starts a new
  // server conversation; "clear chat" rotates it.
  const conversationId = useRef<string>(newConversationId());
  // null = unknown (still probing). Hidden entirely only when the server says the
  // assistant is disabled (ENABLE_AI_ASSISTANT=false). Any probe failure fails
  // OPEN (button shown) — a real send then degrades gracefully via the error
  // bubble, so the assistant can never silently disappear because of a blip.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/assistant", { method: "GET" });
        const data = await res.json();
        if (!cancelled) setEnabled(data?.enabled !== false);
      } catch {
        if (!cancelled) setEnabled(true); // fail open
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading, open]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const ctx = contextFor(pathname);
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Server-side memory (Task 3): send only the NEW message + a conversation
        // id; the server holds recent history. Context is relevance-only (Task 5).
        body: JSON.stringify({
          conversationId: conversationId.current,
          message: text,
          context: { ...ctx, forecastLevel },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "The AI assistant is unavailable.");
      setMessages([...next, { role: "assistant", content: data.reply }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setMessages([...next, { role: "assistant", content: message, error: true }]);
    } finally {
      setLoading(false);
    }
  };

  // Clear the visible chat AND forget the server-side conversation memory, then
  // rotate to a fresh conversation id. The reset POST is best-effort.
  const clearChat = () => {
    const prevId = conversationId.current;
    setMessages([]);
    conversationId.current = newConversationId();
    void fetch("/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: prevId, reset: true }),
    }).catch(() => {
      /* best-effort — memory also self-evicts and resets on restart */
    });
  };

  const copy = async (text: string, i: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(i);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  // Task 1 — hard kill switch: hide entirely when the server disables it.
  if (enabled === false) return null;

  return (
    <>
      {/* Floating launcher */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close Time Lens AI Assistant" : "Open Time Lens AI Assistant"}
        className={cn(
          "fixed bottom-5 right-5 z-50 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 print:hidden",
          open && "scale-0 opacity-0",
        )}
      >
        <Sparkles className="size-5" />
      </button>

      {/* Chat panel */}
      {open ? (
        <div className="fixed bottom-5 right-5 z-50 flex h-[min(34rem,80vh)] w-[min(24rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl print:hidden">
          {/* Header */}
          <div className="flex items-center justify-between gap-2 border-b border-border bg-primary px-4 py-3 text-primary-foreground">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4" />
              <div className="leading-tight">
                <p className="text-sm font-semibold">Time Lens AI Assistant</p>
                <p className="text-[0.65rem] opacity-80">Demo · ask about the platform</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={clearChat}
                aria-label="Clear chat"
                title="Clear chat"
                className="rounded p-1.5 transition-colors hover:bg-white/15"
              >
                <Eraser className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded p-1.5 transition-colors hover:bg-white/15"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {/* Welcome (display only — not sent to the model) */}
            <div className="rounded-lg bg-secondary/50 px-3 py-2">
              <Markdown text={WELCOME} />
            </div>

            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="group flex flex-col gap-1">
                  <div
                    className={cn(
                      "max-w-[92%] rounded-lg rounded-bl-sm px-3 py-2",
                      m.error
                        ? "border border-destructive/30 bg-destructive/10 text-destructive"
                        : "bg-secondary/50 text-foreground",
                    )}
                  >
                    {m.error ? <p className="text-sm">{m.content}</p> : <Markdown text={m.content} />}
                  </div>
                  {!m.error ? (
                    <button
                      type="button"
                      onClick={() => copy(m.content, i)}
                      className="flex w-fit items-center gap-1 px-1 text-[0.7rem] text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                    >
                      {copied === i ? <Check className="size-3" /> : <Copy className="size-3" />}
                      {copied === i ? "Copied" : "Copy"}
                    </button>
                  ) : null}
                </div>
              ),
            )}

            {/* Typing indicator */}
            {loading ? (
              <div className="flex items-center gap-1.5 rounded-lg bg-secondary/50 px-3 py-2.5 w-fit">
                <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
                <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
                <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
              </div>
            ) : null}
          </div>

          {/* Composer */}
          <div className="border-t border-border p-2.5">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder="Ask about Time Lens…"
                className="max-h-28 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={loading || !input.trim()}
                aria-label="Send"
                className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
              >
                <Send className="size-4" />
              </button>
            </div>
            <p className="mt-1.5 px-1 text-[0.65rem] text-muted-foreground">
              Demo assistant · answers about the platform, not your data.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Failsafe boundary (Phase X.N · Task 2). The DEMO assistant must NEVER take down
 * the desktop app, a page render, or Electron. If anything in the widget throws
 * during render, we swallow it and render nothing — the forecasting platform
 * stays fully operational. A render error here is non-fatal by design.
 */
class AssistantBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    // Log only — never rethrow. The app must keep running.
    console.error("[AssistantWidget] disabled after a render error:", error);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function AssistantWidget() {
  return (
    <AssistantBoundary>
      <AssistantWidgetInner />
    </AssistantBoundary>
  );
}
