import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE_NAME,
  PUBLIC_ROUTES,
  DEFAULT_AUTHENTICATED_ROUTE,
  routes,
} from "@/lib/constants/routes";

/**
 * Edge route protection — compatible with the eventual httpOnly cookie session.
 *
 * The backend will set an httpOnly `tl_session` cookie on login. Middleware only
 * checks for its *presence* to gate routing (it cannot read httpOnly contents,
 * and validation belongs server-side). During the mock phase, the mock auth flow
 * sets the same cookie so this logic is already exercised end-to-end.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = request.cookies.has(SESSION_COOKIE_NAME);

  const isPublic = (PUBLIC_ROUTES as readonly string[]).some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  // Unauthenticated user hitting a protected route → send to login (remember intent).
  if (!hasSession && !isPublic) {
    const loginUrl = new URL(routes.login, request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Authenticated user hitting the login page → bounce to the app.
  if (hasSession && isPublic) {
    return NextResponse.redirect(
      new URL(DEFAULT_AUTHENTICATED_ROUTE, request.url),
    );
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything except Next internals, API routes, and static assets.
  // NOTE: the trailing `.*\\.[\\w]+$` clause excludes ALL files with an
  // extension served from /public (e.g. dhishaai-logo.png, time-lens-logo.png,
  // branding/*.svg). Without it, unauthenticated requests for those public
  // assets (e.g. the logos on the LOGIN page, where there is no session yet)
  // were redirected to /login → the <img> loaded HTML → broken-image/white box.
  // Page route protection is unchanged: route paths have no file extension and
  // still pass through middleware.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|fonts|icons|.*\\.[\\w]+$).*)",
  ],
};
