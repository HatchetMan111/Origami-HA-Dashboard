import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not answer on ${url}`);
}

test("server answers health and serves the wizard", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "origami-smoke-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      HA_CONFIG: path.join(dataDir, "ha-config"),
      PORT: String(port),
      HOST: "127.0.0.1",
      DISABLE_AUTH: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(() => {
    child.kill("SIGTERM");
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const health = await waitFor(`${base}/api/health`);
  const payload = await health.json();
  assert.equal(payload.ok, true);
  assert.ok(payload.version);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Origami/);

  const state = await fetch(`${base}/api/session`);
  assert.equal(state.status, 200);

  const missing = await fetch(`${base}/api/nope`);
  assert.equal(missing.status, 404);
});
