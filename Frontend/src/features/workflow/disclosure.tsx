import { ChevronRight } from "lucide-react";

/**
 * Lightweight accordion (native <details>) matching the Streamlit `st.expander`
 * pattern used across Profile & Route. Collapsed by default unless `defaultOpen`.
 */
export function Disclosure({
  title,
  defaultOpen = false,
  children,
}: {
  title: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-lg border border-border bg-card/40 [&_summary::-webkit-details-marker]:hidden"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-foreground">
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
        {title}
      </summary>
      <div className="border-t border-border/60 px-4 py-3">{children}</div>
    </details>
  );
}
