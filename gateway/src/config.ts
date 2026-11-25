// Settings the admin panel (admin.ts) may change at runtime. Values saved
// there live in ADMIN_CONFIG_FILE and are written onto process.env, both at
// startup and on every save, so code that reads process.env at use time picks
// them up without a restart. Must be imported before any module that reads
// these variables at load time (first import in index.ts).
//
// Settings marked `restart` are only written onto process.env at startup:
// they are read once at load time, so the panel saves them and asks for a
// restart instead of pretending they are live.
//
// Deliberately absent: CONNECTOR_BIN (would be code execution), ALLOW_PRIVATE_TARGETS (opens the
// operator's LAN), and the admin credentials themselves.
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type SettingKind = "number" | "bool" | "list" | "text" | "secret";
export interface Setting {
  key: string;
  kind: SettingKind;
  /** Value used when neither .env nor the panel sets one (shown as hint). */
  fallback?: string;
  help: string;
  group: string;
  /** Only ends up in the UI this gateway serves itself (meta tags). */
  staticOnly?: boolean;
  /** Read once at startup; changes take effect after a restart. */
  restart?: boolean;
}

export const SETTINGS: Setting[] = [
  { group: "Connections & limits", key: "MAX_CONNECTIONS", kind: "number", fallback: "60", help: "Open WebSocket connections in total (0 = unlimited)." },
  { group: "Connections & limits", key: "MAX_CONNECTIONS_PER_IP", kind: "number", fallback: "10", help: "Open connections per client IP (0 = unlimited)." },
  { group: "Connections & limits", key: "CONNECT_RATE_LIMIT", kind: "number", fallback: "30", help: "Connect attempts per IP per minute (0 = unlimited)." },
  { group: "Access", key: "ALLOWED_SERVERS", kind: "list", help: "Comma-separated TeamSpeak servers this gateway may connect to (*.example.com allowed). Empty = any." },
  { group: "Access", key: "ALLOWED_ORIGINS", kind: "list", help: "Comma-separated web origins allowed to use this gateway (https://client.example.com). Empty = any." },
  { group: "Access", key: "TRUST_PROXY", kind: "text", help: "Behind a proxy: \"cloudflare\" (CF-Connecting-IP) or \"1\" (last X-Forwarded-For). Only if the gateway is reachable solely through it. Empty = off." },
  { group: "Connect dialog", staticOnly: true, key: "SERVER_PICKER", kind: "bool", fallback: "1", help: "Offer ALLOWED_SERVERS as a dropdown in the connect dialog." },
  { group: "Connect dialog", staticOnly: true, key: "DEFAULT_SERVER", kind: "text", help: "Server address prefilled in the connect dialog." },
  { group: "Connect dialog", staticOnly: true, key: "DEFAULT_CHANNEL", kind: "text", help: "Channel prefilled in the connect dialog." },
  { group: "Connect dialog", staticOnly: true, key: "SYNC_URL", kind: "text", help: "Own account-sync server (sync-server.js). Empty = the official one." },
  { group: "Features", key: "FEEDBACK_ENABLED", kind: "bool", fallback: "0", help: "Accept in-app feedback (/api/feedback)." },
  { group: "Features", key: "STORE_ENABLED", kind: "bool", fallback: "0", help: "Run the Design Store (theme submissions and downloads)." },
  { group: "Features", key: "LOG_CONNECTIONS", kind: "bool", fallback: "0", help: "Log connects/disconnects (hashed client tags, no plain IPs)." },
  { group: "Features", key: "ENABLE_TS2", kind: "bool", fallback: "0", help: "Allow TeamSpeak 2 servers (experimental)." },
  { group: "Features", key: "TELEMETRY", kind: "bool", fallback: "1", help: "Anonymous daily usage ping (random instance id + version only)." },
  { group: "Feedback & GitHub", key: "FEEDBACK_ALLOWED_ORIGIN", kind: "text", fallback: "*", help: "Web origin allowed to send feedback (CORS). * = any." },
  { group: "Feedback & GitHub", key: "GITHUB_TOKEN", kind: "secret", help: "GitHub token (Issues: write) to turn feedback into issues." },
  { group: "Feedback & GitHub", key: "GITHUB_REPO", kind: "text", fallback: "WebSpeak3/webspeak3", help: "Repository for feedback issues and the release news." },
  { group: "Design Store", key: "STORE_ALLOWED_ORIGIN", kind: "text", fallback: "*", help: "Web origin allowed to use the store (CORS). * = any." },
  { group: "Design Store", key: "STORE_RESERVED_AUTHORS", kind: "list", fallback: "Möpchi,Moepchi", help: "Comma-separated author names only the store admin may publish under." },
  { group: "Design Store", key: "STORE_ADMIN_TOKEN", kind: "secret", help: "Token for approving store submissions." },
  { group: "Access", key: "BROADCAST_TOKEN", kind: "secret", help: "Bearer token for /api/broadcast (notices to all users). Empty = endpoint off." },
  { group: "News ticker", key: "NEWS_TICKER", kind: "bool", fallback: "1", help: "Show the news ticker." },
  { group: "News ticker", key: "NEWS_TICKER_CENTRAL", kind: "bool", fallback: "1", help: "Include the official WebSpeak3 news in the ticker." },
  { group: "News ticker", key: "NEWS_TICKER_MESSAGES", kind: "text", help: "Own ticker messages, separated by |." },
  { group: "Bot check (Cloudflare Turnstile)", key: "TURNSTILE_SITE_KEY", kind: "text", help: "Cloudflare Turnstile site key (bot check, needs the secret too)." },
  { group: "Bot check (Cloudflare Turnstile)", key: "TURNSTILE_SECRET", kind: "secret", help: "Cloudflare Turnstile secret key." },
  { group: "Screen sharing & webcam (TURN)", key: "TURN_URLS", kind: "list", help: "Comma-separated TURN server URLs for screen sharing/webcam." },
  { group: "Screen sharing & webcam (TURN)", key: "TURN_SECRET", kind: "secret", help: "coturn use-auth-secret (per-user credentials)." },
  { group: "Screen sharing & webcam (TURN)", key: "TURN_USERNAME", kind: "text", help: "Static TURN username (if no TURN_SECRET)." },
  { group: "Screen sharing & webcam (TURN)", key: "TURN_CREDENTIAL", kind: "secret", help: "Static TURN password (if no TURN_SECRET)." },
  { group: "Restart required", restart: true, key: "PORT", kind: "number", fallback: "8080", help: "Port the gateway listens on. Careful: with Docker the port mapping must match, or this panel becomes unreachable (fix: remove PORT from admin-config.json)." },
  { group: "Restart required", restart: true, key: "TLS_CERT", kind: "text", help: "Path to the TLS certificate (with TLS_KEY: serve HTTPS directly). A wrong path stops the gateway from starting." },
  { group: "Restart required", restart: true, key: "TLS_KEY", kind: "text", help: "Path to the TLS private key." },
  { group: "Restart required", restart: true, key: "WEB_STATIC", kind: "bool", fallback: "1", help: "Serve the web UI from this gateway. Off when the UI is hosted elsewhere." },
  { group: "Restart required", restart: true, key: "WEB_DIST", kind: "text", help: "Folder with the built web UI (web/dist)." },
  { group: "Restart required", restart: true, key: "STORE_DATA_FILE", kind: "text", fallback: "./store-themes.json", help: "Design Store data file." },
  { group: "Restart required", restart: true, key: "NEWS_DATA_FILE", kind: "text", help: "File for news managed in the stats panel." },
  { group: "Restart required", restart: true, key: "FEEDBACK_LOG_FILE", kind: "text", fallback: "./feedback.log", help: "Private feedback log (includes contact e-mails)." },
  { group: "Restart required", restart: true, key: "TELEMETRY_ID_FILE", kind: "text", fallback: "./instance-id", help: "File holding the random instance id of the usage ping." },
];
const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

