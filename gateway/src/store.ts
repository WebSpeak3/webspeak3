// --- Design Store endpoint -------------------------------------------------
//
// Opt-in only, same convention as LOG_CONNECTIONS/FEEDBACK_ENABLED/BROADCAST_TOKEN
// in index.ts: public CSS uploads need moderation attention a plain self-hosted
// instance shouldn't inherit just because the code exists. Set STORE_ENABLED=1
// to turn it on.
//
// Kept in its own module (unlike feedback/broadcast, which stay inline in
// index.ts) so the private VPS overlay - a hand-patched fork of index.ts that
// swaps feedback/connection persistence to SQLite - never needs this file
// touched. It has zero private modifications, so the overlay just copies it
// verbatim; only index.ts's small SQLite-persistence sections need patching.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { timingSafeEqual, randomUUID } from "node:crypto";
import path from "node:path";
import { clientIp, createRateLimiter } from "./net.js";

const STORE_ENABLED = process.env.STORE_ENABLED === "1";
const STORE_ALLOWED_ORIGIN = process.env.STORE_ALLOWED_ORIGIN ?? "*";
// Plain JSON file (whole-array read-modify-write, not JSON-lines like
// feedback.log in index.ts): the store needs to list and look up by id, and
// the expected volume (community theme submissions) is small enough that
// rewriting the whole file each time is simpler than a real DB - see the
// "never add SQLite to the public gateway" note in mem:reference_webspeak3_private_sqlite_persistence.
const STORE_DATA_FILE = process.env.STORE_DATA_FILE ?? path.resolve(process.cwd(), "store-themes.json");
const STORE_NAME_MAX_LENGTH = 60;
const STORE_AUTHOR_MAX_LENGTH = 40;
const STORE_DESCRIPTION_MAX_LENGTH = 300;
const STORE_CSS_MAX_LENGTH = 50_000;
// ~300KB image after base64 overhead - screenshots live inline in the same
// flat JSON file as everything else, so this also bounds that file's growth.
const STORE_SCREENSHOT_MAX_DATA_URL_LENGTH = 400_000;
const STORE_SCREENSHOT_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+=*$/;
// Hard cap so the flat file - and the in-memory cache mirroring it - can't
// grow unbounded from spam that slips past rate limiting (a fresh IP per
// submission, say). Bounds worst case to ~300 * 450KB =~ 135MB in RAM.
const STORE_MAX_THEMES = 300;
const STORE_BASE_THEMES = new Set(["standard", "nova", "pulse", "ide"]);

// A handful of names (the operator's own) that only whoever holds
// STORE_ADMIN_TOKEN may publish under - stops anyone else from impersonating
// the maintainer in the author field. Everyone else's name is first-come,
// unenforced, same as any other free-text field here.
const STORE_RESERVED_AUTHORS = new Set(
  (process.env.STORE_RESERVED_AUTHORS ?? "Möpchi,Moepchi")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const STORE_ADMIN_TOKEN = process.env.STORE_ADMIN_TOKEN;

function isValidStoreAdminToken(provided: string): boolean {
  if (!STORE_ADMIN_TOKEN) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(STORE_ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface StoreTheme {
  id: string;
  name: string;
  baseTheme: string;
  css: string;
  author: string;
  description: string;
  screenshot: string | null;
  ratingSum: number;
  ratingCount: number;
  createdAt: string;
  // New submissions start "pending" and only become public once someone
  // holding STORE_ADMIN_TOKEN approves them (GET /api/store/admin); rejected
  // ones are deleted outright. "rejected" only survives in old data files.
  status: "approved" | "pending" | "rejected";
}

// Undo what a plain pattern check would miss: comments splitting a keyword
// (u/**/rl), CSS escapes (\75 rl( is url(), and case.
function normalizeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "\ufffd";
    })
    .replace(/\\(.)/gs, "$1")
    .toLowerCase();
}

