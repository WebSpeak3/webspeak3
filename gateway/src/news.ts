// --- News ticker -----------------------------------------------------------
//
// Two halves:
// * handleNewsFeed - the central feed every client shows by default. Served
//   by store-server.ts at /api/store/news, so it rides the existing
//   /api/store tunnel route. Manual items live in NEWS_DATA_FILE and are
//   managed with STORE_ADMIN_TOKEN (the stats panel); the latest release and
//   the newest store design are added automatically.
// * handleNewsConfig - every gateway's /api/news. Tells its own client
//   whether to show the ticker at all (NEWS_TICKER=0 turns it off), whether
//   to include the central feed (NEWS_TICKER_CENTRAL=0 drops it), and the
//   instance's own messages (NEWS_TICKER_MESSAGES, separated by "|").
//
// Like store.ts, this file has zero private modifications.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAdminRequest, latestPublicTheme } from "./store.js";

type NewsItem =
  | { id: string; kind: "text"; text: string; url?: string; at: string }
  | { id: string; kind: "release"; version: string; url: string; at: string }
  | { id: string; kind: "theme"; name: string; author: string; at: string };
type TextItem = Extract<NewsItem, { kind: "text" }>;

const NEWS_DATA_FILE = process.env.NEWS_DATA_FILE;
const MAX_ITEMS = 20;
const MAX_TEXT = 300;
const AUTO_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let cache: TextItem[] | null = null;

async function load(): Promise<TextItem[]> {
  if (cache) return cache;
  if (!NEWS_DATA_FILE) return (cache = []);
  try {
    cache = JSON.parse(await readFile(NEWS_DATA_FILE, "utf-8")) as TextItem[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    cache = [];
  }
  return cache;
}

async function save(items: TextItem[]) {
  const tmp = `${NEWS_DATA_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(items), "utf-8");
  await rename(tmp, NEWS_DATA_FILE!);
  cache = items;
}

// Unauthenticated GitHub API allows 60 requests/hour; one per hour is plenty.
let release: { item: NewsItem | null; fetchedAt: number } = { item: null, fetchedAt: 0 };

async function latestRelease(): Promise<NewsItem | null> {
  if (Date.now() - release.fetchedAt < 60 * 60 * 1000) return release.item;
  release.fetchedAt = Date.now();
  try {
    const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO || "WebSpeak3/webspeak3"}/releases?per_page=1`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "webspeak3-store" },
    });
    if (!res.ok) return release.item;
    const [r] = (await res.json()) as { tag_name: string; html_url: string; published_at: string }[];
    release.item = r ? { id: `release-${r.tag_name}`, kind: "release", version: r.tag_name, url: r.html_url, at: r.published_at } : null;
  } catch (err) {
    console.error("[news] Release lookup failed:", err);
  }
  return release.item;
}

function isRecent(item: NewsItem | null | undefined): item is NewsItem {
  return item != null && Date.now() - Date.parse(item.at) < AUTO_MAX_AGE_MS;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 5_000) return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function handleNewsFeed(req: IncomingMessage, res: ServerResponse, pathname: string) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/api/store/news") {
    const theme = await latestPublicTheme();
    const auto = [
      await latestRelease(),
      theme && ({ id: `theme-${theme.id}`, kind: "theme", name: theme.name, author: theme.author, at: theme.createdAt } as NewsItem),
    ].filter(isRecent);
    res.setHeader("Cache-Control", "public, max-age=300");
    json(res, 200, { items: [...(await load()), ...auto] });
    return;
  }

  // /api/store/news/admin: GET lists, POST {action:"add",text,url?} or {action:"delete",id}.
  if (!NEWS_DATA_FILE) return json(res, 404, { error: "not_found" });
  if (!isAdminRequest(req)) return json(res, 401, { error: "unauthorized" });
  if (req.method === "GET") return json(res, 200, { items: await load() });
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

  const body = await readBody(req);
  const items = [...(await load())];
  if (body?.action === "delete" && typeof body.id === "string") {
    await save(items.filter((i) => i.id !== body.id));
    return json(res, 200, { ok: true });
  }
  if (body?.action === "add" && typeof body.text === "string" && body.text.trim()) {
    const url = typeof body.url === "string" && /^https:\/\/\S+$/.test(body.url.trim()) ? body.url.trim() : undefined;
    if (items.length >= MAX_ITEMS) return json(res, 400, { error: "too_many_items" });
    items.push({ id: randomUUID(), kind: "text", text: body.text.trim().slice(0, MAX_TEXT), url, at: new Date().toISOString() });
    await save(items);
    return json(res, 200, { ok: true });
  }
  json(res, 400, { error: "bad_request" });
}

// Read per request: the admin panel (config.ts) can change these at runtime.
const localItems = (): NewsItem[] =>
  (process.env.NEWS_TICKER_MESSAGES ?? "")
    .split("|")
    .map((text) => text.trim().slice(0, MAX_TEXT))
    .filter(Boolean)
    .map((text, i) => ({ id: `local-${i}-${text}`, kind: "text", text, at: "" }));

export function handleNewsConfig(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=300");
  json(
    res,
    200,
    process.env.NEWS_TICKER !== "0"
      ? { enabled: true, central: process.env.NEWS_TICKER_CENTRAL !== "0", items: localItems() }
      : { enabled: false },
  );
}
