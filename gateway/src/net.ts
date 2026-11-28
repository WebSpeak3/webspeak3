import type { IncomingMessage } from "node:http";
import { rename, writeFile } from "node:fs/promises";

// Behind a reverse proxy / tunnel every request arrives from the proxy's own
// address, so per-IP limits would lump all users into one bucket. Only set
// TRUST_PROXY when the gateway is reachable *solely* through that proxy:
// - "cloudflare": CF-Connecting-IP, which Cloudflare always sets itself.
// - "1": the last X-Forwarded-For entry, the one our own proxy appended;
//   anything before it came from the client and can be made up.
export function clientIp(req: IncomingMessage): string {
  // Read per request: the admin panel can change it live.
  const TRUST_PROXY = process.env.TRUST_PROXY;
  if (TRUST_PROXY === "cloudflare") {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.trim()) return cf.trim();
  } else if (TRUST_PROXY === "1") {
    const last = String(req.headers["x-forwarded-for"] ?? "").split(",").at(-1)?.trim();
    if (last) return last;
  }
  return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}

/** Sliding-window "N per window per key" limiter. Expired keys are swept
 *  periodically so the map can't grow without bound under a stream of
 *  one-shot IPs. */
export function createRateLimiter(limit: number | (() => number), windowMs: number): (key: string) => boolean {
  const hits = new Map<string, number[]>();
  setInterval(() => {
    const now = Date.now();
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= windowMs)) hits.delete(key);
    }
  }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    return recent.length > (typeof limit === "function" ? limit() : limit);
  };
}

/** Write-then-rename, one write at a time per file. Concurrent requests used
 *  to share one `.tmp` path: one rename won, the others failed with ENOENT,
 *  and overlapping writes could leave a mangled file. Queued, the last caller's
 *  data always lands last. */
const writeQueues = new Map<string, Promise<void>>();
export function writeFileAtomic(file: string, data: string, mode?: number): Promise<void> {
  const run = async () => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, data, { encoding: "utf-8", mode });
    await rename(tmp, file);
  };
  const done = (writeQueues.get(file) ?? Promise.resolve()).then(run);
  const tail = done.catch(() => {});
  writeQueues.set(file, tail);
  void tail.then(() => { if (writeQueues.get(file) === tail) writeQueues.delete(file); });
  return done;
}
