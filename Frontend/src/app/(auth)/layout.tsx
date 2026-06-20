/**
 * Pass-through shell for unauthenticated routes. Each auth page owns its full
 * layout (e.g. the login page renders a two-pane brand/form split), so this just
 * provides the full-height canvas. No sidebar/navbar here.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="min-h-screen bg-background">{children}</div>;
}
