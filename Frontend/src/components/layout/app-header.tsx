"use client";

/**
 * Canonical shared application header.
 *
 * This is the SINGLE header used across every surface — the authenticated app
 * chrome (via AppShell), the login screen (`minimal`), and the standalone User
 * Manual window (`minimal`). It is the established enterprise header: a 72px
 * sticky glassmorphism bar with the DhishaAI brand lockup, the premium animated
 * live clock (the platform's signature identity), the current-module indicator,
 * and the account/controls cluster.
 *
 * Implementation lives in `enterprise-header.tsx`; this module is the stable
 * import name so all pages share one header (no per-page header should exist).
 */

export { EnterpriseHeader as AppHeader } from "./enterprise-header";
