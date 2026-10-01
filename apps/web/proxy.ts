import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Sends visitors without a session cookie to the landing at `/`. This only
 * checks that the cookie exists; the product layout still validates the
 * session, and shows the landing in place if a stale cookie gets through.
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();

  return NextResponse.redirect(new URL("/", request.url));
}

export const config = { matcher: ["/agent/:path*", "/settings"] };
