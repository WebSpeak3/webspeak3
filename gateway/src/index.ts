import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { Ts3Connection, type ServerType, type Ts3ConnectOptions } from "./ts3/connection.js";
import { handleStore } from "./store.js";
import { handleNewsConfig } from "./news.js";
import { logFeedback, logConnectionEvent } from "./activity-log.js";
import { clientIp, createRateLimiter } from "./net.js";
import "./telemetry.js";

const SERVER_TYPES = new Set<ServerType>(["teamspeak", "teaspeak", "auto"]);

function parseServerType(value: unknown): ServerType | undefined {
  return typeof value === "string" && SERVER_TYPES.has(value as ServerType)
    ? (value as ServerType)
    : undefined;
}

function parsePrivilegeKey(msg: { privilegeKey?: unknown; token?: unknown }): string | undefined {
  const raw = msg.privilegeKey ?? msg.token;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

// Self-hosting admins may want to lock their instance to specific server(s)
// instead of leaving it as a general-purpose "connect anywhere" client.
// Unset (the default) means unrestricted, unchanged from before this existed.
const ALLOWED_SERVERS = (process.env.ALLOWED_SERVERS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Strips a trailing ":port" so "ts.example.com:9987" and "ts.example.com"
// both match a plain "ts.example.com" allowlist entry. IPv6 literals come
// wrapped in brackets ("[::1]:9987"); nicknames have neither and pass through
// as-is. Deliberately not full URL parsing - `host` here is never a URL.
function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(1, end);
  }
  const i = host.lastIndexOf(":");
  return i !== -1 && /^\d+$/.test(host.slice(i + 1)) ? host.slice(0, i) : host;
}

function isServerAllowed(host: unknown): boolean {
  if (ALLOWED_SERVERS.length === 0) return true;
  if (typeof host !== "string") return false;
  const target = stripPort(host).trim().toLowerCase();
  return ALLOWED_SERVERS.some((entry) => {
    // "*.example.com" matches any subdomain (TLS-wildcard-style: not the
    // bare apex itself - list that separately if it should be allowed too).
    if (entry.startsWith("*.")) return target.endsWith(stripPort(entry).slice(1));
    return target === stripPort(entry);
  });
}

// Everything a "connect" message hands to the connector as a CLI argument.
// The connector's own resolver does the real parsing; this only rejects input
// no legitimate address or nickname has (control chars, absurd lengths), and
// anything starting with "-" so it can never be read as a flag.
const HOST_PATTERN = /^[\p{L}\p{N}._\-:[\]]{1,253}$/u;

function isValidHost(host: unknown): host is string {
  return typeof host === "string" && HOST_PATTERN.test(host) && !host.startsWith("-");
}

function isValidNickname(nickname: unknown): nickname is string {
  return (
    typeof nickname === "string" &&
    nickname.trim().length > 0 &&
    nickname.length <= 100 &&
    !/[\p{Cc}]/u.test(nickname)
  );
}

// Which web pages may open /ws. Without this any website can embed a hidden
// WebSocket to this gateway and use it as a free relay into TeamSpeak land.
// Unset keeps the old "any origin" behavior for self-hosters; entries are
// full origins ("https://client.example.com"). Non-browser clients send no
// Origin header at all - they could fake one anyway, so they aren't blocked.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, "").toLowerCase())
  .filter(Boolean);

// Each /ws socket can spawn a connector process holding a live TeamSpeak
// session, so both need a ceiling. 0 disables the respective limit.
const MAX_CONNECTIONS_PER_IP = Number(process.env.MAX_CONNECTIONS_PER_IP ?? 10);
// Measured 2026-10-25: ~8-9 % of a core per client listening to constant audio
// (connector + node + cloudflared), ~10-15 MB RAM. 60 suits a 2-core VPS.
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS ?? 60);
const connectionsPerIp = new Map<string, number>();
// Every "connect" spawns a fresh connector, and a socket can send any number
// of them - without this, 10 sockets were enough to join-flood a TS server
// through this gateway at several joins per second. Real clients (reconnect
// backoff, restoring a handful of tabs) stay far below it.
const CONNECT_RATE_LIMIT = Number(process.env.CONNECT_RATE_LIMIT ?? 30);
const isConnectRateLimited = createRateLimiter(CONNECT_RATE_LIMIT, 60_000);

