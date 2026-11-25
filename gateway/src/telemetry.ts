// --- Anonymous usage ping ----------------------------------------------------
//
// Once at startup and then once a day, the gateway tells webspeak3.de that an
// instance is running. That's the only way to know whether anyone self-hosts
// at all, and which versions are still out there (e.g. before dropping
// support for something or after a security fix).
//
// Sent: a random instance id (generated here, used for nothing else) and the
// version. Not sent: hostnames, TeamSpeak servers, user counts, settings.
// The receiving side stores no IP addresses (see ping.ts).
//
// On by default, off with TELEMETRY=0. Said so in the startup log, too.
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const TELEMETRY_URL = process.env.TELEMETRY_URL || "https://gateway.webspeak3.de/api/ping";
const VERSION = process.env.WEBSPEAK3_VERSION || "unknown";
// ponytail: without a volume over the working directory a container recreate
// makes a new id, so an update counts twice for a day or so.
const ID_FILE = process.env.TELEMETRY_ID_FILE ?? path.resolve(process.cwd(), "instance-id");
const DAY_MS = 24 * 60 * 60 * 1000;

async function instanceId(): Promise<string> {
  try {
    const id = (await readFile(ID_FILE, "utf-8")).trim();
    if (/^[0-9a-f-]{36}$/.test(id)) return id;
  } catch {
    // first start - fall through
  }
  const id = randomUUID();
  await writeFile(ID_FILE, id + "\n").catch(() => {});
  return id;
}

let id: Promise<string> | undefined;

async function ping() {
  // Checked on every ping: the admin panel can switch it on/off live.
  if (process.env.TELEMETRY === "0") return;
  id ??= instanceId();
  try {
    await fetch(TELEMETRY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: await id, version: VERSION }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Offline or blocked - not worth a log line every day.
  }
}

if (process.env.TELEMETRY !== "0") {
  console.log(
    `Sending an anonymous usage ping (random instance id + version ${VERSION}) to ${new URL(TELEMETRY_URL).host} at startup and once a day. Disable with TELEMETRY=0.`
  );
}
void ping();
setInterval(() => void ping(), DAY_MS).unref();
