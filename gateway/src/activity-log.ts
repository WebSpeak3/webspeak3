// --- Activity logging (feedback + connection events) -----------------------
//
// Narrow interface so the private VPS overlay can swap in SQLite persistence
// (see mem:reference_webspeak3_private_sqlite_persistence) without forking
// index.ts - only this module differs between public and private; index.ts's
// two call sites just call logFeedback/logConnectionEvent unconditionally.
// This file itself has zero private modifications, same as store.ts.
import { appendFile, rename, stat } from "node:fs/promises";
import path from "node:path";

// Plain JSON-lines file. Defaults under the container's WORKDIR (/app in
// the Docker image); mount a volume over it if you want submissions to
// survive a container recreate.
const FEEDBACK_LOG_FILE = process.env.FEEDBACK_LOG_FILE ?? path.resolve(process.cwd(), "feedback.log");
// Simple size-based rotation: once the log crosses this size, the current
// file is moved to feedback.log.1 (overwriting any previous one) and a
// fresh file is started. Keeps disk usage bounded on a plain JSON-lines
// file with no other retention policy.
const FEEDBACK_LOG_MAX_BYTES = 5 * 1024 * 1024;

async function rotateFeedbackLogIfNeeded(): Promise<void> {
  try {
    const { size } = await stat(FEEDBACK_LOG_FILE);
    if (size < FEEDBACK_LOG_MAX_BYTES) return;
    await rename(FEEDBACK_LOG_FILE, `${FEEDBACK_LOG_FILE}.1`);
  } catch (err) {
    // ENOENT just means there's no log yet - nothing to rotate.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[feedback] Failed to rotate feedback log:", err);
    }
  }
}

export interface FeedbackEntry {
  at: string;
  category: string;
  message: string;
  email?: string;
}

export async function logFeedback(entry: FeedbackEntry): Promise<void> {
  try {
    await rotateFeedbackLogIfNeeded();
    await appendFile(FEEDBACK_LOG_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.error("[feedback] Failed to write feedback log:", err);
  }
}

// Opt-in only, off by default: this is an open-source, self-hostable image,
// and other instances shouldn't get connection logging just because it's in
// the codebase. Set LOG_CONNECTIONS=1 in the .env of the instance you want it
// on. Logs only host/server-name/timestamp — no nickname, no IP.

export interface ConnectionEvent {
  type: "connected" | "disconnected";
  host: string;
  server?: string;
}

export function logConnectionEvent(event: ConnectionEvent): void {
  if (process.env.LOG_CONNECTIONS !== "1") return;
  if (event.type === "connected") {
    console.log(`[connections] connected host=${event.host} server=${event.server} at=${new Date().toISOString()}`);
  } else {
    console.log(`[connections] disconnected host=${event.host} at=${new Date().toISOString()}`);
  }
}