const CONFIG_FILE = process.env.ADMIN_CONFIG_FILE ?? path.resolve(process.cwd(), "admin-config.json");
// What .env said before any override, so "reset" can go back to it.
const ENV_DEFAULTS = new Map(SETTINGS.map((s) => [s.key, process.env[s.key]]));
let overrides: Record<string, string> = {};

const configured = (key: string) => (key in overrides ? overrides[key] : ENV_DEFAULTS.get(key));

function apply(startup = false): void {
  for (const { key, restart } of SETTINGS) {
    if (restart && !startup) continue;
    const value = configured(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

try {
  const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (BY_KEY.has(key) && typeof value === "string") overrides[key] = value;
  }
  apply(true);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[admin] Ignoring unreadable ${CONFIG_FILE}:`, err);
}

/** Returns an error message, or undefined when the value is acceptable. */
export function validate(key: string, value: string): string | undefined {
  const setting = BY_KEY.get(key);
  if (!setting) return "unknown setting";
  if (value.length > 4000 || /[\p{Cc}]/u.test(value)) return "invalid characters or too long";
  if (setting.kind === "number" && !/^\d{1,6}$/.test(value)) return "must be a whole number";
  if (setting.kind === "bool" && value !== "0" && value !== "1") return "must be 0 or 1";
  if (key === "PORT" && value !== "" && (Number(value) < 1 || Number(value) > 65535)) return "must be a port (1-65535)";
  return undefined;
}

/** Applies and persists changes. `null` removes the override (back to .env). */
export async function updateSettings(changes: Record<string, string | null>): Promise<void> {
  const next = { ...overrides };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(tmp, CONFIG_FILE);
  overrides = next;
  apply();
}

/** Panel view: secrets only say whether they are set. */
export function describeSettings() {
  return SETTINGS.map((s) => {
    // Restart settings show what is saved, not what the process still runs with.
    const value = s.restart ? configured(s.key) : process.env[s.key];
    return {
      ...s,
      overridden: s.key in overrides,
      fromEnv: ENV_DEFAULTS.get(s.key) !== undefined,
      value: s.kind === "secret" ? undefined : (value ?? ""),
      isSet: Boolean(value),
      // With WEB_STATIC=0 the UI comes from elsewhere and never sees these.
      inactive: Boolean(s.staticOnly && process.env.WEB_STATIC === "0"),
      pendingRestart: Boolean(s.restart && (value ?? "") !== (process.env[s.key] ?? "")),
    };
  });
}
