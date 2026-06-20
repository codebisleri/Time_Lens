"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { ROUTE_LABELS } from "@/lib/constants/routes";

/** Humanizes an unknown segment (e.g. a dynamic id) as a fallback label. */
function labelFor(segment: string) {
  return (
    ROUTE_LABELS[segment] ??
    segment.charAt(0).toUpperCase() + segment.slice(1).replace(/[-_]/g, " ")
  );
}

/**
 * Pathname-derived breadcrumbs. Labels resolve from ROUTE_LABELS; dynamic
 * segments (ids) fall back to a humanized form (a page can override later by
 * passing the entity name through context once data loads).
 */
export function NavBreadcrumbs() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);

  return (
    <nav aria-label="Breadcrumb" className="hidden items-center gap-1.5 text-sm md:flex">
      {segments.map((segment, i) => {
        const href = "/" + segments.slice(0, i + 1).join("/");
        const isLast = i === segments.length - 1;
        return (
          <Fragment key={href}>
            {i > 0 && (
              <ChevronRight className="size-3.5 text-muted-foreground/50" />
            )}
            {isLast ? (
              <span className="font-medium text-foreground">
                {labelFor(segment)}
              </span>
            ) : (
              <Link
                href={href}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {labelFor(segment)}
              </Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
