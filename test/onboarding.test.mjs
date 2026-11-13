import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";

test("first-run setup is local, authenticated, once-only and confirms the layer target", async (t) => {
  const temporary = await mkdtemp("/private/tmp/worklouder-onboarding-test-");
  process.env.WORKLOUDER_STATE_DIR = temporary;
  const input = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(input, "listening");
  process.env.WORKLOUDER_INPUT_PORT = String(input.address().port);

  const calls = [];
  const info = {
    deviceType: "codex_micro",
    devicePid: "8360",
    portPath: "mock",
    serialNumber: "micro-setup",
    connectionType: 1,
    layoutType: "universal",
    isUsbConnection: true,
    deviceStatus: { selectedProfileIndex: 2, selectedLayerIndex: 1 },
  };
  const replies = {
    requestAuthorization: { applicationId: "setup-app", token: "setup-token" },
    getDevices: [{ id: 7, deviceType: "codex_micro" }],
    getDeviceInfo: info,
    addLayer: { added: true },
    setKeyLighting: { applied: true },
  };
  input.on("connection", (socket) => {
    socket.on("message", (data) => {
      const call = JSON.parse(data);
      calls.push(call);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: replies[call.method] }));
    });
  });

  const { callHelper } = await import(`../src/local.mjs?onboarding=${Date.now()}`);
  let helperPid;
  t.after(async () => {
    if (helperPid) {
      try { process.kill(helperPid, "SIGTERM"); } catch { /* Helper already stopped. */ }
      await delay(80);
    }
    await new Promise((resolve) => input.close(resolve));
    await rm(temporary, { recursive: true, force: true });
    delete process.env.WORKLOUDER_STATE_DIR;
    delete process.env.WORKLOUDER_INPUT_PORT;
  });

  const opened = await callHelper("setup-url", { automatic: true }, { startup: 3000, timeout: 1000 });
  const runtime = JSON.parse(await readFile(join(temporary, "runtime.json"), "utf8"));
  helperPid = runtime.pid;
  assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/setup\/#[a-f0-9]{64}$/);
  assert.deepEqual(await callHelper("setup-url", { automatic: true }), { url: null });

  const setupUrl = new URL(opened.url);
  const token = setupUrl.hash.slice(1);
  setupUrl.hash = "";
  const page = await fetch(setupUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Claude Code<br>on your Micro/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);

  const api = (route, options = {}) => fetch(new URL(`api/${route}`, setupUrl), {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  assert.equal((await fetch(new URL("api/status", setupUrl))).status, 401);
  assert.equal((await api("pair", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://example.com" },
    body: JSON.stringify({ automatic: true }),
  })).status, 403);

  let response = await api("status");
  let status = await response.json();
  assert.equal(status.canAutoPair, true);
  response = await api("pair", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: setupUrl.origin },
    body: JSON.stringify({ automatic: true }),
  });
  assert.equal(response.status, 200);
  status = await response.json();
  assert.equal(status.input, "connected");
  for (let index = 0; index < 20 && !status.layerTarget; index++) {
    await delay(50);
    status = await (await api("status")).json();
  }
  assert.ok(status.layerTarget, JSON.stringify({ status, methods: calls.map(({ method }) => method) }));
  assert.equal(status.layerTarget.profileIndex, 2);

  response = await api("add-layer", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: setupUrl.origin },
    body: JSON.stringify({ target: status.layerTarget }),
  });
  assert.equal(response.status, 200);
  status = await response.json();
  assert.equal(status.layerInstalled, true);
  assert.equal(calls.filter(({ method }) => method === "requestAuthorization").length, 1);
  assert.equal(calls.filter(({ method }) => method === "addLayer").length, 1);

  const settings = JSON.parse(await readFile(join(temporary, "settings.json"), "utf8"));
  assert.equal(settings.onboardingShown, true);
  assert.equal(settings.inputAuthorizationAttempted, true);
  assert.equal(settings.layerInstalled, true);
});
