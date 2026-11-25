import type { IncomingMessage } from "node:http";

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
