import { SESSION_COOKIE_NAME } from "@/lib/constants/routes";

/**
 * Client-side bearer-token store for the real (token-based) auth flow.
 *
 * The token lives in localStorage (requirement: persist session in localStorage)
 * and is attached as `Authorization: Bearer <token>` by the api client. We ALSO
 * mirror its presence into the `tl_session` cookie so the existing edge
 * middleware (which can only read cookies, not localStorage) keeps gating the
 * protected routes — no middleware rewrite needed.
 */
const TOKEN_KEY = "tl_auth_token";
const MAX_AGE_DAYS = 30;

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Write the presence cookie (value = token) with a fresh MAX_AGE_DAYS expiry. */
function writeSessionCookie(token: string): void {
  const expires = new Date(
    Date.now() + MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toUTCString();
  document.cookie = `${SESSION_COOKIE_NAME}=${token}; path=/; expires=${expires}; SameSite=Lax`;
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore quota / private-mode */
  }
  // Presence cookie for the route-protection middleware (value is the token).
  writeSessionCookie(token);
}

/**
 * D.2 — desktop session persistence. On each app launch, if a bearer token is
 * already stored (localStorage persists across Electron restarts), re-issue the
 * presence cookie with a fresh 30-day expiry. This rolls the routing-gate window
 * forward every time the app is opened (so a regularly-used desktop app never
 * silently expires) and self-heals any cookie/localStorage divergence. Token
 * VALIDITY is still verified by /auth/me — an invalid token's 401 clears both.
 */
export function refreshSessionCookie(): void {
  if (typeof window === "undefined") return;
  const token = getToken();
  if (token) writeSessionCookie(token);
}

export function clearToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  document.cookie = `${SESSION_COOKIE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
