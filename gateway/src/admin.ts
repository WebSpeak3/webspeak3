// Admin panel at /admin: change the live settings from config.ts in the
// browser. Off unless both ADMIN_USER and ADMIN_PASSWORD are set (404
// otherwise). Optional ADMIN_TOTP_SECRET (base32) adds a 6-digit
// authenticator code to the login.
//
// The panel can also change the password and switch 2FA on or off. Those
// land in ADMIN_AUTH_FILE (next to the settings file) and override .env;
// every such change asks for the current password again, so a stolen session
// alone can't lock the operator out. Deleting that file goes back to .env.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import qrcode from "qrcode-generator";
import { clientIp, createRateLimiter } from "./net.js";
import { describeSettings, updateSettings, validate } from "./config.js";

const ADMIN_USER = process.env.ADMIN_USER ?? "";
const ENV_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const ENV_TOTP = (process.env.ADMIN_TOTP_SECRET ?? "").replace(/[\s=]/g, "").toUpperCase();
export const ADMIN_ENABLED = ADMIN_USER !== "" && ENV_PASSWORD !== "";

const AUTH_FILE = process.env.ADMIN_AUTH_FILE
  ?? path.join(path.dirname(process.env.ADMIN_CONFIG_FILE ?? path.resolve(process.cwd(), "admin-config.json")), "admin-auth.json");
// Set from the panel. totpSecret "" = 2FA switched off there (wins over .env).
let auth: { passwordHash?: string; totpSecret?: string } = {};
try {
  const raw = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
  if (typeof raw?.passwordHash === "string") auth.passwordHash = raw.passwordHash;
  if (typeof raw?.totpSecret === "string") auth.totpSecret = raw.totpSecret;
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[admin] Ignoring unreadable ${AUTH_FILE}:`, err);
}
const totpSecret = () => auth.totpSecret ?? ENV_TOTP;
async function saveAuth(next: typeof auth) {
  const tmp = `${AUTH_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(tmp, AUTH_FILE);
  auth = next;
}

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64url")}$${(await scryptAsync(pw, salt, 32)).toString("base64url")}`;
}
async function passwordOk(pw: string): Promise<boolean> {
  if (!auth.passwordHash) return sameString(pw, ENV_PASSWORD);
  const [, salt = "", hash = ""] = auth.passwordHash.split("$");
  const want = Buffer.from(hash, "base64url");
  const got = await scryptAsync(pw, Buffer.from(salt, "base64url"), 32);
  return want.length === got.length && timingSafeEqual(want, got);
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE = "webspeak3_admin";
const sessions = new Map<string, number>(); // token -> expiry
// Every attempt counts, so a right guess can't be hidden between wrong ones.
const tooManyFromIp = createRateLimiter(5, 15 * 60_000);
const tooManyOverall = createRateLimiter(30, 15 * 60_000);
const tooManyReauth = createRateLimiter(10, 15 * 60_000);
let lastTotpCounter = -1; // a code works once, even within its window

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const sameString = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of s) {
    const i = B32.indexOf(c);
    if (i === -1) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + B32[(value << (5 - bits)) & 31] : out;
}

/** RFC 6238 code (SHA-1, 6 digits, 30 s) for a given time step. */
export function totp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** Accepts the current code and one step either side (clock drift). */
/** Time step the code matches (±1 step of clock drift, only steps after `after`), or -1. */
function matchTotp(secretB32: string, code: unknown, after = -1): number {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return -1;
  const secret = base32Decode(secretB32);
  const now = Math.floor(Date.now() / 30_000);
  for (const c of [now - 1, now, now + 1]) {
    if (c > after && sameString(totp(secret, c), code)) return c;
  }
  return -1;
}

function checkTotp(code: unknown): boolean {
  const c = matchTotp(totpSecret(), code, lastTotpCounter);
  if (c < 0) return false;
  lastTotpCounter = c;
  return true;
}

