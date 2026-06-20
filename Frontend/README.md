# Time Lens — Frontend

Frontend for **Time Lens**, a retail demand forecasting platform. Next.js 15 (App
Router) + TypeScript, dark-first, fully decoupled from the backend.

> The backend (Python forecasting/scenario/reporting engine over SQLite — **not**
> FastAPI yet) is a separate concern. This app talks to it only through a typed
> service layer and runs entirely on **mock data** until real APIs exist.

---

## Stack

| Concern            | Choice |
|--------------------|--------|
| Framework          | Next.js 15 (App Router, RSC) |
| Language           | TypeScript (strict) |
| Styling            | Tailwind CSS + CSS-variable tokens |
| Components         | shadcn/ui (Radix primitives) |
| Charts             | Apache ECharts |
| Tables             | TanStack Table |
| Forms              | React Hook Form + Zod |
| Client state       | Zustand |
| HTTP               | Axios |
| Server-state fetch | Custom hooks (`useAsync`/`useMutation`) — **TanStack Query-ready** |
| Theming            | next-themes (dark default) |

---

## Getting started

```bash
npm install
cp .env.example .env.local   # NEXT_PUBLIC_USE_MOCKS=true by default
npm run dev
```

With mocks on, the whole app runs without any backend. Mock auth accepts **any**
email/password.

---

## Architecture

### Folder structure

```
src/
├── app/                 # App Router: route groups, layouts, pages, middleware
├── components/
│   ├── ui/              # shadcn primitives (button, card, dropdown, sheet, …)
│   ├── layout/          # app-shell, sidebar/, navbar/, page-shell
│   ├── charts/          # echart-base (only file touching ECharts) + chart wrappers
│   ├── data-table/      # generic TanStack Table
│   ├── feedback/        # empty-state, error-state
│   └── common/          # stat-tile, page-shell helpers, placeholders
├── features/            # (next phase) page-specific composition & column defs
├── lib/
│   ├── api/             # service layer — see below
│   ├── stores/          # Zustand slices
│   ├── hooks/           # useAsync, useMutation, useMounted, useHotkey
│   ├── theme/           # theme provider, config, mode hook
│   ├── validation/      # Zod schemas (forms + API boundary)
│   ├── constants/       # env, routes, navigation
│   └── utils/           # cn, formatters
├── types/               # domain types (api, auth, sku, forecast, scenario, …)
├── styles/              # globals.css (tokens) + echarts-theme.ts
└── middleware.ts        # edge route protection
```

### Routing (App Router)

Two route groups split the chrome:

- `(auth)` → centered shell, no nav. Holds `/login`.
- `(app)` → product chrome (sidebar + navbar) via `AppShell`. Holds the eight
  feature routes, each with `loading.tsx` (skeleton) and `error.tsx` where it
  matters.

Dynamic routes: `/skus/[skuId]`, `/forecasts/[forecastId]`,
`/scenarios/[scenarioId]`, plus `/scenarios/new` and `/scenarios/compare`.

### Auth (mock now → httpOnly cookie later)

- **Abstraction:** everything goes through `authService`. Components/stores never
  know whether it's a mock or the real backend.
- **Route protection:** `middleware.ts` checks for the `tl_session` cookie at the
  edge and redirects accordingly — already compatible with the future
  httpOnly cookie (middleware only checks presence; validation stays server-side).
- **Mock flow:** since no server sets httpOnly cookies yet, the mock login writes
  a same-named placeholder cookie so the full guard/redirect flow is exercised.
  Flip `NEXT_PUBLIC_USE_MOCKS=false` to hand the cookie to the real backend — no
  call-site changes.

### API service layer (TanStack Query-ready by design)

```
lib/api/
├── client.ts        # single axios transport; request() returns Promise<T>
├── endpoints.ts     # URL registry
├── error.ts         # ApiError + normalizeError (services never leak axios)
├── mock/            # adapter + route table + fixtures (served when USE_MOCKS)
└── services/        # one typed module per domain
```

- Services depend **only** on `http.*` / `request()` — never on axios directly.
- `request()` returns the **unwrapped payload** (`Promise<T>`), exactly the shape
  a TanStack Query `queryFn` expects. Adding Query later = wrap these calls in
  `useQuery`/`useMutation`; the transport, services, and types don't change.
- `NEXT_PUBLIC_USE_MOCKS` swaps the data source at the transport boundary, so the
  mock and real backend are interchangeable with zero service/page edits.

Today, pages consume services via `useAsync(fn)` / `useMutation(fn)` — hooks whose
`{data, isLoading, error}` / `{mutate, isPending}` surfaces mirror TanStack Query
1:1.

### State (Zustand)

Sliced, domain-scoped stores — **server data does not live here**, only
client/session/UI state and user intent:

`auth` · `ui` (sidebar/command/mobile-nav) · `filter` (global date/region/category)
· `upload` (wizard) · `sku` (selection + view prefs) · `scenario` (draft levers) ·
`comparison` (selected set + baseline). `persist` is applied only to durable prefs.

### Theming (dark-first)

CSS-variable tokens in `globals.css` define `.dark` (primary) and `:root` (light).
Tailwind maps utilities to those vars; `echarts-theme.ts` reads the same vars so
charts re-theme in lockstep. `next-themes` defaults to dark.

### Navigation

`lib/constants/navigation.ts` is the single source of truth — the sidebar renders
from it and breadcrumbs derive labels from `routes.ts`. Adding a page = one config
entry. The sidebar collapses (persisted) and becomes an off-canvas Sheet on mobile.

---

## Conventions

- Import via the `@/*` alias.
- Domain types from `@/types`; services from `@/lib/api/services`; stores from
  `@/lib/stores`.
- Zod schemas back every form and validate data at the API boundary.
- RSC by default; `"use client"` only for stores, charts, tables, forms, and
  interactive chrome.

## Status

Foundation/architecture complete. **Page UI is intentionally not implemented** —
routes render scaffolding placeholders. Next phase: build the eight pages inside
`features/*` against the existing services and mock data.
