// Stateless auth for the SaaS layer: PBKDF2 password hashing and HMAC-signed
// session tokens, both built on Web Crypto so the same code runs in the
// Workers runtime and in vitest-pool-workers.

const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_MS = 30 * 24 * 3_600_000;

const enc = new TextEncoder();

function b64encode(buf: ArrayBuffer): string {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64urlEncode(buf: ArrayBuffer): string {
  return b64encode(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2:${PBKDF2_ITERATIONS}:${b64encode(salt.buffer as ArrayBuffer)}:${b64encode(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const salt = Uint8Array.from(atob(parts[2]), (c) => c.charCodeAt(0));
  const expected = Uint8Array.from(atob(parts[3]), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    expected.length * 8,
  ));
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i]! ^ expected[i]!;
  return diff === 0;
}

/** Token format: v1.<userId>.<expiryMs>.<hmac_b64url(userId + "." + expiryMs)> */
export async function createSessionToken(userId: string, secret: string): Promise<string> {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${userId}.${exp}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `v1.${payload}.${b64urlEncode(sig)}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, userId, expStr, sigB64] = parts as [string, string, string, string];
  const exp = Number(expStr);
  if (!userId || !Number.isFinite(exp) || exp < Date.now()) return null;
  const sig = Uint8Array.from(atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(`${userId}.${expStr}`));
  return ok ? userId : null;
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice("Bearer ".length) : null;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