// Largest single WS message. Uploads now arrive in small "uploadFileChunk"
// pieces; this size only stays for browsers still running a client from
// before that, which send the whole file base64-encoded in one "uploadFile"
// message (~4/3 of MAX_UPLOAD_BYTES in web/src/App.tsx). ws's own default is
// 100 MiB.
const WS_MAX_PAYLOAD = 34 * 1024 * 1024;

const PORT = Number(process.env.PORT ?? 8080);

// In production (Docker), the built web app lives alongside the gateway and
// is served from the same port as the WebSocket endpoint, so a single
// reverse-proxied origin (e.g. a Zoraxy subdomain) is enough for everything.
// Local Vite dev (`npm run dev` in web/) is a separate UI on :5173 that talks
// to this gateway only via WebSocket — do not use :8080's HTML for UI work
// unless you rebuilt web/dist. Set WEB_STATIC=0 to serve API/WS only.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST ?? path.resolve(__dirname, "../../web/dist");
const SERVE_STATIC = process.env.WEB_STATIC !== "0";

// Sent to every browser in the "hello" message on socket open; see there.
const GATEWAY_FEATURES = ["clientVolume", "keepalive", "chunkedUpload", "whisperPolicy", "transferLimit"];

// Optional TURN relay for screen streams, also handed out in "hello". With
// TURN_SECRET (coturn's use-auth-secret) every socket gets its own credential,
// valid for a day; TURN_USERNAME/TURN_CREDENTIAL are static and so readable by
// every visitor. ponytail: a socket open longer than a day hands an expired
// credential to a stream started after that; reconnecting fixes it.
const TURN_URLS = (process.env.TURN_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
function turnServers() {
  if (!TURN_URLS.length) return undefined;
  const secret = process.env.TURN_SECRET;
  if (!secret) {
    return [{ urls: TURN_URLS, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }];
  }
  const username = `${Math.floor(Date.now() / 1000) + 24 * 3600}:webspeak3`;
  return [{ urls: TURN_URLS, username, credential: createHmac("sha1", secret).update(username).digest("base64") }];
}

// Runtime counterpart of the web build's VITE_DEFAULT_SERVER/_CHANNEL (GitHub
// issue #12): set on the container, these end up in the served index.html as
// <meta> tags the client reads at startup, so changing them needs no rebuild.
// Meta tags rather than an inline script, which CONTENT_SECURITY_POLICY forbids.
// The allowlist goes along so the client can offer it as a dropdown (or a
// locked field for a single entry) instead of a free-text address; not with
// wildcards, which can't be listed, nor with SERVER_PICKER=0.
const SERVER_PICKER =
  process.env.SERVER_PICKER !== "0" && !ALLOWED_SERVERS.some((e) => e.startsWith("*."))
    ? ALLOWED_SERVERS.join(",")
    : undefined;
const RUNTIME_CONFIG_META = Object.entries({
  "webspeak3-default-server": process.env.DEFAULT_SERVER,
  "webspeak3-default-channel": process.env.DEFAULT_CHANNEL,
  "webspeak3-allowed-servers": SERVER_PICKER,
  // Self-hosted account sync (sync-server.js); unset = the official one.
  "webspeak3-sync-url": process.env.SYNC_URL,
})
  .flatMap(([name, value]) =>
    value ? [`<meta name="${name}" content="${value.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}">`] : [],
  )
  .join("");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

// --- Feedback endpoint ---------------------------------------------------
//
// Opt-in only, same convention as LOG_CONNECTIONS above: this is an open-
// source, self-hostable image, so other instances don't get a public
// feedback inbox (and potential GitHub-issue creator) just because it's in
// the codebase. Set FEEDBACK_ENABLED=1 on the instance you want it on. The
// web client only shows the "Feedback" menu entry on specific hostnames
// (see IS_OWN_HOSTED_INSTANCE in web/src/App.tsx), but this endpoint
// enforces its own opt-in independently since it's reachable directly over
// HTTP by anyone who finds the gateway's address, not just from that UI.
const FEEDBACK_ENABLED = process.env.FEEDBACK_ENABLED === "1";
// The web app is commonly hosted on a different origin than the gateway
// (see mem:deployment / GATEWAY_URL in web/), so this needs its own CORS
// allowance; default "*" since the endpoint is opt-in, rate-limited, and
// only ever accepts a feedback submission, nothing that reads data back.
const FEEDBACK_ALLOWED_ORIGIN = process.env.FEEDBACK_ALLOWED_ORIGIN ?? "*";
// A token with "Issues: write" access on the target repo. Without it,
// feedback is still accepted and logged, just never turned into an issue.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO ?? "WebSpeak3/webspeak3";
const FEEDBACK_CATEGORIES = new Set(["bug", "idea", "report", "other"]);
const FEEDBACK_MESSAGE_MAX_LENGTH = 4000;

// --- Broadcast endpoint ---------------------------------------------------
//
// Opt-in only, same convention as LOG_CONNECTIONS/FEEDBACK_ENABLED above: lets
// the operator push a free-text maintenance notice to every connected browser
// tab (reuses the same {type:"notice"} message the SIGTERM handler already
// sends, which the frontend renders even without a messageKey). Unset
// BROADCAST_TOKEN and the endpoint 404s, same as feedback when disabled.
const BROADCAST_TOKEN = process.env.BROADCAST_TOKEN;
const BROADCAST_MESSAGE_MAX_LENGTH = 500;

function isValidBroadcastToken(provided: string): boolean {
  if (!BROADCAST_TOKEN) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(BROADCAST_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handleBroadcast(req: IncomingMessage, res: ServerResponse) {
  if (!BROADCAST_TOKEN) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  if (!isValidBroadcastToken(token)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 5_000) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "payload_too_large" }));
      return;
    }
  }

  let body: { message?: unknown };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  const message = typeof body.message === "string" ? body.message.trim().slice(0, BROADCAST_MESSAGE_MAX_LENGTH) : "";
  if (!message) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "message_required" }));
    return;
  }

  const payload = JSON.stringify({ type: "notice", message });
  let sent = 0;
  for (const socket of wss.clients) {
    try {
      socket.send(payload);
      sent++;
    } catch {
      /* socket already gone */
    }
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, sent }));
}

