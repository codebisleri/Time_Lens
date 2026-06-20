"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * F.19 §4 — global route-transition loading indicator: a slim orange progress bar
 * pinned to the very top of the viewport that animates whenever the route
 * changes (Continue-to-X navigation, workflow transitions). App Router has no
 * router-events API, so this keys off `usePathname()` — it flashes on arrival at
 * a new route, giving users a consistent "something happened" signal.
 */
export function GlobalLoadingBar() {
  const pathname = usePathname();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false; // don't flash on the initial mount
      return;
    }
    setVisible(true);
    setProgress(12);
    const t1 = window.setTimeout(() => setProgress(72), 90);
    const t2 = window.setTimeout(() => setProgress(100), 380);
    const t3 = window.setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, 720);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [pathname]);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[3px]" aria-hidden>
      <div
        className="h-full rounded-r-full bg-brand-accent transition-all duration-300 ease-out"
        style={{
          width: `${progress}%`,
          opacity: visible ? 1 : 0,
          boxShadow: "0 0 10px hsl(var(--brand-accent)), 0 0 4px hsl(var(--brand-accent))",
        }}
      />
    </div>
  );
}
