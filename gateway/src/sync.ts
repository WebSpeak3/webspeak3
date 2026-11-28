// --- Account sync (Options -> Konto) --------------------------------------------
//
// Mullvad-style: no e-mail, no name. The client derives an account id, an AES key
// and an auth secret from a random account number (+ optional random password),
// so this server only ever holds id -> encrypted blob. It never sees the number,
// the password or the key. No IP addresses or request logs are kept.
//
// One JSON file per account in SYNC_DATA_DIR. Only served by sync-server.ts.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { clientIp, createRateLimiter, writeFileAtomic } from "./net.js";

const SYNC_DATA_DIR = process.env.SYNC_DATA_DIR;
const SYNC_ALLOWED_ORIGIN = process.env.SYNC_ALLOWED_ORIGIN ?? "*";
// Creating an account costs the browser a few seconds of hashing, so mass sign-ups
// get expensive without asking anyone for personal data.
// 15 bits = ~33k hashes on average, a few seconds on a phone.
const POW_BITS = Number(process.env.SYNC_POW_BITS ?? 15);
const MAX_ACCOUNTS = Number(process.env.SYNC_MAX_ACCOUNTS ?? 100_000);
// ~1 MB plaintext after base64 and AES-GCM overhead.
const MAX_DATA_LENGTH = 1_500_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_MS = 365 * DAY_MS;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

const isRateLimited = createRateLimiter(300, 60 * 60 * 1000);
const isCreateRateLimited = createRateLimiter(5, 60 * 60 * 1000);
// Fresh per process: a restart only invalidates challenges handed out in the last 10 minutes.
const challengeSecret = randomBytes(32);
const usedChallenges = new Map<string, number>();

interface Account {
  authHash: string;
  version: number;
  hasPassword: boolean;
  data: string;
  updatedAt: number;
  accessedAt: number;
}

const ID_RE = /^[0-9a-f]{64}$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const file = (id: string) => path.join(SYNC_DATA_DIR!, `${id}.json`);

let accountCount = 0;
let ready: Promise<void> | null = null;

async function init() {
  await mkdir(SYNC_DATA_DIR!, { recursive: true });
  await sweep();
  setInterval(() => void sweep().catch((err) => console.error("[sync] Sweep failed:", err)), DAY_MS).unref();
}

/** Accounts nobody opened for a year are deleted for good. */
async function sweep() {
  const names = (await readdir(SYNC_DATA_DIR!)).filter((n) => n.endsWith(".json"));
  let left = 0;
  for (const name of names) {
    const id = name.slice(0, -5);
    const account = await load(id);
    if (account && Date.now() - account.accessedAt > EXPIRY_MS) await rm(file(id), { force: true });
    else left++;
  }
  accountCount = left;
}

async function load(id: string): Promise<Account | null> {
  try {
    return JSON.parse(await readFile(file(id), "utf-8")) as Account;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function save(id: string, account: Account) {
  await writeFileAtomic(file(id), JSON.stringify(account));
}

// Writes to one account run one after another, so the version check can't race.
const locks = new Map<string, Promise<unknown>>();
function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  void tail.then(() => locks.get(id) === tail && locks.delete(id));
  return run;
}

function authorized(req: IncomingMessage, account: Account): boolean {
  const auth = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? "")?.[1];
  if (!auth) return false;
  return timingSafeEqual(Buffer.from(sha256(auth)), Buffer.from(account.authHash));
}

function newChallenge(): string {
  const body = `${Date.now()}.${randomBytes(16).toString("hex")}`;
  return `${body}.${createHmac("sha256", challengeSecret).update(body).digest("hex")}`;
}

/** sha256(challenge + ":" + nonce) has to start with POW_BITS zero bits. */
export function leadingZeroBits(hex: string): number {
  let bits = 0;
  for (const c of hex) {
    const n = parseInt(c, 16);
    if (n === 0) {
      bits += 4;
      continue;
    }
    return bits + Math.clz32(n) - 28;
  }
  return bits;
}

