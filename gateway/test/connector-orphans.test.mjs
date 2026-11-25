// Connect/close races on one WebSocket must not leave connector processes
// behind. Uses a fake connector that records its PID and lives until its
// stdin closes (like the real one), against the built gateway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const INDEX = path.resolve(import.meta.dirname, "../dist/index.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const freePort = () => new Promise((ok) => {
  const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); });
});

test("no connector outlives its WebSocket", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ws3-orphans-"));
  const pids = path.join(dir, "pids");
  const fake = path.join(dir, "fake-connector.sh");
  writeFileSync(fake, `#!/bin/sh\necho $$ >> '${pids}'\ncat > /dev/null\nsleep 1\n`);
  chmodSync(fake, 0o755);
  const port = await freePort();
  const gw = spawn(process.execPath, [INDEX], {
    cwd: dir,
    env: { PATH: process.env.PATH, PORT: String(port), WEB_STATIC: "0", TELEMETRY: "0", CONNECTOR_BIN: fake },
    stdio: "ignore",
  });
  const recorded = () => (existsSync(pids) ? readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number) : []);
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/api/features`); break; } catch { await wait(100); } }
    const connect = JSON.stringify({ type: "connect", host: "example.invalid", nickname: "dummy" });
    const open = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
      return ws;
    };

    // connect, connect while the first connector shuts down, close
    let ws = await open();
    ws.send(connect); await wait(300);
    ws.send(connect); await wait(100);
    ws.close();
    // connect, then two connects back to back, close later
    ws = await open();
    ws.send(connect); await wait(300);
    ws.send(connect); ws.send(connect);
    await wait(4000);
    ws.close();

    await wait(4000);
    assert.ok(recorded().length >= 2, "fake connector was spawned");
    assert.deepEqual(recorded().filter(alive), [], "connector processes left behind");
  } finally {
    for (const pid of recorded()) if (alive(pid)) process.kill(pid, "SIGKILL");
    await new Promise((ok) => { gw.once("exit", ok); gw.kill("SIGTERM"); });
    rmSync(dir, { recursive: true, force: true });
  }
});
