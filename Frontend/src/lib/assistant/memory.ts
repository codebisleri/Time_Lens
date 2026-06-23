/**
 * Time Lens AI Assistant — server-side conversation memory (Phase X.Z+ · Task 3).
 *
 * Recent conversation context lives in the SERVER PROCESS (a module-level Map in
 * the Next.js route's Node runtime — the same long-lived process Electron spawns
 * for the packaged app). It is deliberately ephemeral:
 *   • NEVER localStorage / sessionStorage / Zustand / disk.
 *   • Resets when the application (process) restarts.
 *
 * Two bounds keep it from growing without limit:
 *   • Per conversation: only the most recent MAX_MESSAGES turns are retained.
 *   • Across conversations: a simple LRU cap (MAX_CONVERSATIONS) evicts the
 *     least-recently-used conversation when the cap is exceeded.
 */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Keep the last ~20 turns of context (Task 3: "last 10–20 messages"). */
export const MAX_MESSAGES = 20;
/** Cap distinct in-flight conversations so memory can't grow unbounded. */
const MAX_CONVERSATIONS = 200;

// Map preserves insertion order → we use it as an LRU: re-inserting a key on
// access moves it to the newest position, so the oldest sits at the front.
const store = new Map<string, ChatMessage[]>();

function touch(id: string, messages: ChatMessage[]): void {
  store.delete(id);
  store.set(id, messages);
  while (store.size > MAX_CONVERSATIONS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Current stored history for a conversation (newest LRU position), or []. */
export function getHistory(id: string): ChatMessage[] {
  const existing = store.get(id);
  if (!existing) return [];
  touch(id, existing); // mark recently used
  return existing;
}

/** Replace a conversation's history, trimmed to the last MAX_MESSAGES turns. */
export function commitHistory(id: string, messages: ChatMessage[]): void {
  touch(id, messages.slice(-MAX_MESSAGES));
}

/** Forget a conversation entirely (e.g. the user cleared the chat). */
export function resetConversation(id: string): void {
  store.delete(id);
}