function validPow(pow: unknown): boolean {
  if (!pow || typeof pow !== "object") return false;
  const { challenge, nonce } = pow as { challenge?: unknown; nonce?: unknown };
  if (typeof challenge !== "string" || typeof nonce !== "string" || nonce.length > 32) return false;
  const [ts, rand, mac] = challenge.split(".");
  if (!ts || !rand || !mac) return false;
  const expected = createHmac("sha256", challengeSecret).update(`${ts}.${rand}`).digest("hex");
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  const age = Date.now() - Number(ts);
  if (!(age >= 0 && age < CHALLENGE_TTL_MS) || usedChallenges.has(challenge)) return false;
  if (leadingZeroBits(sha256(`${challenge}:${nonce}`)) < POW_BITS) return false;
  for (const [c, at] of usedChallenges) if (Date.now() - at > CHALLENGE_TTL_MS) usedChallenges.delete(c);
  usedChallenges.set(challenge, Date.now());
  return true;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, max: number): Promise<Record<string, unknown> | "too_large" | null> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > max) return "too_large";
  }
  try {
    const body = JSON.parse(raw || "{}");
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

export async function handleSync(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (!SYNC_DATA_DIR) return json(res, 404, { error: "not_found" });
  res.setHeader("Access-Control-Allow-Origin", SYNC_ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (isRateLimited(clientIp(req))) return json(res, 429, { error: "rate_limited" });
  ready ??= init();
  await ready;

  if (pathname === "/api/sync/challenge" && req.method === "POST") {
    return json(res, 200, { challenge: newChallenge(), bits: POW_BITS });
  }

  const match = /^\/api\/sync\/([0-9a-f]{64})(\/meta)?$/.exec(pathname);
  if (!match || !ID_RE.test(match[1])) return json(res, 404, { error: "not_found" });
  const id = match[1];

  // Tells a new device whether to ask for the password. Only someone holding the
  // account number can compute the id in the first place.
  if (match[2]) {
    if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
    const account = await load(id);
    return json(res, 200, account ? { exists: true, hasPassword: account.hasPassword, version: account.version } : { exists: false });
  }

  if (req.method === "GET") {
    const account = await load(id);
    if (!account || !authorized(req, account)) return json(res, 404, { error: "not_found" });
    // Touch at most once a day instead of rewriting the file on every read.
    if (Date.now() - account.accessedAt > DAY_MS) {
      await locked(id, async () => {
        const fresh = await load(id);
        if (fresh) await save(id, { ...fresh, accessedAt: Date.now() });
      });
    }
    return json(res, 200, { version: account.version, data: account.data, updatedAt: account.updatedAt });
  }

  if (req.method === "DELETE") {
    return locked(id, async () => {
      const account = await load(id);
      if (!account || !authorized(req, account)) return json(res, 404, { error: "not_found" });
      await rm(file(id), { force: true });
      accountCount--;
      json(res, 200, { ok: true });
    });
  }

  if (req.method !== "PUT") return json(res, 405, { error: "method_not_allowed" });
  const body = await readBody(req, MAX_DATA_LENGTH + 2_000);
  if (body === "too_large") return json(res, 413, { error: "payload_too_large" });
  if (!body) return json(res, 400, { error: "invalid_json" });
  const { version, data, hasPassword, newAuth, pow } = body;
  if (typeof version !== "number" || typeof data !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(data)) {
    return json(res, 400, { error: "invalid_body" });
  }
  if (newAuth !== undefined && (typeof newAuth !== "string" || !ID_RE.test(newAuth))) {
    return json(res, 400, { error: "invalid_body" });
  }

  return locked(id, async () => {
    const account = await load(id);
    const now = Date.now();
    if (!account) {
      // Creating: the bearer token becomes the account's auth secret.
      const auth = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? "")?.[1];
      if (!auth || version !== 0) return json(res, 400, { error: "invalid_body" });
      if (accountCount >= MAX_ACCOUNTS) return json(res, 507, { error: "full" });
      if (isCreateRateLimited(clientIp(req))) return json(res, 429, { error: "rate_limited" });
      if (!validPow(pow)) return json(res, 403, { error: "pow_required" });
      await save(id, { authHash: sha256(auth), version: 1, hasPassword: hasPassword === true, data, updatedAt: now, accessedAt: now });
      accountCount++;
      return json(res, 200, { version: 1 });
    }
    if (!authorized(req, account)) return json(res, 404, { error: "not_found" });
    // Another device wrote in between: the client decides what wins.
    if (version !== account.version) return json(res, 409, { error: "conflict", version: account.version });
    await save(id, {
      authHash: typeof newAuth === "string" ? sha256(newAuth) : account.authHash,
      version: account.version + 1,
      hasPassword: typeof hasPassword === "boolean" ? hasPassword : account.hasPassword,
      data,
      updatedAt: now,
      accessedAt: now,
    });
    json(res, 200, { version: account.version + 1 });
  });
}
