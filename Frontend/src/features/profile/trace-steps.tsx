import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { SegmentTrace } from "@/types/segmentation";

/** Render the engine's **bold** markers as <strong>. */
function mdBold(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/** Step-by-step segmentation derivation (shared by the drawer + trace accordion). */
export function TraceSteps({ trace }: { trace: SegmentTrace }) {
  return (
    <div className="space-y-2">
      <ol className="space-y-2">
        {trace.steps.map((s) => (
          <li key={s.step} className="rounded-md border border-border/60 bg-card/40 p-3">
            <div className="flex items-center gap-2">
              <span className="flex size-5 items-center justify-center rounded-full border border-border text-xs tabular-nums text-muted-foreground">
                {s.step}
              </span>
              <span className="text-sm font-medium text-foreground">{s.name}</span>
              {s.stop ? (
                <Badge variant="success" className="ml-auto">
                  <Check className="size-3" /> final
                </Badge>
              ) : null}
            </div>
            <p className="mt-1.5 font-mono text-xs text-muted-foreground">{s.detail}</p>
            <p
              className="mt-1 text-xs font-medium text-foreground"
              dangerouslySetInnerHTML={{ __html: `→ ${mdBold(s.verdict)}` }}
            />
          </li>
        ))}
      </ol>
      {trace.final ? (
        <div className="pt-1 text-sm">
          Final segment: <Badge variant="default">{trace.final}</Badge>
        </div>
      ) : null}
    </div>
  );
}
