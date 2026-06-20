import type { ID, ISODateString } from "./api";

export type UserRole = "admin" | "analyst" | "planner" | "viewer";

export interface User {
  id: ID;
  email: string;
  name: string;
  role: UserRole;
  avatarUrl?: string;
  organization?: string;
  createdAt: ISODateString;
}

/** Client-visible session metadata. The actual session token lives in an
 *  httpOnly cookie set by the backend and is never exposed to JS. */
export interface Session {
  user: User;
  expiresAt: ISODateString;
}

export interface LoginCredentials {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface AuthResult {
  user: User;
  expiresAt: ISODateString;
}

/** Real (token-based) auth response from the FastAPI bridge. */
export interface AuthTokenResult {
  token: string;
  user: User;
}

export interface RegisterPayload {
  name: string;
  email: string;
  password: string;
  role?: UserRole;
}
