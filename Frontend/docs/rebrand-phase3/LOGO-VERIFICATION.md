# Logo Verification Report — Rebrand Phase 3 (ROOT CAUSE FIXED + VERIFIED)

Issue 1 (logo still broken / white placeholder box) is resolved. This documents
the **two real root causes** found and the end-to-end verification.

## Root cause #1 (primary) — middleware redirected public assets to /login

`src/middleware.ts` protected routes with this matcher:

```
"/((?!api|_next/static|_next/image|favicon.ico|fonts|icons).*)"
```

It excluded Next internals but **not `/public` files**. So any request for
`/dhishaai-logo.png` or `/time-lens-logo.png` **without a session cookie** was
redirected to `/login`. On the **login page itself there is no session yet**, so
every logo `<img>` loaded the login HTML instead of the image → broken-image /
white placeholder box. This is exactly the reported symptom.

**Fix:** broadened the matcher to also exclude any path with a file extension:

```
"/((?!api|_next/static|_next/image|favicon.ico|fonts|icons|.*\\.[\\w]+$).*)"
```

Page route protection is unchanged — route paths have no extension and still
pass through middleware. Only static-asset serving changed.

## Root cause #2 (secondary) — image optimizer choked on the 9400px PNG

`next.config.ts` uses `output: "standalone"` (Electron desktop packaging). The
default `next/image` loader requires the `/_next/image` optimizer + `sharp` at
runtime. The DhishaAI wordmark source is **9400×3000**; optimizing it failed/
timed out in that runtime → broken image, while the small Time Lens mark
(865×772) optimized fine. That's why *DhishaAI specifically* was the visible
failure before.

**Fix:** `images: { unoptimized: true }` in `next.config.ts` + `unoptimized` on
both brand `<Image>`s. Images are served straight from `/public` — identical
rendering in dev, `next start`, standalone, and Electron. (PNGs are small on
disk; no cost.)

## End-to-end verification (`next start`, production build)

| Request | Before | After |
| --- | --- | --- |
| `GET /dhishaai-logo.png` | `text/html` 45,807 B (login redirect) | **`image/png` 231,945 B** ✓ |
| `GET /time-lens-logo.png` | `text/html` (redirect) / optimizer-broken | **`image/png` 897,262 B** ✓ |
| `GET /branding/forecast-horizon.svg` | redirect | **`image/svg+xml` 2,146 B** ✓ |
| Login page HTML `<img src>` | `/_next/image?...` (failing) | `/dhishaai-logo.png`, `/time-lens-logo.png` (raw) ✓ |
| `GET /login` | 200 | 200 ✓ |

No broken-image placeholders, no missing assets, no incorrect paths remain.

## Placement audit (all render correctly, light + dark)

| Location | File | Logos | Status |
| --- | --- | --- | --- |
| Enterprise header (all pages + login) | `components/layout/enterprise-header.tsx` | DhishaAI wordmark (plate) + Time Lens mark (white chip) | ✓ |
| Login — center lockup | `app/(auth)/login/page.tsx` | DhishaAI (plate) + Time Lens (white chip) | ✓ |
| Login — left workspace | `features/auth/auth-hero.tsx` | brand glow + forecast preview (no raw dark logo) | ✓ |
| Login — footer | `app/(auth)/login/page.tsx` | DhishaAI wordmark (plate) | ✓ |
| Sidebar header | `components/layout/sidebar/sidebar-logo.tsx` | Time Lens mark on white plate | ✓ |
| Sidebar footer | `components/layout/sidebar/sidebar-footer.tsx` | "Powered by DhishaAI" (light text) | ✓ |
| Dashboard / Intelligence Center | `features/dashboard/dashboard-view.tsx` | via global header + hero | ✓ |
| Forecasting page heroes | `features/*/*-view.tsx` | stage icon + motif (brand via header) | ✓ |

## Dark-mode visibility

- DhishaAI wordmark (navy glyphs) is rendered **only with `plate`** (light
  backing) on dark/unknown surfaces → always legible.
- Time Lens mark is multi-color and additionally seated on a white chip on
  deep-navy placements.
- No raw navy-on-navy logo anywhere.