// Small in-memory rate limit: a handful of submissions per IP per hour is
// far more than any real user needs, and keeps one abusive client from
// spamming the log file or (worse) the GitHub issue tracker. In-memory is
// fine here - it only needs to survive as long as the process does.
const FEEDBACK_RATE_LIMIT = 5;
const FEEDBACK_RATE_WINDOW_MS = 60 * 60 * 1000;
const isFeedbackRateLimited = createRateLimiter(FEEDBACK_RATE_LIMIT, FEEDBACK_RATE_WINDOW_MS);

// The issue is public, and its text is whatever an anonymous visitor typed:
// a zero-width space after "@" stops @mentions from pinging real users, and
// the body goes into a fenced code block (longer than any backtick run in the
// message) so links, images and markup render as inert text.
function neutralizeMentions(text: string): string {
  return text.replace(/@/g, "@\u200b");
}

// The contact e-mail is deliberately *not* part of this: it's only kept in
// the private feedback log (logFeedback), never in the public issue.
async function createGithubIssue(payload: { category: string; message: string }): Promise<string | undefined> {
  if (!GITHUB_TOKEN) return undefined;
  const title = neutralizeMentions(
    `[Feedback/${payload.category}] ${payload.message.replace(/\s+/g, " ").trim().slice(0, 72)}`,
  );
  const longestTicks = Math.max(0, ...(payload.message.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(Math.max(3, longestTicks + 1));
  const body = [
    `${fence}text`,
    neutralizeMentions(payload.message),
    fence,
    "",
    "---",
    `Category: ${payload.category}`,
    "_Submitted via the in-client feedback form._",
  ].join("\n");

  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "webspeak3-gateway",
    },
    // GitHub auto-creates labels that don't already exist in the repo, so
    // the category label needs no manual setup on first use.
    body: JSON.stringify({ title, body, labels: ["feedback", payload.category] }),
  });
  if (!res.ok) {
    console.error(`[feedback] GitHub issue creation failed (${res.status}): ${await res.text().catch(() => "")}`);
    return undefined;
  }
  const json = (await res.json()) as { html_url?: string };
  return json.html_url;
}

