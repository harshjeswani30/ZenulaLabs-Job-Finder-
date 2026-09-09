import { describe, it, expect, beforeEach, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { hashPassword, verifyPassword, createSessionToken, verifySessionToken } from "../src/lib/auth";

const H = { "x-internal-token": env.INTERNAL_TOKEN, "content-type": "application/json" };

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM configs; DELETE FROM jobs; DELETE FROM user_jobs; DELETE FROM runs; DELETE FROM bot_links; DELETE FROM users;`);
});

describe("auth primitives", () => {
  it("hashes and verifies passwords", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("pbkdf2:")).toBe(true);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("produces unique hashes per call", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("signs and verifies session tokens", async () => {
    const token = await createSessionToken("user-123", "secret");
    expect(await verifySessionToken(token, "secret")).toBe("user-123");
    expect(await verifySessionToken(token, "other-secret")).toBeNull();
    expect(await verifySessionToken("v1.user-123.abc.def", "secret")).toBeNull();
  });
});

describe("auth endpoints", () => {
  it("signup returns a session and stores the user", async () => {
    const res = await SELF.fetch("https://example.com/auth/signup", {
      method: "POST", headers: H,
      body: JSON.stringify({ email: "A@Example.com", password: "password123" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { id: string; email: string } };
    expect(body.user.email).toBe("a@example.com"); // normalized to lowercase
    expect(body.token.startsWith("v1.")).toBe(true);

    const row = await env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(body.user.id).first<{ email: string }>();
    expect(row!.email).toBe("a@example.com");
  });

  it("rejects duplicate email", async () => {
    const first = await SELF.fetch("https://example.com/auth/signup", {
      method: "POST", headers: H, body: JSON.stringify({ email: "dup@example.com", password: "password123" }),
    });
    expect(first.status).toBe(200);
    const dup = await SELF.fetch("https://example.com/auth/signup", {
      method: "POST", headers: H, body: JSON.stringify({ email: "dup@example.com", password: "password456" }),
    });
    expect(dup.status).toBe(409);
  });

  it("rejects weak passwords and bad emails", async () => {
    const shortPw = await SELF.fetch("https://example.com/auth/signup", {
      method: "POST", headers: H, body: JSON.stringify({ email: "a@b.co", password: "short" }),
    });
    expect(shortPw.status).toBe(400);
    const badEmail = await SELF.fetch("https://example.com/auth/signup", {
      method: "POST", headers: H, body: JSON.stringify({ email: "not-an-email", password: "password123" }),
    });
    expect(badEmail.status).toBe(400);
  });

  it("login with wrong password fails, right password works", async () => {
    await SELF.fetch("https://example.com/auth/signup", {
      method: "POST", headers: H, body: JSON.stringify({ email: "login@example.com", password: "password123" }),
    });
    const bad = await SELF.fetch("https://example.com/auth/login", {
      method: "POST", headers: H, body: JSON.stringify({ email: "login@example.com", password: "nope-nope" }),
    });
    expect(bad.status).toBe(401);
    const good = await SELF.fetch("https://example.com/auth/login", {
      method: "POST", headers: H, body: JSON.stringify({ email: "LOGIN@example.com", password: "password123" }),
    });
    expect(good.status).toBe(200);
    const body = (await good.json()) as { token: string };
    expect(body.token.startsWith("v1.")).toBe(true);
  });

  it("auth/me resolves a Bearer session", async () => {
    const signup = await SELF.fetch("https://example.com/auth/signup", {
      method: "POST", headers: H, body: JSON.stringify({ email: "me@example.com", password: "password123" }),
    });
    const { token, user } = (await signup.json()) as { token: string; user: { id: string } };
    const res = await SELF.fetch("https://example.com/auth/me", {
      headers: { ...H, authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const me = (await res.json()) as { id: string; email: string };
    expect(me.id).toBe(user.id);
    expect(me.email).toBe("me@example.com");
  });

  it("auth/me rejects without a session", async () => {
    const res = await SELF.fetch("https://example.com/auth/me", { headers: H });
    expect(res.status).toBe(401);
  });
});

describe("user scoping", () => {
  async function signupUser(email: string): Promise<{ token: string; id: string }> {
    const res = await SELF.fetch("https://example.com/auth/signup", {
      method: "POST", headers: H, body: JSON.stringify({ email, password: "password123" }),
    });
    const body = (await res.json()) as { token: string; user: { id: string } };
    return { token: body.token, id: body.user.id };
  }

  it("config writes are scoped to the session user", async () => {
    const alice = await signupUser("alice@example.com");
    const bob = await signupUser("bob@example.com");

    const save = await SELF.fetch("https://example.com/config", {
      method: "POST",
      headers: { ...H, authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ fields: ["Frontend"], skills: ["React"], sites: [], scoreThreshold: 80, cadenceHours: 2, isActive: true }),
    });
    expect(save.status).toBe(200);

    const aliceCfg = await (await SELF.fetch("https://example.com/config", {
      headers: { ...H, authorization: `Bearer ${alice.token}` },
    })).json() as { fields: string[] };
    expect(aliceCfg.fields).toEqual(["Frontend"]);

    const bobCfg = await (await SELF.fetch("https://example.com/config", {
      headers: { ...H, authorization: `Bearer ${bob.token}` },
    })).json() as { fields: string[] };
    expect(bobCfg.fields).toEqual([]);
  });

  it("runs listing only shows the session user's runs", async () => {
    const alice = await signupUser("alice2@example.com");
    await env.DB.exec(`INSERT INTO runs (id, user_id, started_at, status, duration_ms) VALUES ('r1', '${alice.id}', 1, 'ok', 1)`);
    await env.DB.exec(`INSERT INTO runs (id, user_id, started_at, status, duration_ms) VALUES ('r2', 'someone-else', 1, 'ok', 1)`);

    const res = await SELF.fetch("https://example.com/runs", {
      headers: { ...H, authorization: `Bearer ${alice.token}` },
    });
    const runs = (await res.json()) as { id: string; user_id: string }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe("r1");
  });

  it("bot connect links carry the session user and the webhook wires that user's config", async () => {
    const carol = await signupUser("carol@example.com");
    await env.DB.exec(`INSERT INTO configs (user_id, updated_at) VALUES ('${carol.id}', 0)`);

    // /bot/connect calls Telegram getMe — mock it like api.spec.ts does
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, result: { username: "testbot" } }), { status: 200 }));
    try {
      const connect = await SELF.fetch("https://example.com/bot/connect", {
        method: "POST", headers: { ...H, authorization: `Bearer ${carol.token}` },
      });
      expect(connect.status).toBe(200);
      const { token } = (await connect.json()) as { token: string };

      // simulate the Telegram webhook START with the connect token
      await SELF.fetch(`https://example.com/telegram/webhook/${env.INTERNAL_TOKEN}`, {
        method: "POST",
        body: JSON.stringify({ message: { text: `/start ${token}`, chat: { id: 4242 } } }),
      });
    } finally {
      fetchSpy.mockRestore();
    }

    const cfg = await env.DB.prepare(`SELECT telegram_chat_id FROM configs WHERE user_id = ?`).bind(carol.id)
      .first<{ telegram_chat_id: string | null }>();
    expect(cfg!.telegram_chat_id).toBe("4242");
  });

  it("forged session tokens are rejected", async () => {
    await signupUser("dave@example.com");
    const res = await SELF.fetch("https://example.com/config", {
      headers: { ...H, authorization: "Bearer v1.forged-user.99999999999999.Zm9yZ2Vk" },
    });
    expect(res.status).toBe(401);
  });
});
