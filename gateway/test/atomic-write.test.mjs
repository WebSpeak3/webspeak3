// Concurrent saves to one file used to share a .tmp path: all but one rename
// failed with ENOENT (seen live from a parallel /api/ping probe).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../dist/net.js";

test("parallel writes to one file all succeed, last one wins", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ws3-atomic-"));
  try {
    const file = path.join(dir, "data.json");
    await Promise.all(Array.from({ length: 50 }, (_, i) => writeFileAtomic(file, JSON.stringify({ i, pad: "x".repeat(i * 500) }))));
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).i, 49);
    assert.deepEqual(readdirSync(dir), ["data.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
