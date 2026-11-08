import jwt from "jsonwebtoken";
import type { Role, User } from "../types/index.js";
import type { UserStore } from "./userStore.js";

export interface GoogleProfile {
  /** Google's stable account id, prefixed "google:". */
  id: string;
  email: string;
  name: string;
  /** True only when Google says the address is verified. An unverified address never grants admin. */
  emailVerified?: boolean;
}

export type GoogleVerifier = (idToken: string) => Promise<GoogleProfile>;

export interface AuthOptions {
  secret: string;
  /** User ids that get the admin role. Read on every check, so env changes apply immediately. */
  adminIds: () => string[];
  /** Verified Google emails that get the admin role (compared ignoring case). Read on every check. */
  adminEmails?: () => string[];
  /** Session length. Default 7 days. */
  tokenTtlSeconds?: number;
  verifyGoogle?: GoogleVerifier;
  /** When given, sign-ins are recorded here. */
  users?: UserStore;
}

interface Claims {
  sub: string;
  email: string;
  name: string;
  /** Google's email_verified, fixed when the session was issued (the token is signed, so the app cannot change it). */
  ev?: boolean;
}

export const SESSION_SECONDS = 7 * 24 * 3600;
/** A guest has no password to sign in with again, so a guest session lasts a year. */
export const GUEST_SESSION_SECONDS = 365 * 24 * 3600;

/**
 * Issues and verifies session tokens (HS256 JWT). The role is never stored in the token or on disk:
 * it is computed on every request from ADMIN_USER_IDS and the admin lists, so changes apply immediately.
 */
export class AuthService {
  private readonly ttl: number;

  constructor(private readonly opts: AuthOptions) {
    this.ttl = opts.tokenTtlSeconds ?? SESSION_SECONDS;
  }

  /**
   * admin (listed in ADMIN_USER_IDS, or a VERIFIED email listed in ADMIN_EMAILS) > user.
   * Computed on every request from the signed session and the current environment.
   */
  roleFor(userId: string, email = "", emailVerified = false): Role {
    if (this.opts.adminIds().includes(userId)) return "admin";
    const wanted = email.trim().toLowerCase();
    if (emailVerified && wanted && (this.opts.adminEmails?.() ?? []).some((e) => e.trim().toLowerCase() === wanted)) return "admin";
    return "user";
  }

  /** Records the sign-in (create or update the user) and returns a session token. */
  issue(profile: GoogleProfile, options: { ttlSeconds?: number } = {}): { token: string; user: User } {
    this.opts.users?.upsertOnLogin(profile);
    const claims: Claims = { sub: profile.id, email: profile.email, name: profile.name, ev: profile.emailVerified === true };
    const token = jwt.sign(claims, this.opts.secret, { algorithm: "HS256", expiresIn: options.ttlSeconds ?? this.ttl });
    return { token, user: this.toUser(claims) };
  }

  /** Returns the user for a valid, unexpired token, otherwise null. */
  verify(token: string): User | null {
    try {
      const claims = jwt.verify(token, this.opts.secret, { algorithms: ["HS256"] }) as Partial<Claims>;
      if (!claims.sub || typeof claims.sub !== "string") return null;
      return this.toUser({ sub: claims.sub, email: claims.email ?? "", name: claims.name ?? "", ev: claims.ev === true });
    } catch {
      return null;
    }
  }

  get googleEnabled(): boolean {
    return this.opts.verifyGoogle !== undefined;
  }

  verifyGoogle(idToken: string): Promise<GoogleProfile> {
    if (!this.opts.verifyGoogle) throw new Error("Google sign-in is not configured");
    return this.opts.verifyGoogle(idToken);
  }

  private toUser(c: Claims): User {
    const role = this.roleFor(c.sub, c.email, c.ev === true);
    return { id: c.sub, email: c.email, name: c.name, role };
  }
}

/** The part of google-auth-library's OAuth2Client that the verifier uses (so tests can substitute it). */
export interface IdTokenVerifierClient {
  verifyIdToken(options: { idToken: string; audience: string }): Promise<{ getPayload(): { sub?: string; email?: string; name?: string; email_verified?: boolean } | undefined }>;
}

/**
 * Production verifier: checks an ID token's signature, expiry and audience against GOOGLE_WEB_CLIENT_ID.
 * A token issued for any other client ID is rejected by the library.
 */
export async function createGoogleVerifier(clientId: string, client?: IdTokenVerifierClient): Promise<GoogleVerifier> {
  const verifier: IdTokenVerifierClient =
    client ?? new (await import("google-auth-library")).OAuth2Client(clientId);
  return async (idToken) => {
    const ticket = await verifier.verifyIdToken({ idToken, audience: clientId });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email) throw new Error("Google token has no subject or email");
    return { id: `google:${p.sub}`, email: p.email, name: p.name ?? p.email, emailVerified: p.email_verified === true };
  };
}