async function handleFeedback(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", FEEDBACK_ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!FEEDBACK_ENABLED) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  if (isFeedbackRateLimited(clientIp(req))) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "rate_limited" }));
    return;
  }

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "payload_too_large" }));
      return;
    }
  }

  let body: { category?: unknown; message?: unknown; email?: unknown; server?: unknown; publishAsIssue?: unknown; website?: unknown };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  // Honeypot: a field named to look attractive to form-filling bots, kept
  // hidden from real users via CSS. Any value here means a bot filled it in
  // blindly - report success without actually logging or filing anything,
  // so the bot has no signal to adapt on.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const category = typeof body.category === "string" && FEEDBACK_CATEGORIES.has(body.category) ? body.category : "other";
  const message =
    typeof body.message === "string" ? body.message.trim().slice(0, FEEDBACK_MESSAGE_MAX_LENGTH) : "";
  const email = typeof body.email === "string" ? body.email.trim().slice(0, 200) || undefined : undefined;
  // Like the e-mail: private log only, never in the public issue - it may
  // name someone else's server.
  const server = typeof body.server === "string" ? body.server.trim().slice(0, 200) : "";
  const publishAsIssue = body.publishAsIssue === true;

  if (!message) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "message_required" }));
    return;
  }

  await logFeedback({
    at: new Date().toISOString(),
    category,
    message: server ? `${message}\n**Server:** ${server}` : message,
    email,
  });

  let githubIssueUrl: string | undefined;
  if (publishAsIssue) {
    try {
      githubIssueUrl = await createGithubIssue({ category, message });
    } catch (err) {
      console.error("[feedback] Failed to create GitHub issue:", err);
    }
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, githubIssueUrl }));
}

// --- Design Store endpoint --------------------------------------------------
// Moved to store.ts - see that file's header comment for why.

const DEV_HINT = `<!doctype html><html><body style="font:14px system-ui;padding:2rem;max-width:40rem">
<h1>WebSpeak3 gateway</h1>
<p>WebSocket: <code>/ws</code></p>
<p><code>web/dist</code> is missing — the UI has not been built yet.</p>
<p>For local development open the Vite app at <a href="http://localhost:5173/">http://localhost:5173/</a>
(run <code>npm run dev</code> in <code>web/</code>). Rebuild with <code>npm run build</code> in <code>web/</code>
to serve the UI from this port again.</p>
</body></html>`;

/**
 * TLS material, when configured.
 *
 * Not a nicety: `getDisplayMedia`, `getUserMedia` and `crypto.randomUUID` are
 * secure-context-only, so a LAN instance reached over plain http can neither
 * share a screen nor use the microphone. Chrome also hides host ICE candidates
 * behind mDNS names until a media permission is granted, which keeps a
 * peer-to-peer stream from connecting at all.
 *
 * Set TLS_CERT and TLS_KEY to enable; a self-signed pair is enough, the
 * browser only has to be told once to trust it.
 */
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;
const tlsOptions =
  TLS_CERT && TLS_KEY
    ? { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }
    : null;

// Only for the UI this process serves itself; a separately hosted frontend
// (GitHub/Cloudflare Pages) needs its own. Theme CSS from the Design Store is
// the main thing this contains: it can't load scripts, frame the app, or
// pull in fonts/styles from arbitrary hosts.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "connect-src 'self' https: wss: ws:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join("; ");

const requestHandler = (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  void (async () => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      if (requestUrl.pathname === "/api/feedback") {
        await handleFeedback(req, res);
        return;
      }
      if (requestUrl.pathname === "/api/news") {
        handleNewsConfig(res);
        return;
      }
      if (requestUrl.pathname === "/api/broadcast") {
        await handleBroadcast(req, res);
        return;
      }
      if (
        requestUrl.pathname === "/api/store/admin" ||
        requestUrl.pathname === "/api/store/themes" ||
        requestUrl.pathname.startsWith("/api/store/themes/")
      ) {
        await handleStore(req, res, requestUrl.pathname).catch((err) => {
          console.error("[store] Request failed:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "internal" }));
          }
        });
        return;
      }

      // Container healthcheck target (see Dockerfile). Deliberately its own
      // route rather than "/": with WEB_STATIC=0 every browser-facing path
      // answers 404, and a probe against "/" would then report the process as
      // unhealthy for doing exactly what it was configured to do.
      if (requestUrl.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("ok\n");
        return;
      }

      if (!SERVE_STATIC) {
        // With the UI hosted elsewhere this process is an API endpoint and
        // nothing else: no SPA fallback, and not even a notice page at "/",
        // which would only put a second, stale-looking "app" on a hostname
        // that is meant to answer /ws and /api/feedback. Everything a browser
        // asks for is simply absent.
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found\n");
        return;
      }
      let filePath = path.join(WEB_DIST, decodeURIComponent(requestUrl.pathname));
      if (filePath !== WEB_DIST && !filePath.startsWith(WEB_DIST + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      let body: Buffer;
      try {
        body = await readFile(filePath);
      } catch {
        // SPA fallback: unknown paths (client-side routes, or "/") serve index.html.
        filePath = path.join(WEB_DIST, "index.html");
        body = await readFile(filePath);
      }
      if (RUNTIME_CONFIG_META && filePath === path.join(WEB_DIST, "index.html")) {
        // Function replacer: a string one would expand "$&" etc. in the values.
        body = Buffer.from(body.toString("utf8").replace("</head>", () => `${RUNTIME_CONFIG_META}</head>`));
      }
      const ext = path.extname(filePath);
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
        ...(ext === ".html" ? { "Content-Security-Policy": CONTENT_SECURITY_POLICY } : {}),
      });
      res.end(body);
    } catch {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DEV_HINT);
    }
  })();
};

