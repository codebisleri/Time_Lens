import { AppShell } from "@/components/layout/app-shell";
import { AuthBootstrap } from "@/components/layout/auth-bootstrap";

/**
 * Authenticated route group layout. Middleware guards access at the edge; this
 * mounts the product chrome (sidebar + navbar) and bootstraps the client auth
 * session. All eight feature pages render inside <AppShell>.
 */
export default function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <AuthBootstrap />
      <AppShell>{children}</AppShell>
    </>
  );
}
