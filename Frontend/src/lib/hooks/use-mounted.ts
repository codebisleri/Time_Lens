"use client";

import { useEffect, useState } from "react";

/** True only after first client mount. Use to guard SSR-unsafe rendering
 *  (theme-dependent UI, portals, charts) against hydration mismatches. */
export function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