// The frontend derives ws:// or wss:// from the page's own scheme, so the
// WebSocket follows this choice without any further configuration.
const server = tlsOptions
  ? createSecureServer(tlsOptions, requestHandler)
  : createServer(requestHandler);

const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: WS_MAX_PAYLOAD,
  verifyClient: ({ origin, req }, done) => {
    if (ALLOWED_ORIGINS.length > 0 && origin && !ALLOWED_ORIGINS.includes(origin.toLowerCase())) {
      return done(false, 403, "Origin not allowed");
    }
    const ip = clientIp(req);
    if (MAX_CONNECTIONS_PER_IP > 0 && (connectionsPerIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
      return done(false, 429, "Too many connections");
    }
    done(true);
  },
});

// Heartbeat: a browser tab that loses its network mid-session (mobile
// handover, Wi-Fi drop, backgrounded/frozen tab) often never sends a proper
// WS close frame — the OS-level TCP timeout that would eventually notice can
// take minutes, during which the connector child process (and the TS3/TeaSpeak
// session it holds open) stays alive even though the frontend has already
// given up and shown "disconnected". Standard `ws` ping/pong liveness check
// closes those zombie sockets (and their connector) promptly instead.
const HEARTBEAT_INTERVAL_MS = 20_000;

interface HeartbeatState {
  isAlive: boolean;
}

const heartbeats = new WeakMap<WebSocket, HeartbeatState>();

// Tracked so SIGTERM (below) can tell every live TS3/TeaSpeak session to
// disconnect properly before the process exits, instead of leaving the
// target server to notice on its own timeout.
const liveConnections = new Set<Ts3Connection>();
// Set right before that graceful disconnect: suppresses forwarding the
// connector's own "disconnected" event to the browser during shutdown, so
// the browser sees a raw socket close (which it auto-reconnects from) rather
// than an explicit disconnect (which it treats as deliberate and gives up
// on) — see the SIGTERM handler.
let shuttingDown = false;

