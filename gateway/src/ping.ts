// --- Receiving end of telemetry.ts ---------------------------------------------
//
// Only served by store-server.ts, and only with PING_DATA_FILE set. Keeps one
// row per instance id: version, first and last seen. No IP addresses, no
// request log. The admin view returns counts only.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { clientIp, createRateLimiter, writeFileAtomic } from "./net.js";
import { isAdminRequest } from "./store.js";

const PING_DATA_FILE = process.env.PING_DATA_FILE;
const MAX_INSTANCES = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const isRateLimited = createRateLimiter(20, 60 * 60 * 1000);

interface Instance {
  version: string;
  firstSeen: string;
  lastSeen: string;
}

let cache: Record<string, Instance> | null = null;

async function load(): Promise<Record<string, Instance>> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(PING_DATA_FILE!, "utf-8")) as Record<string, Instance>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    cache = {};
  }
  return cache;
}

async function save(instances: Record<string, Instance>) {
  // Instances silent for 90 days are gone for good.
  const cutoff = Date.now() - 90 * DAY_MS;
  for (const [id, i] of Object.entries(instances)) if (Date.parse(i.lastSeen) < cutoff) delete instances[id];
  await writeFileAtomic(PING_DATA_FILE!, JSON.stringify(instances));
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function handlePing(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (!PING_DATA_FILE) return json(res, 404, { error: "not_found" });

  if (pathname === "/api/ping/stats" && req.method === "GET") {
    if (!isAdminRequest(req)) return json(res, 401, { error: "unauthorized" });
    const now = Date.now();
    const instances = Object.values(await load());
    const activeSince = (days: number) => instances.filter((i) => now - Date.parse(i.lastSeen) < days * DAY_MS);
    const versions: Record<string, number> = {};
    for (const i of activeSince(30)) versions[i.version] = (versions[i.version] ?? 0) + 1;
    return json(res, 200, {
      active2d: activeSince(2).length,
      active7d: activeSince(7).length,
      active30d: activeSince(30).length,
      newLast7d: instances.filter((i) => now - Date.parse(i.firstSeen) < 7 * DAY_MS).length,
      versions,
    });
  }

  if (pathname !== "/api/ping" || req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  if (isRateLimited(clientIp(req))) return json(res, 429, { error: "rate_limited" });

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 500) return json(res, 413, { error: "payload_too_large" });
  }
  let body: { id?: unknown; version?: unknown };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return json(res, 400, { error: "invalid_json" });
  }
  const { id, version } = body;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id) || typeof version !== "string" || !/^[\w.+-]{1,40}$/.test(version)) {
    return json(res, 400, { error: "invalid_ping" });
  }

  const instances = await load();
  const now = new Date().toISOString();
  const known = instances[id];
  if (!known && Object.keys(instances).length >= MAX_INSTANCES) return json(res, 507, { error: "full" });
  instances[id] = { version, firstSeen: known?.firstSeen ?? now, lastSeen: now };
  await save(instances);
  json(res, 200, { ok: true });
}
