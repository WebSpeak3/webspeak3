// Admin panel login and credential changes, against the built gateway
// (npm test builds first). Runs a real process on a free port in a temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const INDEX = path.resolve(import.meta.dirname, "../dist/index.js");

function totp(secretB32, step) {
  let bits = "";
  for (const c of secretB32) bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", key).update(msg).digest();
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1e6).padStart(6, "0");
}

const freePort = () => new Promise((ok) => {
  const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); });
});

async function startGateway(dir, port) {
  const child = spawn(process.execPath, [INDEX], {
    cwd: dir,
    env: { PATH: process.env.PATH, PORT: String(port), WEB_STATIC: "0", TELEMETRY: "0", ADMIN_USER: "admin", ADMIN_PASSWORD: "env-password" },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/admin/admin.js`); return child; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  child.kill();
  throw new Error("gateway did not start");
}
const stop = (child) => new Promise((ok) => { child.once("exit", ok); child.kill("SIGTERM"); });

function client(port) {
  let cookie = "";
  return async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/admin/api/${p}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-WebSpeak3-Admin": "1", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
}

test("password and 2FA set in the panel", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ws3-admin-"));
  const port = await freePort();
  let gw = await startGateway(dir, port);
  try {
    const now = Math.floor(Date.now() / 30000);
    const a = client(port);
    // Mind the limit of 5 login attempts per IP per process start.
    assert.equal((await a("login", { user: "admin", password: "env-password" })).status, 200);

    const { secret } = (await a("totp-secret")).data;
    assert.equal((await a("totp-enable", { secret, code: totp(secret, now), password: "wrong" })).status, 403);
    assert.equal((await a("totp-enable", { secret, code: "000000", password: "env-password" })).data.error, "code_wrong");
    assert.equal((await a("totp-enable", { secret, code: totp(secret, now), password: "env-password" })).data.totp, "panel");

    const b = client(port);
    assert.equal((await b("login", { user: "admin", password: "env-password" })).status, 401, "code required now");
    assert.equal((await b("login", { user: "admin", password: "env-password", code: totp(secret, now) })).status, 401, "enable code can't be replayed");
    const next = totp(secret, now + 1);
    assert.equal((await b("login", { user: "admin", password: "typo", code: next })).status, 401);
    assert.equal((await b("login", { user: "admin", password: "env-password", code: next })).status, 200, "password typo must not burn the code");

    assert.equal((await b("password", { password: "env-password", newPassword: "short" })).data.error, "weak_password");
    assert.equal((await b("password", { password: "wrong", newPassword: "new-password-42" })).status, 403);
    assert.equal((await b("password", { password: "env-password", newPassword: "new-password-42" })).data.passwordFromPanel, true);
    assert.equal((await a("config")).status, 401, "other sessions end on password change");
    assert.equal((await b("config")).status, 200);

    // Both survive a restart and win over .env.
    await stop(gw);
    gw = await startGateway(dir, port);
    const c = client(port);
    assert.equal((await c("login", { user: "admin", password: "env-password", code: totp(secret, now) })).status, 401);
    assert.equal((await c("login", { user: "admin", password: "new-password-42", code: totp(secret, now) })).status, 200);
    assert.equal((await client(port)("login", { user: "admin", password: "new-password-42", code: totp(secret, now) })).status, 401, "login code can't be replayed");
    assert.equal((await c("totp-disable", { password: "new-password-42", code: "000000" })).data.error, "code_wrong");
    assert.equal((await c("totp-disable", { password: "new-password-42", code: totp(secret, now + 1) })).data.totp, "");
    assert.equal((await client(port)("login", { user: "admin", password: "new-password-42" })).status, 200);
  } finally {
    await stop(gw);
    rmSync(dir, { recursive: true, force: true });
  }
});