// Theme CSS runs in every installer's browser, so it may style the app but
// never load anything: no imports/fonts, no functions that fetch a resource,
// and url() only for inline data: images. Everything else (colors,
// selectors, animations) can at worst look bad - which moderation catches.
const FORBIDDEN_CSS = [
  /@import/,
  /@font-face/,
  /@namespace/,
  /(?:^|[^a-z-])(?:image-set|image|cross-fade|element|src|expression)\s*\(/,
  /-moz-binding/,
  /behavior\s*:/,
  /javascript:/,
  /<\/?style/,
];

export function isSafeThemeCss(css: string): boolean {
  const normalized = normalizeCss(css);
  if (FORBIDDEN_CSS.some((re) => re.test(normalized))) return false;
  for (const match of normalized.matchAll(/url\s*\(\s*(["']?)\s*([^"')\s]*)/g)) {
    if (!/^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/.test(match[2])) return false;
  }
  return true;
}

let storeCache: StoreTheme[] | null = null;

async function loadStoreThemes(): Promise<StoreTheme[]> {
  if (storeCache) return storeCache;
  try {
    storeCache = JSON.parse(await readFile(STORE_DATA_FILE, "utf-8")) as StoreTheme[];
  } catch (err) {
    // Only a missing file means "no themes yet". Anything else (unreadable,
    // corrupt) must fail loudly - treating it as empty would let the next
    // submission overwrite every stored theme.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    storeCache = [];
  }
  return storeCache;
}

async function saveStoreThemes(themes: StoreTheme[]): Promise<void> {
  storeCache = themes;
  // Write-then-rename: a crash mid-write must not leave a truncated file,
  // which loadStoreThemes() would read as "no themes" and then overwrite.
  const tmp = `${STORE_DATA_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(themes), "utf-8");
  await rename(tmp, STORE_DATA_FILE);
}

export function isAdminRequest(req: IncomingMessage): boolean {
  const authHeader = req.headers.authorization ?? "";
  return authHeader.startsWith("Bearer ") && isValidStoreAdminToken(authHeader.slice("Bearer ".length));
}

// Approved, and still passing today's CSS check - themes published before
// that check got stricter are hidden instead of served.
function isPublic(theme: StoreTheme): boolean {
  return theme.status === "approved" && isSafeThemeCss(theme.css);
}

/** Newest public design, for the news ticker (news.ts). */
export async function latestPublicTheme(): Promise<StoreTheme | undefined> {
  return (await loadStoreThemes()).filter(isPublic).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

// Same in-memory-per-IP approach as FEEDBACK_RATE_LIMIT in index.ts; kept as a
// separate map since the two endpoints are independent.
const STORE_RATE_LIMIT = 5;
const STORE_RATE_WINDOW_MS = 60 * 60 * 1000;
const isStoreRateLimited = createRateLimiter(STORE_RATE_LIMIT, STORE_RATE_WINDOW_MS);

// One rating per IP per theme - not robust against a determined multi-IP
// spammer, but it stops the trivial "click again" case with no accounts to
// build. Memory-only, so it resets on redeploy; a repeat vote after that just
// counts twice, which is an acceptable ceiling for a beta feature.
const storeRatingsSeen = new Set<string>();

function setStoreCors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", STORE_ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function storeRating(theme: StoreTheme): { average: number; count: number } {
  // theme.ratingCount is undefined for themes submitted before this field existed.
  const count = theme.ratingCount ?? 0;
  return { average: count ? theme.ratingSum / count : 0, count };
}

async function handleStoreList(res: ServerResponse) {
  const themes = await loadStoreThemes();
  const listing = themes
    .filter(isPublic)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((t) => ({
      id: t.id,
      name: t.name,
      baseTheme: t.baseTheme,
      author: t.author,
      description: t.description ?? "",
      hasScreenshot: Boolean(t.screenshot),
      rating: storeRating(t),
      createdAt: t.createdAt,
    }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(listing));
}

async function handleStoreDownload(req: IncomingMessage, res: ServerResponse, id: string) {
  const themes = await loadStoreThemes();
  const theme = themes.find((t) => t.id === id && (isPublic(t) || isAdminRequest(req)));
  if (!theme) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  // Same shape as the client's own .webspeak3theme.json export/import, so the
  // browsed result feeds straight into the existing import validator.
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ name: theme.name, baseTheme: theme.baseTheme, css: theme.css }));
}

async function handleStoreScreenshot(req: IncomingMessage, res: ServerResponse, id: string) {
  const themes = await loadStoreThemes();
  const theme = themes.find((t) => t.id === id && (isPublic(t) || isAdminRequest(req)));
  if (!theme?.screenshot) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(theme.screenshot);
  if (!match) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  res.writeHead(200, { "Content-Type": match[1], "Cache-Control": "public, max-age=3600" });
  res.end(Buffer.from(match[2], "base64"));
}

async function handleStoreRate(req: IncomingMessage, res: ServerResponse, id: string) {
  const ip = clientIp(req);
  const seenKey = `${ip}:${id}`;
  if (storeRatingsSeen.has(seenKey)) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "already_rated" }));
    return;
  }

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "payload_too_large" }));
      return;
    }
  }

  let body: { stars?: unknown };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  const stars = typeof body.stars === "number" ? Math.round(body.stars) : NaN;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_stars" }));
    return;
  }

  const themes = await loadStoreThemes();
  const theme = themes.find((t) => t.id === id && isPublic(t));
  if (!theme) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  theme.ratingSum = (theme.ratingSum ?? 0) + stars;
  theme.ratingCount = (theme.ratingCount ?? 0) + 1;
  try {
    await saveStoreThemes(themes);
  } catch (err) {
    console.error("[store] Failed to save rating:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "save_failed" }));
    return;
  }
  // ponytail: wholesale reset instead of per-entry expiry; only bounds memory,
  // at worst it lets old voters vote once more, same as a redeploy does.
  if (storeRatingsSeen.size > 100_000) storeRatingsSeen.clear();
  storeRatingsSeen.add(seenKey);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, rating: storeRating(theme) }));
}

async function handleStoreSubmit(req: IncomingMessage, res: ServerResponse) {
  const ip = clientIp(req);
  if (isStoreRateLimited(ip)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "rate_limited" }));
    return;
  }

  let raw = "";
  const maxBytes = STORE_CSS_MAX_LENGTH + STORE_SCREENSHOT_MAX_DATA_URL_LENGTH + 5_000;
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "payload_too_large" }));
      return;
    }
  }

  let body: {
    name?: unknown;
    baseTheme?: unknown;
    css?: unknown;
    author?: unknown;
    description?: unknown;
    screenshot?: unknown;
    website?: unknown;
  };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  // Honeypot, same as /api/feedback in index.ts.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const name = typeof body.name === "string" ? body.name.trim().slice(0, STORE_NAME_MAX_LENGTH) : "";
  const baseTheme = typeof body.baseTheme === "string" && STORE_BASE_THEMES.has(body.baseTheme) ? body.baseTheme : "";
  const rawCss = typeof body.css === "string" ? body.css.slice(0, STORE_CSS_MAX_LENGTH) : "";
  const author =
    typeof body.author === "string" ? body.author.trim().slice(0, STORE_AUTHOR_MAX_LENGTH) || "Anonymous" : "Anonymous";
  const description = typeof body.description === "string" ? body.description.trim().slice(0, STORE_DESCRIPTION_MAX_LENGTH) : "";

  if (!name || !baseTheme || !rawCss) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_theme" }));
    return;
  }

  const isAdmin = isAdminRequest(req);
  if (STORE_RESERVED_AUTHORS.has(author.toLowerCase())) {
    if (!isAdmin) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "author_reserved" }));
      return;
    }
  }

  const css = rawCss;
  if (!isSafeThemeCss(css)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "css_rejected" }));
    return;
  }

  let screenshot: string | null = null;
  if (typeof body.screenshot === "string" && body.screenshot !== "") {
    if (body.screenshot.length > STORE_SCREENSHOT_MAX_DATA_URL_LENGTH || !STORE_SCREENSHOT_RE.test(body.screenshot)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_screenshot" }));
      return;
    }
    screenshot = body.screenshot;
  }

  const themes = await loadStoreThemes();
  // Re-uploading an installed store theme unchanged would just duplicate it.
  const cssKey = normalizeCss(css).replace(/\s+/g, "");
  if (themes.some((t) => normalizeCss(t.css).replace(/\s+/g, "") === cssKey)) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "duplicate" }));
    return;
  }
  if (themes.length >= STORE_MAX_THEMES) {
    res.writeHead(507, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "store_full" }));
    return;
  }

  const theme: StoreTheme = {
    id: randomUUID(),
    name,
    baseTheme,
    css,
    author,
    description,
    screenshot,
    ratingSum: 0,
    ratingCount: 0,
    createdAt: new Date().toISOString(),
    // The admin's own submissions skip the queue - they'd approve them anyway.
    status: isAdmin ? "approved" : "pending",
  };
  themes.push(theme);
  try {
    await saveStoreThemes(themes);
  } catch (err) {
    console.error("[store] Failed to save theme:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "save_failed" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, id: theme.id, status: theme.status }));
  if (theme.status === "pending") console.log(`[store] New theme awaiting review: "${theme.name}" (${theme.id})`);
}

async function handleStorePending(req: IncomingMessage, res: ServerResponse) {
  if (!isAdminRequest(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const themes = await loadStoreThemes();
  const pending = themes
    .filter((t) => t.status === "pending")
    .map(({ screenshot, ratingSum: _s, ratingCount: _c, ...t }) => ({ ...t, hasScreenshot: Boolean(screenshot) }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(pending));
}

async function handleStoreModerate(req: IncomingMessage, res: ServerResponse, id: string, action: string) {
  if (!isAdminRequest(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const themes = await loadStoreThemes();
  const index = themes.findIndex((t) => t.id === id);
  if (index === -1) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  // Reject and delete are the same thing: drop it, freeing its slot.
  if (action === "approve") themes[index].status = "approved";
  else themes.splice(index, 1);
  try {
    await saveStoreThemes(themes);
  } catch (err) {
    console.error("[store] Failed to save moderation result:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "save_failed" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

// Minimal moderation page. The theme CSS is shown as text only (textContent),
// never applied, so reviewing a hostile submission is harmless.
const ADMIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Store moderation</title><style>
body{font:14px system-ui;margin:0 auto;padding:1rem;max-width:60rem;background:#111;color:#eee}
input,button{font:inherit;padding:.4rem .7rem}article{border:1px solid #444;border-radius:8px;padding:1rem;margin:1rem 0}
pre{max-height:20rem;overflow:auto;background:#000;padding:.5rem;white-space:pre-wrap}img{max-width:100%}
.ok{background:#2a6}.no{background:#a33}button{color:#fff;border:0;border-radius:4px;cursor:pointer}
</style></head><body><h1>Design Store – pending themes</h1>
<p><input id="token" type="password" placeholder="STORE_ADMIN_TOKEN" size="40"> <button class="ok" id="load">Load</button></p>
<div id="list"></div><script>
const base = location.pathname.replace(/\/admin$/, "/themes");
const auth = () => ({ Authorization: "Bearer " + document.getElementById("token").value });
async function load() {
  const list = document.getElementById("list");
  list.textContent = "Loading…";
  const res = await fetch(base + "/pending", { headers: auth() });
  if (!res.ok) { list.textContent = "Error " + res.status; return; }
  const themes = await res.json();
  list.textContent = themes.length ? "" : "Nothing to review.";
  for (const t of themes) {
    const el = document.createElement("article");
    const h = document.createElement("h2"); h.textContent = t.name + " – " + t.author + " (" + t.baseTheme + ")"; el.append(h);
    const d = document.createElement("p"); d.textContent = t.description + " · " + t.createdAt; el.append(d);
    if (t.hasScreenshot) {
      const img = document.createElement("img"); el.append(img);
      fetch(base + "/" + t.id + "/screenshot", { headers: auth() }).then(r => r.blob()).then(b => img.src = URL.createObjectURL(b));
    }
    const pre = document.createElement("pre"); pre.textContent = t.css; el.append(pre);
    for (const [action, label, cls] of [["approve", "Approve", "ok"], ["reject", "Reject (delete)", "no"]]) {
      const b = document.createElement("button"); b.textContent = label; b.className = cls; b.style.marginRight = ".5rem";
      b.onclick = async () => {
        const r = await fetch(base + "/" + t.id + "/" + action, { method: "POST", headers: auth() });
        if (r.ok) el.remove(); else alert("Error " + r.status);
      };
      el.append(b);
    }
    list.append(el);
  }
}
document.getElementById("load").onclick = load;
</script></body></html>`;

export async function handleStore(req: IncomingMessage, res: ServerResponse, pathname: string) {
  setStoreCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!STORE_ENABLED) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  if (pathname === "/api/store/admin") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(ADMIN_PAGE);
    return;
  }
  if (pathname === "/api/store/themes") {
    if (req.method === "GET") return handleStoreList(res);
    if (req.method === "POST") return handleStoreSubmit(req, res);
  } else {
    const [id, sub] = pathname.slice("/api/store/themes/".length).split("/");
    if (id === "pending" && !sub && req.method === "GET") return handleStorePending(req, res);
    if (id && !sub && req.method === "GET") return handleStoreDownload(req, res, id);
    if (id && sub === "screenshot" && req.method === "GET") return handleStoreScreenshot(req, res, id);
    if (id && (sub === "approve" || sub === "reject") && req.method === "POST") {
      return handleStoreModerate(req, res, id, sub);
    }
    if (id && sub === "rate" && req.method === "POST") return handleStoreRate(req, res, id);
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "method_not_allowed" }));
}
