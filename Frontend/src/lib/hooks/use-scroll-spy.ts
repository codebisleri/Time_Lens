"use client";

import { useEffect, useState } from "react";

/**
 * Scroll-spy: returns the anchor id of the in-page section currently in view.
 *
 * Uses an IntersectionObserver (root = viewport) so it works regardless of which
 * element actually scrolls, and re-acquires targets on a few timers + scroll so
 * it still binds to sections that mount AFTER the spy (e.g. EDA sections that
 * appear only once "Run EDA" has produced results). The active section is the
 * first (in document order) intersecting the active band just below the header.
 *
 * Pass an empty list to disable (no observer attached).
 */
export function useScrollSpy(anchors: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = anchors.join("|");

  useEffect(() => {
    if (typeof window === "undefined" || anchors.length === 0) {
      setActive(null);
      return;
    }

    let observer: IntersectionObserver | null = null;
    let observed: Element[] = [];
    const visible = new Set<string>();

    const pick = () => {
      const first = anchors.find((a) => visible.has(a));
      if (first) setActive(first);
    };

    const setup = () => {
      const els = anchors
        .map((a) => document.getElementById(a))
        .filter((el): el is HTMLElement => el != null);
      // Skip if the target set is unchanged.
      if (els.length === observed.length && els.every((e, i) => e === observed[i])) return;
      observer?.disconnect();
      visible.clear();
      observed = els;
      if (!els.length) {
        setActive(anchors[0] ?? null);
        return;
      }
      observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) visible.add(e.target.id);
            else visible.delete(e.target.id);
          }
          pick();
        },
        // Active band = from just under the 72px header down to ~40% viewport.
        { rootMargin: "-90px 0px -55% 0px", threshold: [0, 1] },
      );
      els.forEach((el) => observer!.observe(el));
    };

    setup();
    const t1 = window.setTimeout(setup, 300);
    const t2 = window.setTimeout(setup, 1200);
    // Re-acquire lazily-mounted sections; capture-phase catches inner scrollers.
    const onScroll = () => setup();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true, capture: true } as AddEventListenerOptions);

    return () => {
      observer?.disconnect();
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return active;
}
