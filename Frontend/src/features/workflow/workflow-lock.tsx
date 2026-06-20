import Link from "next/link";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/feedback/empty-state";

/**
 * Locked-stage placeholder shown when a workflow prerequisite isn't met. Mirrors
 * the original Streamlit guard behaviour: the stage is inaccessible and explains
 * what to complete first, with a shortcut to the prerequisite step.
 */
export function WorkflowLock({
  title = "Step locked",
  message,
  href,
  ctaLabel,
}: {
  title?: string;
  message: string;
  href?: string;
  ctaLabel?: string;
}) {
  return (
    <EmptyState
      icon={Lock}
      title={title}
      description={message}
      action={
        href && ctaLabel ? (
          <Button asChild>
            <Link href={href}>{ctaLabel}</Link>
          </Button>
        ) : undefined
      }
    />
  );
}
