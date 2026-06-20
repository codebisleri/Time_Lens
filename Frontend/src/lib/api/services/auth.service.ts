import { http } from "../client";
import { endpoints } from "../endpoints";
import { clearToken, setToken } from "../auth-token";
import type {
  AuthTokenResult,
  LoginCredentials,
  RegisterPayload,
  User,
} from "@/types/auth";

/**
 * Auth against the FastAPI bridge. The backend returns `{ token, user }`; the
 * token is persisted (localStorage + presence cookie) by the token store, and
 * the api client attaches it as `Authorization: Bearer …` on every live request.
 * Only a real backend-issued token is stored — there is no placeholder/fake token.
 */
export const authService = {
  async login(credentials: LoginCredentials): Promise<AuthTokenResult> {
    const result = await http.post<AuthTokenResult>(endpoints.auth.login(), {
      email: credentials.email,
      password: credentials.password,
    });
    if (result.token) setToken(result.token);
    return result;
  },

  async register(payload: RegisterPayload): Promise<AuthTokenResult> {
    const result = await http.post<AuthTokenResult>(
      endpoints.auth.register(),
      payload,
    );
    if (result.token) setToken(result.token);
    return result;
  },

  async logout(): Promise<void> {
    // Tokens are stateless — clearing the client copy ends the session.
    clearToken();
  },

  /** Rehydrate the session on app load (sends the stored bearer token). */
  async me(): Promise<User> {
    return http.get<User>(endpoints.auth.me());
  },
};