const heartbeatTimer = setInterval(() => {
  for (const socket of wss.clients) {
    const state = heartbeats.get(socket);
    if (!state) continue;
    if (!state.isAlive) {
      socket.terminate();
      continue;
    }
    state.isAlive = false;
    socket.ping();
    // Protocol pings are invisible to browser JS; this lets the page notice
    // a dead network on its side too (KEEPALIVE_MESSAGE in web/src/App.tsx).
    socket.send('{"type":"keepalive"}');
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => clearInterval(heartbeatTimer));

// Docker sends SIGTERM on `docker stop`/`docker compose up -d` (redeploy)
// before the default ~10s grace period elapses. Warn every connected
// browser tab so an active call/stream doesn't just silently drop, then
// exit quickly rather than waiting out the grace period doing nothing.
process.on("SIGTERM", () => {
  void (async () => {
    const payload = JSON.stringify({ type: "notice", messageKey: "restartNotice.body" });
    for (const socket of wss.clients) {
      try {
        socket.send(payload);
      } catch {
        /* socket already gone */
      }
    }
    console.log(`[gateway] SIGTERM received, notified ${wss.clients.size} client(s), disconnecting ${liveConnections.size} live session(s)`);

    // Tell every connector to leave its TS3/TeaSpeak server *before* the
    // process exits. Without this, `docker stop`'s grace period expires and
    // the container is killed, taking the connector child processes with it
    // mid-session - the target server only notices via its own timeout
    // (which can take a while), during which a client's automatic reconnect
    // (see App.tsx's scheduleReconnect) gets rejected by the server as a
    // duplicate identity (e.g. "ClientTooManyClonesConnected"). shuttingDown
    // suppresses forwarding the resulting "disconnected" event to the
    // browser - the browser must see a raw socket close here, not an
    // explicit disconnect, or it treats it as deliberate and won't retry.
    shuttingDown = true;
    await Promise.race([
      Promise.all([...liveConnections].map((c) => c.disconnect().catch(() => {}))),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    console.log(`[gateway] shutting down`);
    process.exit(0);
  })();
});

server.listen(PORT, () => {
  const scheme = tlsOptions ? "https" : "http";
  console.log(
    `WebSpeak3 gateway listening on ${scheme}://localhost:${PORT} (WebSocket at /ws)`
  );
  if (SERVE_STATIC) {
    console.log(`Serving static UI from ${WEB_DIST}`);
    console.log(`Dev tip: use http://localhost:5173/ for live UI; rebuild web/dist after UI changes if you open :${PORT}`);
  } else {
    console.log(`Static UI disabled (WEB_STATIC=0): WebSocket and /api/feedback only, no UI served from this host`);
  }
});

wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
  // One browser WebSocket ↔ one Rust connector. Multi-join in the UI opens
  // multiple /ws connections in parallel (one per server tab).
  let connection: Ts3Connection | undefined;

  // Full: accept and say so, since a browser can't read why an upgrade was refused.
  if (MAX_CONNECTIONS > 0 && wss.clients.size > MAX_CONNECTIONS) {
    socket.send(JSON.stringify({ type: "error", code: "gateway_full", message: "This gateway is full right now. Please try again in a few minutes." }));
    socket.close(1013, "Gateway is full");
    return;
  }

  const ip = clientIp(req);
  connectionsPerIp.set(ip, (connectionsPerIp.get(ip) ?? 0) + 1);

  // The hosted UI updates on every push, the gateway only when its image is
  // pulled, so the browser must not assume a feature exists just because it
  // knows about it. A gateway without "hello" (before v0.15) supports the
  // v0.14 feature set, streaming included; anything newer gets a name here.
  socket.send(JSON.stringify({ type: "hello", features: GATEWAY_FEATURES, iceServers: turnServers() }));

  heartbeats.set(socket, { isAlive: true });
  socket.on("pong", () => {
    const state = heartbeats.get(socket);
    if (state) state.isAlive = true;
  });

  socket.on("message", async (raw) => {
    // Everything below runs inside this try/catch on purpose: any exception
    // here - malformed JSON, a handler throwing on unexpected input - would
    // otherwise become an unhandled rejection (this callback is async) and
    // take the whole process down with it, dropping every other connected
    // user's live session. One bad message from one tab must never do that.
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    try {
      await handleMessage(msg);
    } catch (err) {
      console.error("[gateway] Error handling WS message:", err);
      try {
        socket.send(JSON.stringify({ type: "error", message: "Internal error handling message" }));
      } catch {
        /* socket already gone */
      }
    }

    async function handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case "connect": {
        if (!isValidHost(msg.host) || !isValidNickname(msg.nickname)) {
          socket.send(JSON.stringify({ type: "error", message: "Invalid server address or nickname." }));
          break;
        }
        if (!isServerAllowed(msg.host)) {
          socket.send(
            JSON.stringify({ type: "error", message: "This server is not allowed by this gateway's admin." }),
          );
          break;
        }
        if (CONNECT_RATE_LIMIT > 0 && isConnectRateLimited(ip)) {
          console.warn(`[ratelimit] too many connects from one IP, target host=${msg.host}`);
          socket.send(
            JSON.stringify({ type: "error", message: "Too many connection attempts. Please wait a minute." }),
          );
          break;
        }
        // Replacing a connection on the same socket: tear down the previous
        // connector so we don't leak processes.
        if (connection) {
          try {
            await connection.disconnect();
          } catch {
            /* ignore */
          }
          liveConnections.delete(connection);
          connection = undefined;
        }
        const options: Ts3ConnectOptions = {
          host: msg.host,
          nickname: msg.nickname,
          serverPassword: msg.serverPassword,
          channelPassword: msg.channelPassword,
          defaultChannel: msg.defaultChannel,
          identity: msg.identity,
          serverType: parseServerType(msg.serverType),
          privilegeKey: parsePrivilegeKey(msg),
        };
        connection = new Ts3Connection(options);
        liveConnections.add(connection);
        connection.onEvent((event) => {
          if (shuttingDown) return;
          if (event.type === "connected") {
            logConnectionEvent({ type: "connected", host: options.host, server: event.serverName });
          } else if (event.type === "disconnected") {
            logConnectionEvent({ type: "disconnected", host: options.host });
          }
          socket.send(JSON.stringify(event));
        });
        await connection.connect();
        break;
      }
      case "switchChannel": {
        const channelId = Number(msg.channelId);
        if (Number.isFinite(channelId)) {
          await connection?.switchChannel(channelId, msg.channelPassword);
        }
        break;
      }
      case "moveClient": {
        const clientId = Number(msg.clientId);
        const channelId = Number(msg.channelId);
        if (Number.isFinite(clientId) && Number.isFinite(channelId)) {
          await connection?.moveClient(clientId, channelId, msg.channelPassword);
        }
        break;
      }
      case "sendChatMessage": {
        await connection?.sendChatMessage(msg.message);
        break;
      }
      case "sendServerMessage": {
        await connection?.sendServerMessage(msg.message);
        break;
      }
      case "sendPrivateMessage": {
        await connection?.sendPrivateMessage(msg.clientId, msg.message);
        break;
      }
      case "sendPoke": {
        await connection?.sendPoke(msg.clientId, msg.message ?? "");
        break;
      }
      case "sendAudio": {
        await connection?.sendAudio(msg.pcm);
        break;
      }
      case "requestStreamInfo": {
        const clientId = Number(msg.clientId);
        if (Number.isFinite(clientId)) await connection?.requestStreamInfo(clientId);
        break;
      }
      case "joinStream": {
        const clientId = Number(msg.clientId);
        if (Number.isFinite(clientId)) {
          await connection?.joinStream(String(msg.streamId ?? ""), clientId, msg.message ?? "");
        }
        break;
      }
      case "leaveStream": {
        const clientId = Number(msg.clientId);
        if (Number.isFinite(clientId)) {
          await connection?.leaveStream(String(msg.streamId ?? ""), clientId);
        }
        break;
      }
      case "streamSignal": {
        const clientId = Number(msg.clientId);
        if (Number.isFinite(clientId) && msg.payload !== undefined) {
          await connection?.sendStreamSignal(String(msg.streamId ?? ""), clientId, msg.payload);
        }
        break;
      }
      case "setupStream": {
        await connection?.setupStream({
          name: String(msg.name ?? "Stream"),
          type: Number(msg.streamType ?? 3),
          bitrate: Number(msg.bitrate ?? 1_500_000),
          accessibility: Number(msg.accessibility ?? 1),
          mode: Number(msg.mode ?? 1),
          viewerLimit: Number(msg.viewerLimit ?? 0),
          audio: Boolean(msg.audio),
        });
        break;
      }
      case "respondJoinStream": {
        const clientId = Number(msg.clientId);
        if (Number.isFinite(clientId)) {
          await connection?.respondJoinStream(
            String(msg.streamId ?? ""),
            clientId,
            Boolean(msg.accept),
            String(msg.offer ?? ""),
            String(msg.message ?? ""),
          );
        }
        break;
      }
      case "stopStream": {
        await connection?.stopStream(String(msg.streamId ?? ""), String(msg.reason ?? ""));
        break;
      }
      case "setAway": {
        await connection?.setAway(msg.away, msg.message ?? "");
        break;
      }
      case "setInputMuted": {
        await connection?.setInputMuted(msg.muted);
        break;
      }
      case "setOutputMuted": {
        await connection?.setOutputMuted(msg.muted);
        break;
      }
      case "setClientVolume": {
        connection?.setClientVolume(Number(msg.clientId), Number(msg.volume));
        break;
      }
      case "setNickname": {
        await connection?.setNickname(msg.nickname);
        break;
      }
      case "setWhisperPolicy": {
        connection?.setWhisperPolicy(msg.block === true, Array.isArray(msg.exceptions) ? msg.exceptions : []);
        break;
      }
      case "setWhisperTargets": {
        await connection?.setWhisperTargets(msg.channelIds ?? [], msg.clientIds ?? []);
        break;
      }
      case "getClientConnectionInfo": {
        await connection?.getClientConnectionInfo(msg.clientId);
        break;
      }
      case "getServerConnectionInfo": {
        await connection?.getServerConnectionInfo();
        break;
      }
      case "kickFromChannel": {
        await connection?.kickFromChannel(msg.clientId, msg.reason ?? "");
        break;
      }
      case "kickFromServer": {
        await connection?.kickFromServer(msg.clientId, msg.reason ?? "");
        break;
      }
      case "banClient": {
        await connection?.banClient(msg.clientId, msg.seconds ?? 0, msg.reason ?? "");
        break;
      }
      case "editServer": {
        await connection?.editServer(msg.payload ?? {});
        break;
      }
      case "getServerLog": {
        await connection?.getServerLog();
        break;
      }
      case "getBanList": {
        await connection?.getBanList();
        break;
      }
      case "deleteBan": {
        await connection?.deleteBan(msg.banId);
        break;
      }
      case "deleteAllBans": {
        await connection?.deleteAllBans();
        break;
      }
      case "getComplainList": {
        await connection?.getComplainList();
        break;
      }
      case "deleteComplaint": {
        await connection?.deleteComplaint(msg.targetClientDbId, msg.fromClientDbId);
        break;
      }
      case "deleteAllComplaintsFor": {
        await connection?.deleteAllComplaintsFor(msg.targetClientDbId);
        break;
      }
      case "getOfflineMessageList": {
        await connection?.getOfflineMessageList();
        break;
      }
      case "getOfflineMessage": {
        await connection?.getOfflineMessage(msg.messageId);
        break;
      }
      case "sendOfflineMessage": {
        await connection?.sendOfflineMessage(msg.clientUid, msg.subject, msg.message);
        break;
      }
      case "deleteOfflineMessage": {
        await connection?.deleteOfflineMessage(msg.messageId);
        break;
      }
      case "markOfflineMessageRead": {
        await connection?.markOfflineMessageRead(msg.messageId);
        break;
      }
      case "getChannelGroupList": {
        await connection?.getChannelGroupList();
        break;
      }
      case "getServerGroupList": {
        await connection?.getServerGroupList();
        break;
      }
      case "setChannelGroup": {
        await connection?.setChannelGroup(msg.channelGroupId, msg.channelId, msg.clientDbId);
        break;
      }
      case "addServerGroup": {
        await connection?.addServerGroup(msg.serverGroupId, msg.clientDbId);
        break;
      }
      case "removeServerGroup": {
        await connection?.removeServerGroup(msg.serverGroupId, msg.clientDbId);
        break;
      }
      case "serverQueryLogin": {
        await connection?.serverQueryLogin(msg.username, msg.password);
        break;
      }
      case "getPermissionOverview": {
        await connection?.getPermissionOverview();
        break;
      }
      case "getFileList": {
        await connection?.getFileList(msg.channelId, msg.path);
        break;
      }
      case "createDirectory": {
        await connection?.createDirectory(msg.channelId, msg.dirname);
        break;
      }
      case "deleteFile": {
        await connection?.deleteFile(msg.channelId, msg.name);
        break;
      }
      case "renameFile": {
        await connection?.renameFile(msg.channelId, msg.oldName, msg.newName);
        break;
      }
      case "downloadFile": {
        await connection?.downloadFile(msg.channelId, msg.path);
        break;
      }
      case "setTransferLimit": {
        connection?.setTransferLimit(msg.up, msg.down);
        break;
      }
      case "uploadFile": {
        await connection?.uploadFile(msg.channelId, msg.path, msg.dataBase64);
        break;
      }
      case "uploadFileChunk": {
        await connection?.uploadFileChunk(msg.channelId, msg.path, msg.offset, msg.total, msg.data);
        break;
      }
      case "getPermissionCatalog": {
        await connection?.getPermissionCatalog();
        break;
      }
      case "getPermList": {
        await connection?.getPermList(msg.scope, msg.id1, msg.id2);
        break;
      }
      case "addPermission": {
        await connection?.addPermission(msg.scope, msg.ids, msg.permId, msg.value, msg.negated, msg.skip);
        break;
      }
      case "removePermission": {
        await connection?.removePermission(msg.scope, msg.ids, msg.permId);
        break;
      }
      case "disconnect": {
        await connection?.disconnect(msg.message ?? "");
        if (connection) liveConnections.delete(connection);
        connection = undefined;
        break;
      }
      default:
        socket.send(
          JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` })
        );
    }
    }
  });

  socket.on("close", () => {
    const remaining = (connectionsPerIp.get(ip) ?? 1) - 1;
    if (remaining > 0) connectionsPerIp.set(ip, remaining);
    else connectionsPerIp.delete(ip);
    heartbeats.delete(socket);
    if (connection) liveConnections.delete(connection);
    connection?.disconnect();
  });
});
