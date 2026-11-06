import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { AuthService, type GoogleVerifier } from "../src/auth/auth.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";

const logger = createLogger({ level: "silent", pretty: false });
const SECRET = "unit-test-secret-at-least-16-chars";
const profile = { id: "u1", email: "u1@example.com", name: "User One" };

const makeAuth = (extra: Partial<ConstructorParameters<typeof AuthService>[0]> = {}) =>
  new AuthService({ secret: SECRET, adminIds: () => ["admin-1"], ...extra });

const makeApp = (auth: AuthService, devLogin = false) =>
  createApp({ env: { CORS_ORIGINS: [] }, logger, clientCount: () => 0, auth, devLogin });

describe("AuthService", () => {
  it("round-trips a token and derives the role from ADMIN_USER_IDS", () => {
    const auth = makeAuth();
    const { token, user } = auth.issue(profile);
    expect(user).toEqual({ ...profile, role: "user", pro: false });
    expect(auth.verify(token)).toEqual({ ...profile, role: "user", pro: false });

    const admin = auth.issue({ ...profile, id: "admin-1" });
    expect(auth.verify(admin.token)?.role).toBe("admin");
  });

  it("applies admin list changes immediately (role is not baked into the token)", () => {
    let admins: string[] = [];
    const auth = makeAuth({ adminIds: () => admins });
    const { token } = auth.issue(profile);
    expect(auth.verify(token)?.role).toBe("user");
    admins = ["u1"];
    expect(auth.verify(token)?.role).toBe("admin");
  });

  it("rejects tampered, foreign-secret, expired and garbage tokens", () => {
    const auth = makeAuth();
    const { token } = auth.issue(profile);
    expect(auth.verify(token + "x")).toBeNull();
    expect(auth.verify("not.a.jwt")).toBeNull();
    expect(makeAuth({ secret: "another-secret-of-sufficient-length" }).verify(token)).toBeNull();
    const expired = jwt.sign({ sub: "u1" }, SECRET, { algorithm: "HS256", expiresIn: -10 });
    expect(auth.verify(expired)).toBeNull();
    const noneAlg = jwt.sign({ sub: "u1" }, "", { algorithm: "none" } as jwt.SignOptions);
    expect(auth.verify(noneAlg)).toBeNull();
  });
});

describe("auth routes", () => {
  it("GET /api/auth/me: 401 without a token, 401 with a bad one, 200 with a good one", async () => {
    const auth = makeAuth();
    const app = makeApp(auth);
    expect((await request(app).get("/api/auth/me").expect(401)).body.error.code).toBe("UNAUTHORIZED");
    expect((await request(app).get("/api/auth/me").set("Authorization", "Bearer nope").expect(401)).body.error.code).toBe("INVALID_TOKEN");
    const { token } = auth.issue(profile);
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`).expect(200);
    expect(res.body.user).toEqual({ id: profile.id, email: profile.email, name: profile.name });
  });

  it("dev login does not exist unless enabled", async () => {
    await request(makeApp(makeAuth(), false)).post("/api/auth/dev-login").send({}).expect(404);
    const res = await request(makeApp(makeAuth(), true)).post("/api/auth/dev-login").send({ userId: "tester" }).expect(200);
    expect(res.body.user).toMatchObject({ id: "tester", role: "user" });
    expect(typeof res.body.token).toBe("string");
    await request(makeApp(makeAuth(), true)).post("/api/auth/dev-login").send({ userId: "bad id!" }).expect(400);
  });

  it("dev login cannot mint an admin unless the id is in ADMIN_USER_IDS", async () => {
    const res = await request(makeApp(makeAuth(), true)).post("/api/auth/dev-login").send({ userId: "admin-1" }).expect(200);
    expect(res.body.user.role).toBe("admin"); // only because the operator listed that id
    const other = await request(makeApp(makeAuth(), true)).post("/api/auth/dev-login").send({ userId: "random", name: "admin" }).expect(200);
    expect(other.body.user.role).toBe("user");
  });

  it("POST /api/auth/google: 503 when not configured, token on success, 401 on a rejected token", async () => {
    const body = { idToken: "x".repeat(30) };
    await request(makeApp(makeAuth())).post("/api/auth/google").send(body).expect(503);

    const ok: GoogleVerifier = async () => ({ id: "google:123", email: "g@example.com", name: "G" });
    const res = await request(makeApp(makeAuth({ verifyGoogle: ok }))).post("/api/auth/google").send(body).expect(200);
    expect(res.body.user).toMatchObject({ id: "google:123", email: "g@example.com", role: "user" });

    const bad: GoogleVerifier = async () => {
      throw new Error("Wrong recipient");
    };
    const rejected = await request(makeApp(makeAuth({ verifyGoogle: bad }))).post("/api/auth/google").send(body).expect(401);
    expect(rejected.body.error.code).toBe("INVALID_GOOGLE_TOKEN");
    await request(makeApp(makeAuth({ verifyGoogle: ok }))).post("/api/auth/google").send({}).expect(400);
  });
});
