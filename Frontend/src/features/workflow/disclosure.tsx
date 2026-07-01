import { ChevronRight } from "lucide-react";

/**
 * Lightweight accordion (native <details>) matching the Streamlit `st.expander`
 * pattern used across Profile & Route. Collapsed by default unless `defaultOpen`.
 *
 * Optionally CONTROLLED: pass `open` + `onOpenChange` to drive the expanded state
 * from the parent (e.g. auto-expand the segmentation thresholds when the user
 * opts into generated segmentation). When `open` is undefined the component stays
 * uncontrolled and uses `defaultOpen`.
 */
export function Disclosure({
  title,
  defaultOpen = false,
  open,
  onOpenChange,
  children,
}: {
  title: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const controlled = open !== undefined;
  return (
    <details
      {...(controlled ? { open } : { open: defaultOpen })}
      onToggle={
        onOpenChange
          ? (e) => onOpenChange((e.currentTarget as HTMLDetailsElement).open)
          : undefined
      }
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
