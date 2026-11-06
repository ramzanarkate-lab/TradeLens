import { describe, expect, it } from "vitest";
import { AuthService, createGoogleVerifier, type IdTokenVerifierClient } from "../src/auth/auth.js";

const WEB_ID = "web-client.apps.googleusercontent.com";

/** Behaves like google-auth-library: it throws unless the token's audience equals the one we ask for. */
function clientFor(tokenAudience: string, email = "someone@example.com"): IdTokenVerifierClient {
  return {
    verifyIdToken: async ({ audience }) => {
      if (audience !== tokenAudience) throw new Error("Wrong recipient, payload audience != requiredAudience");
      return { getPayload: () => ({ sub: "1", email, name: "N", email_verified: true }) };
    },
  };
}

describe("Google ID token audience", () => {
  it("rejects a token issued for a different client ID", async () => {
    const verify = await createGoogleVerifier(WEB_ID, clientFor("android-client.apps.googleusercontent.com"));
    await expect(verify("token")).rejects.toThrow(/Wrong recipient/);
  });

  it("accepts a token whose audience is the web client ID", async () => {
    const verify = await createGoogleVerifier(WEB_ID, clientFor(WEB_ID));
    await expect(verify("token")).resolves.toMatchObject({ email: "someone@example.com", emailVerified: true });
  });

  it("a verified ramzanarkate@gmail.com is admin, any other email is a plain user", async () => {
    const make = async (email: string) =>
      new AuthService({
        secret: "a-long-enough-test-secret",
        adminIds: () => [],
        adminEmails: () => ["ramzanarkate@gmail.com"],
        verifyGoogle: await createGoogleVerifier(WEB_ID, clientFor(WEB_ID, email)),
      });
    const admin = await make("ramzanarkate@gmail.com");
    expect(admin.issue(await admin.verifyGoogle("t")).user.role).toBe("admin");
    const other = await make("other@gmail.com");
    expect(other.issue(await other.verifyGoogle("t")).user.role).toBe("user");
  });
});
