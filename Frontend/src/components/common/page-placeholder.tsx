import { Hammer } from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { EmptyState } from "@/components/feedback/empty-state";

/**
 * Temporary scaffold body used by route stubs while page UI is not yet built.
 * Each feature page replaces this with its real composition. Keeps routes
 * navigable and the shell/nav verifiable end-to-end today.
 */
export function PagePlaceholder({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <PageShell title={title} description={description}>
      <EmptyState
        icon={Hammer}
        title="UI not implemented yet"
        description="This route is scaffolded. Page composition will be added in the next phase."
      />
    </PageShell>
  );
}