if (ADMIN_ENABLED && totpSecret()) {
  try {
    if (base32Decode(totpSecret()).length < 10) throw new Error("too short");
  } catch (err) {
    // Fail closed: a typo here must not silently drop the second factor.
    console.error(`[admin] ADMIN_TOTP_SECRET is not valid base32 (${(err as Error).message}); login disabled`);
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return undefined;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function sessionOf(req: IncomingMessage): string | undefined {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`).exec(req.headers.cookie ?? "");
  if (!m) return undefined;
  const expires = sessions.get(m[1]);
  if (!expires || expires < Date.now()) {
    sessions.delete(m[1]);
    return undefined;
  }
  return m[1];
}

function cookie(req: IncomingMessage, value: string, maxAgeS: number): string {
  // Secure only where the browser actually talks HTTPS, else a plain-HTTP
  // LAN setup could never log in.
  const https = (req.socket as TLSSocket).encrypted || req.headers["x-forwarded-proto"] === "https";
  return `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${https ? "; Secure" : ""}`;
}

async function handleLogin(req: IncomingMessage, res: ServerResponse) {
  const ip = clientIp(req);
  if (tooManyFromIp(ip) || tooManyOverall("all")) {
    console.warn("[admin] login rate-limited");
    return json(res, 429, { error: "rate_limited" });
  }
  const body = await readJson(req);
  const userOk = sameString(String(body?.user ?? ""), ADMIN_USER);
  const passOk = await passwordOk(String(body?.password ?? ""));
  // The code is only used up by a fully successful login, so a password typo
  // doesn't burn it.
  let step = -1;
  if (totpSecret()) {
    try {
      step = matchTotp(totpSecret(), body?.code, lastTotpCounter);
    } catch {
      step = -1;
    }
  }
  if (!(userOk && passOk && (step >= 0 || !totpSecret()))) {
    console.warn("[admin] failed login");
    return json(res, 401, { error: "invalid_login" });
  }
  if (step >= 0) lastTotpCounter = step;
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  for (const [t, exp] of sessions) if (exp < Date.now()) sessions.delete(t);
  console.log("[admin] login");
  json(res, 200, { ok: true }, { "Set-Cookie": cookie(req, token, SESSION_TTL_MS / 1000) });
}

let countConnections = () => 0;
/** index.ts hands in its WebSocket server's client count (shown before a restart). */
export function setConnectionCounter(fn: () => number) {
  countConnections = fn;
}
const state = () => ({
  settings: describeSettings(),
  totp: totpSecret() ? (auth.totpSecret ? "panel" : "env") : "",
  passwordFromPanel: Boolean(auth.passwordHash),
  connections: countConnections(),
  version: process.env.WEBSPEAK3_VERSION || "",
  uptime: Math.round(process.uptime()),
});

// Credential changes re-check the current password (own limiter, so a few
// panel actions don't eat the login budget).
async function reauth(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown> | undefined): Promise<boolean> {
  if (tooManyReauth(clientIp(req))) return json(res, 429, { error: "rate_limited" }), false;
  if (!(await passwordOk(String(body?.password ?? "")))) {
    console.warn("[admin] wrong password on credential change");
    return json(res, 403, { error: "wrong_password" }), false;
  }
  return true;
}

export async function handleAdmin(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (!ADMIN_ENABLED) return json(res, 404, { error: "not_found" });
  if (pathname === "/admin" || pathname === "/admin/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "X-Frame-Options": "DENY",
    });
    return res.end(PAGE);
  }
  if (pathname === "/admin/admin.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(SCRIPT);
  }
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  // Cross-site requests can't set this header without a CORS preflight,
  // which this endpoint never grants: CSRF protection on top of SameSite.
  if (req.method === "POST" && req.headers["x-webspeak3-admin"] !== "1") return json(res, 403, { error: "forbidden" });

  if (pathname === "/admin/api/login" && req.method === "POST") return handleLogin(req, res);

  const session = sessionOf(req);
  if (!session) return json(res, 401, { error: "unauthorized" });

  if (pathname === "/admin/api/logout" && req.method === "POST") {
    sessions.delete(session);
    return json(res, 200, { ok: true }, { "Set-Cookie": cookie(req, "", 0) });
  }
  if (pathname === "/admin/api/config" && req.method === "GET") return json(res, 200, state());
  if (pathname === "/admin/api/restart" && req.method === "POST") {
    console.log(`[admin] restart requested (${countConnections()} connected)`);
    json(res, 200, { ok: true });
    // Same graceful path as `docker stop`: users get the restart notice, TS
    // sessions are closed. Coming back up is the supervisor's job (Docker's
    // restart policy, systemd Restart=always).
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 300);
    return;
  }
  if (pathname === "/admin/api/config" && req.method === "POST") {
    const body = await readJson(req);
    const changes = body?.changes;
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) return json(res, 400, { error: "bad_request" });
    const clean: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (value !== null && typeof value !== "string") return json(res, 400, { error: "bad_request", key });
      // null = reset to .env; then only the key itself has to be known.
      const err = value === null ? (validate(key, "") === "unknown setting" ? "unknown setting" : undefined) : validate(key, value.trim());
      if (err) return json(res, 400, { error: err, key });
      clean[key] = value === null ? null : value.trim();
    }
    await updateSettings(clean);
    console.log(`[admin] settings changed: ${Object.keys(clean).join(", ")}`);
    return json(res, 200, state());
  }
  if (pathname === "/admin/api/totp-secret" && req.method === "GET") {
    const secret = base32Encode(randomBytes(20));
    const label = encodeURIComponent(`WebSpeak3:${ADMIN_USER}`);
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=WebSpeak3`;
    const qr = qrcode(0, "M");
    qr.addData(uri);
    qr.make();
    return json(res, 200, { secret, uri, qr: qr.createDataURL(5, 4) });
  }
  // Setup check: does the authenticator app produce codes for the secret
  // just generated? Only then the panel shows the .env line.
  if (pathname === "/admin/api/totp-verify" && req.method === "POST") {
    const body = await readJson(req);
    const secret = String(body?.secret ?? "");
    if (!/^[A-Z2-7]{16,64}$/.test(secret)) return json(res, 400, { error: "bad_request" });
    return json(res, 200, { ok: matchTotp(secret, String(body?.code ?? "").trim()) >= 0 });
  }
  if (pathname === "/admin/api/totp-enable" && req.method === "POST") {
    const body = await readJson(req);
    const secret = String(body?.secret ?? "");
    if (!/^[A-Z2-7]{16,64}$/.test(secret)) return json(res, 400, { error: "bad_request" });
    if (!(await reauth(req, res, body))) return;
    const c = matchTotp(secret, String(body?.code ?? "").trim());
    if (c < 0) return json(res, 400, { error: "code_wrong" });
    await saveAuth({ ...auth, totpSecret: secret });
    lastTotpCounter = c; // the code just typed can't be replayed at login
    console.log("[admin] 2FA switched on in the panel");
    return json(res, 200, state());
  }
  if (pathname === "/admin/api/totp-disable" && req.method === "POST") {
    const body = await readJson(req);
    if (!(await reauth(req, res, body))) return;
    if (!checkTotp(String(body?.code ?? "").trim())) return json(res, 400, { error: "code_wrong" });
    await saveAuth({ ...auth, totpSecret: "" });
    console.log("[admin] 2FA switched off in the panel");
    return json(res, 200, state());
  }
  if (pathname === "/admin/api/password" && req.method === "POST") {
    const body = await readJson(req);
    const next = String(body?.newPassword ?? "");
    if (next.length < 10 || next.length > 200) return json(res, 400, { error: "weak_password" });
    if (!(await reauth(req, res, body))) return;
    await saveAuth({ ...auth, passwordHash: await hashPassword(next) });
    for (const t of sessions.keys()) if (t !== session) sessions.delete(t); // other logins end
    console.log("[admin] password changed in the panel");
    return json(res, 200, state());
  }
  json(res, 404, { error: "not_found" });
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>WebSpeak3 Admin</title><style>
:root{color-scheme:light;--bg:#f4f6f8;--card:#fff;--fg:#1b1f24;--muted:#5f6b7a;--line:#dde2e8;--field:#f7f9fb;--accent:#2f6fde;--on-accent:#fff;--bad:#c0392b;--warn:#a86200}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#131619;--card:#1c2025;--fg:#e6e9ed;--muted:#97a1ad;--line:#2f363e;--field:#15191d;--accent:#6a9cff;--on-accent:#0b1426;--bad:#ff6b5b;--warn:#f0b35a}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#131619;--card:#1c2025;--fg:#e6e9ed;--muted:#97a1ad;--line:#2f363e;--field:#15191d;--accent:#6a9cff;--on-accent:#0b1426;--bad:#ff6b5b;--warn:#f0b35a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:1320px;margin:0 auto;padding:20px 16px 0}
header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px}
h1{font-size:22px;margin:0}#stat{margin:2px 0 0}.tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--card)}
.seg button{background:transparent;color:var(--fg);border:0;border-radius:0;padding:6px 10px;font-size:13px}
.seg button[aria-pressed="true"]{background:var(--accent);color:var(--on-accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:20px;align-items:start}
.side{position:sticky;top:12px;display:flex;flex-direction:column;gap:10px}
#nav{display:flex;flex-direction:column;gap:2px}
#nav button{display:flex;justify-content:space-between;align-items:center;gap:8px;background:transparent;color:var(--fg);text-align:left;padding:8px 10px;border:1px solid transparent;border-radius:8px}
#nav button:hover{background:var(--card)}
#nav button[aria-current="true"]{background:var(--card);border-color:var(--line);font-weight:600;box-shadow:inset 3px 0 0 var(--accent)}
#nav button.muted{color:var(--muted)}#nav hr{width:100%;border:0;border-top:1px solid var(--line);margin:6px 0}
.cnt{font-size:12px;line-height:18px;min-width:18px;text-align:center;border-radius:9px;padding:0 6px;background:var(--accent);color:var(--on-accent);font-weight:600}.cnt.warnc{background:var(--warn)}
#content>#groups>.card,#extras>.card{margin-bottom:16px}
.rows{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr));column-gap:32px}
.rows .row{border-top:0;border-bottom:1px solid var(--line)}
.lab{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}.lab label{margin:0}
.badge{font-size:11px;padding:1px 8px;border-radius:9px;border:1px solid var(--line);color:var(--muted)}.badge.panel{border-color:var(--accent);color:var(--accent)}
.lab .reset{margin-left:auto;font-size:13px}.help{margin-top:4px}
@media (max-width:760px){.layout{grid-template-columns:minmax(0,1fr)}.side{position:static}#nav{flex-direction:row;overflow-x:auto;padding-bottom:4px}#nav button{flex:none;white-space:nowrap}#nav hr{display:none}}
h2{font-size:15px;margin:0 0 4px;padding-bottom:8px;border-bottom:2px solid var(--accent)}
label{display:block;font-weight:600;font-size:13px;margin-bottom:4px;font-family:ui-monospace,monospace}
input,select{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--field);color:var(--fg);font:inherit}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px}
button{padding:8px 14px;border:0;border-radius:6px;background:var(--accent);color:var(--on-accent);font:inherit;cursor:pointer}
button.plain{background:transparent;color:var(--accent);padding:2px 0}
.row{padding:12px 0;border-top:1px solid var(--line)}h2+.row{border-top:0}
.help,.meta{color:var(--muted);font-size:13px}.err{color:var(--bad);min-height:1.4em;margin:0}
.changed input,.changed select{border-color:var(--accent)}
.inactive input,.inactive select{opacity:.5}button.second{background:transparent;color:var(--accent);border:1px solid var(--accent)}button.second.due{background:var(--warn);border-color:var(--warn);color:var(--on-accent)}.warn{color:var(--warn);font-size:13px}
.foot{display:flex;justify-content:space-between;align-items:center;gap:8px}
.savebar{position:sticky;bottom:0;margin:16px -16px 0;padding:12px 16px;background:var(--bg);border-top:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
#pwCard input{max-width:420px}#login{max-width:380px;margin:40px auto}#login p{margin:0 0 12px}
code{word-break:break-all}[hidden]{display:none!important}
</style></head><body><main>
<header><div><h1>WebSpeak3 Admin</h1><p class="meta" id="stat" hidden></p></div><div class="tools">
<span class="seg" id="langSeg"><button type="button" data-lang="de">DE</button><button type="button" data-lang="en">EN</button></span>
<span class="seg" id="themeSeg"><button type="button" data-theme-btn="auto" data-i18n="auto"></button><button type="button" data-theme-btn="light" data-i18n="light"></button><button type="button" data-theme-btn="dark" data-i18n="dark"></button></span>
<button id="logout" class="plain" type="button" data-i18n="logout" hidden></button></div></header>
<form id="login" class="card" hidden>
<p><label for="u" data-i18n="user"></label><input id="u" autocomplete="username" required></p>
<p><label for="p" data-i18n="pass"></label><input id="p" type="password" autocomplete="current-password" required></p>
<p><label for="c"><span data-i18n="code"></span> <span class="meta" data-i18n="codeHint"></span></label><input id="c" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></p>
<p class="err" id="loginErr"></p><button data-i18n="login"></button></form>
<form id="panel" hidden><div class="layout"><div class="side"><input id="search" type="search" autocomplete="off"><nav id="nav"></nav></div>
<div id="content"><div id="groups"></div><p class="meta" id="noHits" hidden></p>
<div id="extras"><div class="card" id="totpCard"><h2 data-i18n="totpTitle"></h2><p class="help" id="totpState"></p>
<div id="totpOffBox" hidden><p class="help" data-i18n="offHint"></p>
<p style="display:flex;gap:8px;flex-wrap:wrap"><input id="offCode" inputmode="numeric" autocomplete="off" maxlength="6" style="max-width:9em"><input id="offPw" type="password" autocomplete="current-password" style="max-width:16em"><button type="button" id="offBtn" class="second" data-i18n="turnOff"></button></p>
<p class="err" id="offErr"></p></div>
<button class="plain" id="genTotp" type="button" data-i18n="gen"></button><div id="totpOut" hidden>
<p class="help" data-i18n="step1"></p>
<p><img id="totpQr" alt="QR" style="image-rendering:pixelated;background:#fff;padding:4px;border-radius:6px;max-width:100%"></p>
<p class="help"><span data-i18n="cantScan"></span> <code id="totpSecret"></code></p>
<p class="help" data-i18n="step2"></p>
<p style="display:flex;gap:8px"><input id="totpCheck" inputmode="numeric" autocomplete="off" maxlength="6" style="max-width:9em"><button type="button" id="totpCheckBtn" class="second" data-i18n="check"></button></p>
<p class="err" id="totpCheckErr"></p>
<div id="totpDone" hidden><p class="help" data-i18n="step3"></p>
<p style="display:flex;gap:8px;flex-wrap:wrap"><input id="onPw" type="password" autocomplete="current-password" style="max-width:16em"><button type="button" id="onBtn" data-i18n="turnOn"></button></p>
<p class="err" id="onErr"></p>
<p class="help"><span data-i18n="envAlt"></span> <code id="totpEnv"></code></p></div></div></div>
<div class="card" id="pwCard"><h2 data-i18n="pwTitle"></h2><p class="help" id="pwState"></p>
<p><label for="pwOld" data-i18n="pwOld"></label><input id="pwOld" type="password" autocomplete="current-password"></p>
<p><label for="pwNew" data-i18n="pwNew"></label><input id="pwNew" type="password" autocomplete="new-password" minlength="10"></p>
<p><label for="pwNew2" data-i18n="pwNew2"></label><input id="pwNew2" type="password" autocomplete="new-password"></p>
<p class="err" id="pwErr"></p><button type="button" id="pwBtn" data-i18n="pwBtn"></button></div>
<div class="card" id="aboutCard"><h2 data-i18n="aboutTitle"></h2><p class="help" data-i18n="about"></p></div></div>
</div></div>
<div class="savebar"><button id="save" data-i18n="save"></button><button id="restart" type="button" class="second"></button><span class="meta" id="status"></span><p class="err" id="saveErr"></p></div>
</form></main><script src="/admin/admin.js"></script></body></html>`;

const SCRIPT = `"use strict";
const T = {
  en: {
    user: "Username", pass: "Password", code: "Authenticator code", codeHint: "(if 2FA is on)", login: "Log in", logout: "Log out",
    auto: "Auto", light: "Light", dark: "Dark", save: "Save", saved: "Saved, active now.", unsaved: (n) => n + " unsaved change" + (n === 1 ? "" : "s"),
    fromPanel: "set in panel", fromEnv: "from .env", notSet: "not set (built-in default)", reset: "Reset", on: "On", off: "Off", def: "default: ",
    secretSet: "set - type to replace", secretUnset: "not set", tooMany: "Too many attempts, try again in 15 minutes.", loginFailed: "Login failed.", saveFailed: "Save failed",
    inactive: "No effect here: WEB_STATIC=0, the web UI is hosted separately (set it in that build instead).",
    totpTitle: "Two-factor login", totpOn: "On (set in .env).", totpOnPanel: "On (switched on here).", totpOff: "Off. Generate a secret below to require a code at login.",
    offHint: "Switch off: current code from the app and your password.", turnOff: "Switch 2FA off", turnOn: "Switch 2FA on",
    envAlt: "Or put this line in .env instead:", codePh: "Code", pwPh: "Password",
    pwTitle: "Password", pwEnv: "Currently the password from .env (ADMIN_PASSWORD).", pwPanel: "Changed here; ADMIN_PASSWORD in .env is no longer used.",
    pwOld: "Current password", pwNew: "New password (at least 10 characters)", pwNew2: "Repeat new password", pwBtn: "Change password",
    pwMismatch: "The new passwords differ.", pwDone: "Password changed. Other logins were signed out.", totpDoneOn: "2FA is on now. Next login asks for the code.",
    statConn: (n) => n + " connected", statUp: "up ", statVer: "version ",
    gen: "Generate a new secret", step1: "1. Scan this code with your authenticator app (Google Authenticator, Aegis, 2FAS, ...):", cantScan: "Can't scan? Enter the secret manually:",
    step2: "2. Enter the 6-digit code the app now shows for WebSpeak3:", check: "Check", codeWrong: "Code doesn\\u2019t match. Wait for the next code, check the phone\\u2019s clock, or scan again.",
    step3: "\\u2713 Code is correct. 3. Confirm with your password to switch 2FA on.",
    credErr: { wrong_password: "Wrong password.", code_wrong: "Wrong code.", weak_password: "At least 10 characters.", rate_limited: "Too many attempts, try again in 15 minutes." },
    aboutTitle: "How this works", about: "Changes apply immediately, except in \\u201cRestart required\\u201d. They override .env and are stored in admin-config.json (ADMIN_CONFIG_FILE). \\u201cReset\\u201d returns a setting to its .env value. Password and 2FA changes go to admin-auth.json; deleting that file goes back to .env (e.g. if you are locked out).",
    search: "Search settings\\u2026", noHits: "No matching settings.", std: "default",
    restartBtn: "Restart gateway", restartDue: (n) => "Restart gateway (" + n + " pending)", pendingRestart: "Saved \\u2013 applies after the next restart.",
    restartConfirm: (n) => (n ? n + " connection(s) are open right now; they get a restart notice and are dropped. " : "Nobody is connected. ") + "Restart now? This only works if Docker's restart policy or systemd brings the gateway back up.",
    restarting: "Restarting\\u2026 the page reloads when the gateway is back.", restartFailed: "Restart failed",
    errors: {}, groups: {}, help: {},
  },
  de: {
    user: "Benutzername", pass: "Passwort", code: "Authenticator-Code", codeHint: "(falls 2FA an ist)", login: "Anmelden", logout: "Abmelden",
    auto: "Auto", light: "Hell", dark: "Dunkel", save: "Speichern", saved: "Gespeichert, sofort aktiv.", unsaved: (n) => n + " ungespeicherte \\u00c4nderung" + (n === 1 ? "" : "en"),
    fromPanel: "im Panel gesetzt", fromEnv: "aus .env", notSet: "nicht gesetzt (Standardwert)", reset: "Zur\\u00fccksetzen", on: "An", off: "Aus", def: "Standard: ",
    secretSet: "gesetzt \\u2013 zum Ersetzen tippen", secretUnset: "nicht gesetzt", tooMany: "Zu viele Versuche, bitte in 15 Minuten erneut versuchen.", loginFailed: "Anmeldung fehlgeschlagen.", saveFailed: "Speichern fehlgeschlagen",
    inactive: "Hier ohne Wirkung: WEB_STATIC=0, die Web-Oberfl\\u00e4che wird separat gehostet (dort beim Build setzen).",
    totpTitle: "Zwei-Faktor-Anmeldung", totpOn: "Aktiv (in der .env gesetzt).", totpOnPanel: "Aktiv (hier eingeschaltet).", totpOff: "Aus. Unten ein Secret erzeugen, um beim Login einen Code zu verlangen.",
    offHint: "Abschalten: aktueller Code aus der App und dein Passwort.", turnOff: "2FA abschalten", turnOn: "2FA einschalten",
    envAlt: "Oder stattdessen diese Zeile in die .env:", codePh: "Code", pwPh: "Passwort",
    pwTitle: "Passwort", pwEnv: "Aktuell gilt das Passwort aus der .env (ADMIN_PASSWORD).", pwPanel: "Hier ge\\u00e4ndert; ADMIN_PASSWORD in der .env wird nicht mehr verwendet.",
    pwOld: "Aktuelles Passwort", pwNew: "Neues Passwort (mindestens 10 Zeichen)", pwNew2: "Neues Passwort wiederholen", pwBtn: "Passwort \\u00e4ndern",
    pwMismatch: "Die neuen Passw\\u00f6rter stimmen nicht \\u00fcberein.", pwDone: "Passwort ge\\u00e4ndert. Andere Anmeldungen wurden abgemeldet.", totpDoneOn: "2FA ist jetzt aktiv. Der n\\u00e4chste Login fragt nach dem Code.",
    statConn: (n) => n + " verbunden", statUp: "l\\u00e4uft seit ", statVer: "Version ",
    gen: "Neues Secret erzeugen", step1: "1. Diesen Code mit der Authenticator-App scannen (Google Authenticator, Aegis, 2FAS, ...):", cantScan: "Scannen klappt nicht? Secret von Hand eingeben:",
    step2: "2. Den 6-stelligen Code eingeben, den die App jetzt f\\u00fcr WebSpeak3 anzeigt:", check: "Pr\\u00fcfen", codeWrong: "Code passt nicht. Auf den n\\u00e4chsten Code warten, die Uhrzeit am Handy pr\\u00fcfen oder neu scannen.",
    step3: "\\u2713 Code stimmt. 3. Mit deinem Passwort best\\u00e4tigen, um 2FA einzuschalten.",
    credErr: { wrong_password: "Falsches Passwort.", code_wrong: "Falscher Code.", weak_password: "Mindestens 10 Zeichen.", rate_limited: "Zu viele Versuche, in 15 Minuten erneut probieren." },
    aboutTitle: "So funktioniert's", about: "\\u00c4nderungen gelten sofort, au\\u00dfer unter \\u201eNeustart n\\u00f6tig\\u201c. Sie \\u00fcberschreiben die .env und liegen in admin-config.json (ADMIN_CONFIG_FILE). \\u201eZur\\u00fccksetzen\\u201c stellt den Wert aus der .env wieder her. Passwort und 2FA aus dem Panel liegen in admin-auth.json; wer die Datei l\\u00f6scht, ist wieder bei der .env (z. B. wenn man sich ausgesperrt hat).",
    search: "Einstellungen suchen\\u2026", noHits: "Keine passende Einstellung.", std: "Standardwert",
    restartBtn: "Gateway neu starten", restartDue: (n) => "Gateway neu starten (" + n + " ausstehend)", pendingRestart: "Gespeichert \\u2013 gilt ab dem n\\u00e4chsten Neustart.",
    restartConfirm: (n) => (n ? "Gerade sind " + n + " Verbindung(en) offen; sie bekommen einen Neustart-Hinweis und werden getrennt. " : "Niemand ist verbunden. ") + "Jetzt neu starten? Das klappt nur, wenn Dockers Restart-Policy oder systemd das Gateway wieder hochf\\u00e4hrt.",
    restarting: "Startet neu\\u2026 die Seite l\\u00e4dt neu, sobald das Gateway wieder da ist.", restartFailed: "Neustart fehlgeschlagen",
    errors: { "must be a port (1-65535)": "muss ein Port sein (1\\u201365535)", "must be a whole number": "muss eine ganze Zahl sein", "must be 0 or 1": "muss 0 oder 1 sein", "invalid characters or too long": "ung\\u00fcltige Zeichen oder zu lang", "unknown setting": "unbekannte Einstellung" },
    groups: { "Connections & limits": "Verbindungen & Limits", "Access": "Zugriff", "Connect dialog": "Verbindungsdialog", "Features": "Funktionen", "News ticker": "News-Ticker", "Bot check (Cloudflare Turnstile)": "Bot-Check (Cloudflare Turnstile)", "Screen sharing & webcam (TURN)": "Bildschirmfreigabe & Webcam (TURN)", "Feedback & GitHub": "Feedback & GitHub", "Design Store": "Design Store", "Restart required": "Neustart n\\u00f6tig" },
    help: {
      MAX_CONNECTIONS: "Offene WebSocket-Verbindungen insgesamt (0 = unbegrenzt).", MAX_CONNECTIONS_PER_IP: "Offene Verbindungen pro Client-IP (0 = unbegrenzt).",
      CONNECT_RATE_LIMIT: "Verbindungsversuche pro IP und Minute (0 = unbegrenzt).",
      ALLOWED_SERVERS: "Kommagetrennte TeamSpeak-Server, mit denen sich dieses Gateway verbinden darf (*.example.com erlaubt). Leer = alle.",
      ALLOWED_ORIGINS: "Kommagetrennte Web-Origins, die dieses Gateway nutzen d\\u00fcrfen (https://client.example.com). Leer = alle.",
      SERVER_PICKER: "ALLOWED_SERVERS im Verbindungsdialog als Auswahlliste anbieten.", DEFAULT_SERVER: "Im Verbindungsdialog vorausgef\\u00fcllte Serveradresse.", DEFAULT_CHANNEL: "Im Verbindungsdialog vorausgef\\u00fcllter Kanal.",
      FEEDBACK_ENABLED: "Feedback aus der App annehmen (/api/feedback).", STORE_ENABLED: "Design Store betreiben (Theme-Einreichungen und Downloads).", LOG_CONNECTIONS: "Verbindungen protokollieren (gehashte Client-Kennungen, keine Klartext-IPs).",
      NEWS_TICKER: "News-Ticker anzeigen.", NEWS_TICKER_CENTRAL: "Offizielle WebSpeak3-News im Ticker mit anzeigen.", NEWS_TICKER_MESSAGES: "Eigene Ticker-Meldungen, getrennt durch |.",
      TURNSTILE_SITE_KEY: "Cloudflare-Turnstile-Site-Key (Bot-Check, braucht auch das Secret).", TURNSTILE_SECRET: "Cloudflare-Turnstile-Secret-Key.",
      TURN_URLS: "Kommagetrennte TURN-Server-URLs f\\u00fcr Bildschirmfreigabe/Webcam.", TURN_SECRET: "coturn use-auth-secret (Zugangsdaten pro Nutzer).",
      TURN_USERNAME: "Fester TURN-Benutzername (ohne TURN_SECRET).", TURN_CREDENTIAL: "Festes TURN-Passwort (ohne TURN_SECRET).",
      ENABLE_TS2: "TeamSpeak-2-Server erlauben (experimentell).", TELEMETRY: "Anonymer t\\u00e4glicher Nutzungs-Ping (nur zuf\\u00e4llige Instanz-ID + Version).",
      FEEDBACK_ALLOWED_ORIGIN: "Web-Origin, die Feedback senden darf (CORS). * = alle.", GITHUB_TOKEN: "GitHub-Token (Issues: write), um aus Feedback Issues zu machen.",
      GITHUB_REPO: "Repository f\\u00fcr Feedback-Issues und die Release-News.", STORE_ALLOWED_ORIGIN: "Web-Origin, die den Store nutzen darf (CORS). * = alle.",
      STORE_RESERVED_AUTHORS: "Kommagetrennte Autorennamen, unter denen nur der Store-Admin ver\\u00f6ffentlichen darf.", STORE_ADMIN_TOKEN: "Token zum Freigeben von Store-Einreichungen.",
      TRUST_PROXY: "Hinter einem Proxy: \\"cloudflare\\" (CF-Connecting-IP) oder \\"1\\" (letzter X-Forwarded-For). Nur wenn das Gateway ausschlie\\u00dflich dar\\u00fcber erreichbar ist. Leer = aus.",
      SYNC_URL: "Eigener Konto-Sync-Server (sync-server.js). Leer = der offizielle.",
      PORT: "Port, auf dem das Gateway lauscht. Vorsicht: Bei Docker muss das Port-Mapping passen, sonst ist dieses Panel nicht mehr erreichbar (Abhilfe: PORT aus admin-config.json entfernen).",
      TLS_CERT: "Pfad zum TLS-Zertifikat (mit TLS_KEY: HTTPS direkt ausliefern). Ein falscher Pfad verhindert den Start.", TLS_KEY: "Pfad zum privaten TLS-Schl\\u00fcssel.",
      WEB_STATIC: "Web-Oberfl\\u00e4che von diesem Gateway ausliefern. Aus, wenn sie woanders gehostet wird.", WEB_DIST: "Ordner mit der gebauten Web-Oberfl\\u00e4che (web/dist).",
      STORE_DATA_FILE: "Datendatei des Design Stores.", NEWS_DATA_FILE: "Datei f\\u00fcr News aus dem Stats-Panel.",
      FEEDBACK_LOG_FILE: "Privates Feedback-Log (enth\\u00e4lt Kontakt-E-Mails).", TELEMETRY_ID_FILE: "Datei mit der zuf\\u00e4lligen Instanz-ID des Nutzungs-Pings.",
      BROADCAST_TOKEN: "Bearer-Token f\\u00fcr /api/broadcast (Hinweise an alle Nutzer). Leer = Endpunkt aus.",
    },
  },
};
const $ = (id) => document.getElementById(id);
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
let lang = store.get("wsAdminLang") || (navigator.language.toLowerCase().startsWith("de") ? "de" : "en");
let theme = store.get("wsAdminTheme") || "auto";
let data = null, pending = {};
let current = store.get("wsAdminTab") || "";
// Non-setting pages in the sidebar: [tab key, card id, title string].
const EXTRA = [["__totp", "totpCard", "totpTitle"], ["__pw", "pwCard", "pwTitle"], ["__about", "aboutCard", "aboutTitle"]];
const gname = (g) => t("groups")[g] || g;
const t = (k) => T[lang][k];
const api = (path, body) => fetch("/admin/api/" + path, body === undefined ? {} : {
  method: "POST", headers: { "Content-Type": "application/json", "X-WebSpeak3-Admin": "1" }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
function el(tag, props, ...kids) { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; }
function applyChrome() {
  document.documentElement.lang = lang;
  if (theme === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.dataset.theme = theme;
  for (const b of document.querySelectorAll("[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
  for (const b of document.querySelectorAll("[data-theme-btn]")) b.setAttribute("aria-pressed", String(b.dataset.themeBtn === theme));
  for (const e of document.querySelectorAll("[data-i18n]")) e.textContent = t(e.dataset.i18n);
  $("search").placeholder = t("search"); $("noHits").textContent = t("noHits");
  $("offCode").placeholder = $("totpCheck").placeholder = t("codePh"); $("offPw").placeholder = $("onPw").placeholder = t("pwPh");
}
function updateStatus() {
  const n = Object.keys(pending).length;
  $("status").textContent = n ? t("unsaved")(n) : "";
}
function render() {
  applyChrome();
  if (!data) return;
  $("login").hidden = true; $("panel").hidden = false; $("logout").hidden = false;
  $("totpState").textContent = data.totp === "panel" ? t("totpOnPanel") : data.totp ? t("totpOn") : t("totpOff");
  $("totpOffBox").hidden = !data.totp;
  $("pwState").textContent = data.passwordFromPanel ? t("pwPanel") : t("pwEnv");
  renderStat();
  const groups = $("groups"); groups.replaceChildren();
  const cards = {};
  for (const s of data.settings) {
    let card = cards[s.group];
    if (!card) {
      card = cards[s.group] = el("section", { className: "card" }, el("h2", { textContent: gname(s.group) }), el("div", { className: "rows" }));
      card.dataset.group = s.group; groups.append(card);
    }
    const id = "s_" + s.key;
    const help = t("help")[s.key] || s.help;
    let input;
    if (s.kind === "bool") {
      input = el("select", { id }, el("option", { value: "1", textContent: t("on") }), el("option", { value: "0", textContent: t("off") }));
      input.value = s.value || s.fallback || "0";
    } else {
      input = el("input", { id, type: s.kind === "secret" ? "password" : s.kind === "number" ? "number" : "text", autocomplete: "off" });
      if (s.kind === "number") input.min = "0";
      if (s.kind === "secret") input.placeholder = s.isSet ? t("secretSet") : t("secretUnset");
      else { input.value = s.value; if (s.fallback) input.placeholder = t("def") + s.fallback; }
    }
    if (s.key in pending) input.value = pending[s.key];
    const reset = el("button", { type: "button", className: "plain reset", textContent: t("reset"), hidden: !s.overridden });
    reset.addEventListener("click", () => save({ [s.key]: null }));
    const badge = el("span", { className: "badge" + (s.overridden ? " panel" : ""), textContent: s.overridden ? t("fromPanel") : s.fromEnv ? t("fromEnv") : t("std") });
    const row = el("div", { className: "row" + (s.inactive ? " inactive" : "") + (s.key in pending ? " changed" : "") },
      el("div", { className: "lab" }, el("label", { htmlFor: id, textContent: s.key }), badge, reset), input, el("div", { className: "help", textContent: help }));
    row.dataset.find = (s.key + " " + help + " " + gname(s.group)).toLowerCase();
    const mark = () => { pending[s.key] = input.value; row.classList.add("changed"); updateStatus(); renderNav(); };
    input.addEventListener("input", mark); input.addEventListener("change", mark);
    if (s.inactive) row.append(el("div", { className: "warn", textContent: t("inactive") }));
    if (s.pendingRestart) row.append(el("div", { className: "warn", textContent: t("pendingRestart") }));
    card.lastChild.append(row);
  }
  if (!cards[current] && !EXTRA.some(([k]) => k === current)) current = data.settings[0].group;
  const due = data.settings.filter((s) => s.pendingRestart).length;
  $("restart").textContent = due ? t("restartDue")(due) : t("restartBtn");
  $("restart").classList.toggle("due", due > 0);
  updateStatus(); renderNav(); applyView();
}
function renderNav() {
  const nav = $("nav"); nav.replaceChildren();
  const item = (key, label, badge) => {
    const b = el("button", { type: "button" }, el("span", { textContent: label }), ...(badge ? [badge] : []));
    b.dataset.tab = key;
    b.addEventListener("click", () => { current = key; store.set("wsAdminTab", key); $("search").value = ""; applyView(); });
    nav.append(b); return b;
  };
  for (const g of [...new Set(data.settings.map((s) => s.group))]) {
    const ss = data.settings.filter((s) => s.group === g);
    const unsaved = ss.filter((s) => s.key in pending).length;
    const badge = unsaved ? el("span", { className: "cnt", textContent: String(unsaved), title: t("unsaved")(unsaved) })
      : ss.some((s) => s.pendingRestart) ? el("span", { className: "cnt warnc", textContent: "!", title: t("pendingRestart") }) : null;
    const b = item(g, gname(g), badge);
    if (ss.every((s) => s.inactive)) { b.classList.add("muted"); b.title = t("inactive"); }
  }
  nav.append(el("hr"));
  for (const [k, , label] of EXTRA) item(k, t(label));
  markCurrent();
}
function markCurrent() {
  const q = $("search").value.trim();
  for (const b of $("nav").children) if (b.dataset.tab) b.setAttribute("aria-current", String(!q && b.dataset.tab === current));
}
// One page at a time; a search shows matches from every category instead.
function applyView() {
  const q = $("search").value.trim().toLowerCase();
  let hits = 0;
  for (const card of $("groups").children) {
    let any = false;
    for (const row of card.lastChild.children) { const m = !q || row.dataset.find.includes(q); row.hidden = !m; if (m) { any = true; hits++; } }
    card.hidden = q ? !any : card.dataset.group !== current;
  }
  for (const [k, id] of EXTRA) $(id).hidden = Boolean(q) || current !== k;
  $("noHits").hidden = !q || hits > 0;
  markCurrent();
}
function renderStat() {
  const up = data.uptime, d = Math.floor(up / 86400), h = Math.floor(up / 3600) % 24, m = Math.floor(up / 60) % 60;
  const parts = [t("statConn")(data.connections), t("statUp") + (d ? d + " d " : "") + (d || h ? h + " h " : "") + m + " min"];
  if (data.version) parts.unshift(t("statVer") + data.version);
  $("stat").textContent = parts.join(" \\u00b7 "); $("stat").hidden = false;
}
// Keeps the status line fresh without re-rendering half-typed fields.
setInterval(async () => {
  if (!data || document.hidden) return;
  const r = await api("config");
  if (r.status === 200) { data.connections = r.data.connections; data.uptime = r.data.uptime; renderStat(); }
}, 30000);
// Credential actions: show the server's error next to the form, else take the new state.
async function cred(path, body, errId) {
  $(errId).textContent = "";
  const r = await api(path, body);
  if (r.status === 401) { load(); return false; }
  if (r.status !== 200) { $(errId).textContent = t("credErr")[r.data.error] || r.data.error || t("saveFailed"); return false; }
  data = r.data; render(); return true;
}
async function load() {
  const r = await api("config");
  if (r.status === 200) { data = r.data; pending = {}; return render(); }
  data = null; applyChrome();
  $("panel").hidden = true; $("logout").hidden = true; $("stat").hidden = true; $("login").hidden = false;
}
async function save(changes) {
  $("saveErr").textContent = "";
  const r = await api("config", { changes });
  if (r.status === 401) return load();
  if (r.status !== 200) { $("saveErr").textContent = (r.data.key ? r.data.key + ": " : "") + (t("errors")[r.data.error] || r.data.error || t("saveFailed")); return; }
  data = r.data; for (const k of Object.keys(changes)) delete pending[k];
  render(); $("status").textContent = t("saved");
}
document.querySelectorAll("[data-lang]").forEach((b) => b.addEventListener("click", () => { lang = b.dataset.lang; store.set("wsAdminLang", lang); render(); }));
document.querySelectorAll("[data-theme-btn]").forEach((b) => b.addEventListener("click", () => { theme = b.dataset.themeBtn; store.set("wsAdminTheme", theme); applyChrome(); }));
$("login").addEventListener("submit", async (e) => {
  e.preventDefault(); $("loginErr").textContent = "";
  const r = await api("login", { user: $("u").value, password: $("p").value, code: $("c").value });
  if (r.status === 200) { $("p").value = ""; $("c").value = ""; return load(); }
  $("loginErr").textContent = r.status === 429 ? t("tooMany") : t("loginFailed");
});
$("panel").addEventListener("submit", (e) => { e.preventDefault(); if (Object.keys(pending).length) save({ ...pending }); });
$("search").addEventListener("input", applyView);
$("restart").addEventListener("click", async () => {
  const fresh = await api("config"); if (fresh.status !== 200) return load();
  if (!confirm(t("restartConfirm")(fresh.data.connections))) return;
  const r = await api("restart", {});
  if (r.status !== 200) { $("saveErr").textContent = t("restartFailed"); return; }
  $("restart").disabled = $("save").disabled = true; $("status").textContent = t("restarting");
  // Wait for the old process to go away, then until /admin answers again.
  await new Promise((ok) => setTimeout(ok, 2000));
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch("/admin/admin.js", { cache: "no-store" })).ok) return location.reload(); } catch {}
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  $("saveErr").textContent = t("restartFailed");
});
$("logout").addEventListener("click", async () => { await api("logout", {}); load(); });
$("genTotp").addEventListener("click", async () => {
  const r = await api("totp-secret"); if (r.status !== 200) return load();
  $("totpQr").src = r.data.qr; $("totpSecret").textContent = r.data.secret; $("totpEnv").textContent = "ADMIN_TOTP_SECRET=" + r.data.secret; $("totpOut").hidden = false; $("totpDone").hidden = true; $("totpCheck").value = ""; $("totpCheckErr").textContent = "";
});
$("totpCheckBtn").addEventListener("click", async () => {
  $("totpCheckErr").textContent = "";
  const r = await api("totp-verify", { secret: $("totpSecret").textContent, code: $("totpCheck").value });
  if (r.status === 401) return load();
  if (r.status === 200 && r.data.ok) { $("totpDone").hidden = false; return; }
  $("totpDone").hidden = true; $("totpCheckErr").textContent = t("codeWrong");
});
$("onBtn").addEventListener("click", async () => {
  if (await cred("totp-enable", { secret: $("totpSecret").textContent, code: $("totpCheck").value, password: $("onPw").value }, "onErr")) {
    $("onPw").value = ""; $("totpOut").hidden = true; $("totpState").textContent = t("totpDoneOn");
  }
});
$("offBtn").addEventListener("click", async () => {
  if (await cred("totp-disable", { code: $("offCode").value, password: $("offPw").value }, "offErr")) { $("offCode").value = $("offPw").value = ""; }
});
$("pwBtn").addEventListener("click", async () => {
  $("pwErr").textContent = "";
  if ($("pwNew").value !== $("pwNew2").value) { $("pwErr").textContent = t("pwMismatch"); return; }
  if (await cred("password", { password: $("pwOld").value, newPassword: $("pwNew").value }, "pwErr")) {
    $("pwOld").value = $("pwNew").value = $("pwNew2").value = ""; $("pwState").textContent = t("pwDone");
  }
});
applyChrome();
load();
`;
