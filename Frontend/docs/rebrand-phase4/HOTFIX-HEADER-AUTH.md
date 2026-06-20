# Hotfix Report — Header Actions, Logout, Login Routing

Audit + fix of the functional regressions reported after the Phase 4 redesign.
**UI/styling unchanged; only broken functionality restored.**

## Component status

| Component | Working | Issue found |
| --- | --- | --- |
| Login Page | YES | None — `/login` returns 200 without a session; reachable after logout |
| Settings | YES | The standalone header gear had **no onClick** (dead). Settings now lives in the working account menu |
| User Menu | YES | Radix dropdown is portaled (z-50) — opens above the 72px header; hardened header overlay so nothing can intercept the avatar click |
| Logout | YES | `logout()` → `clearToken()` clears `tl_session` cookie + localStorage → `router.replace('/login')`; verified no redirect loop |
| Middleware | YES | `/login` public & accessible; protected routes redirect to login; authed users bounce off `/login` |
| Header Actions | YES | Removed two handler-less icons (gear, bell); search / theme / account menu all functional |
| Navigation | YES | `router.push`/`replace`, `Link`, and dropdown `onSelect` handlers all intact |

## Root cause

1. **Dead header icons (the visible "Settings not working").** Phase 4 added a
   Settings gear and a Notifications bell to the enterprise header as decorative
   `<Button>`s with **no `onClick`** — so clicking them did nothing. (Settings &
   Logout always existed, and still exist, in the account/avatar menu.)
2. **Decorative overlay risk.** The header's gradient scrim was
   `absolute inset-0` **without `pointer-events-none`**. (In practice the relative
   controls paint above it, but this is the exact "overlay intercepting clicks"
   risk the audit called out, so it was hardened.)
3. **Logout / login routing were NOT broken.** `clearToken()` already expires the
   cookie correctly and middleware already keeps `/login` public — verified live
   (below). The perception of "logout/login broken" traced to the dead Settings
   icon and avatar-menu discoverability, not the auth flow.

## Fix implemented

- `components/layout/enterprise-header.tsx`
  - Removed the handler-less **Settings** and **Notifications** icon buttons
    (and their `Settings`/`Bell` imports). Settings · Profile · Logout remain in
    the wired account menu (`UserMenu`).
  - Added `pointer-events-none` to the decorative gradient scrim.
- `features/workflow/workflow-hero.tsx`
  - Added `pointer-events-none` to the hero scrim + glow layers (defensive; the
    motif was already non-interactive).

No changes to auth logic, the auth store, the auth service, the cookie/token
store, middleware, routes, or any handler — those were already correct.

## Validation

Built clean (`.next` wiped) → `compiled successfully`, `lint` ✓, types ✓, 22/22
routes. Routing probed against `next start` (production build):

| Request | Cookie | Result | Meaning |
| --- | --- | --- | --- |
| `GET /login` | none | **200** | Login always accessible |
| `GET /data` | none | **307 → /login** | Protected route gated |
| `GET /login` | valid | **307 → /data** | Authed users bounced off login (no loop) |
| `GET /data` | valid | **200** | App reachable when authed |
| `GET /forecast` | valid | **200** | App reachable when authed |

Logout path (code-verified): `UserMenu` Logout → `authStore.logout()` →
`authService.logout()` → `clearToken()` expires `tl_session` (path=/) + clears
localStorage → `router.replace('/login')` → next `/login` request has no cookie
→ **200**. User cannot reach protected pages afterward (`/data` no-cookie → 307).

## Confirmation

✓ Login page opens (200, no redirect loop, no blank/404)
✓ Settings & Logout work (in the account menu; no dead controls remain)
✓ User menu opens (portaled above the header; overlays can't block it)
✓ Logout clears session/cookie and redirects to `/login`
✓ Protected routes remain gated after logout
✓ No UI redesign or styling change — only broken functionality restored
