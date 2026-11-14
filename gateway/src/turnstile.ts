// Optional Cloudflare Turnstile bot check before a "connect". Off unless both
// TURNSTILE_SITE_KEY and TURNSTILE_SECRET are set. A solved check earns a
// signed pass (bound to the client IP, valid PASS_TTL_MS) that later connects
// and silent reconnects present instead, so a real user sees the check at
// most once in that window.
import { createHmac, timingSafeEqual } from "node:crypto";

export const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY ?? "";
const SECRET = process.env.TURNSTILE_SECRET ?? "";
export const TURNSTILE_ENABLED = TURNSTILE_SITE_KEY !== "" && SECRET !== "";

const PASS_TTL_MS = 12 * 60 * 60 * 1000;
// Derived from the secret, so passes survive a gateway restart.
const PASS_KEY = createHmac("sha256", SECRET).update("webspeak3-turnstile-pass").digest();

const sign = (ip: string, expires: number) =>
  createHmac("sha256", PASS_KEY).update(`${ip}|${expires}`).digest("base64url");

export function issuePass(ip: string): string {
  const expires = Date.now() + PASS_TTL_MS;
  return `${expires}.${sign(ip, expires)}`;
}

export function isValidPass(pass: unknown, ip: string): boolean {
  if (typeof pass !== "string") return false;
  const [exp, mac] = pass.split(".");
  const expires = Number(exp);
  if (!Number.isFinite(expires) || expires < Date.now() || !mac) return false;
  const expected = Buffer.from(sign(ip, expires));
  const given = Buffer.from(mac);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function verifyToken(token: unknown, ip: string): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret: SECRET, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (!data.success) console.warn(`[turnstile] rejected: ${(data["error-codes"] ?? []).join(",")}`);
    return data.success === true;
  } catch (err) {
    console.warn(`[turnstile] siteverify failed: ${err}`);
    return false;
  }
}
