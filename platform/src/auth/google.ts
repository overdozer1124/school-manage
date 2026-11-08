import { OAuth2Client } from "google-auth-library";
import type { AuthConfig } from "./config.js";

/**
 * The Google side of the OAuth flow, behind an interface so tests can
 * substitute a fake (Issue #5 allows a mock for Google). The default
 * implementation mirrors school-timetable's handleGoogleCallback: the
 * code is exchanged with google-auth-library's OAuth2Client and the id
 * token is verified against the client id.
 */
export interface GoogleProfile {
  googleId: string;
  email?: string | undefined;
  /**
   * Whether Google has verified the person owns this email address
   * (the id token's email_verified claim). An unverified email must
   * never be used to look a person up: anyone can register a Google
   * account carrying someone else's address.
   */
  emailVerified: boolean;
  name?: string | undefined;
}

export interface GoogleAuthClient {
  exchangeCode(code: string, redirectUri: string): Promise<{ idToken: string }>;
  verifyIdToken(idToken: string): Promise<GoogleProfile>;
}

export function createGoogleAuthClient(config: AuthConfig): GoogleAuthClient {
  const clientId = config.googleClientId;
  const clientSecret = config.googleClientSecret;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured");
  }
  return {
    async exchangeCode(code, redirectUri) {
      const client = new OAuth2Client(clientId, clientSecret, redirectUri);
      const { tokens } = await client.getToken(code);
      if (!tokens.id_token) {
        throw new Error("IDトークンの取得に失敗しました");
      }
      return { idToken: tokens.id_token };
    },
    async verifyIdToken(idToken) {
      const client = new OAuth2Client(clientId);
      const ticket = await client.verifyIdToken({ idToken, audience: clientId });
      const payload = ticket.getPayload();
      if (!payload?.sub) {
        throw new Error("IDトークンの検証に失敗しました");
      }
      return {
        googleId: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified === true,
        name: payload.name,
      };
    },
  };
}
