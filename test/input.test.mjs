import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";

test("InputKit pairing, per-key lighting, layer confirmation and reconnection", async (t) => {
  const temporary = await mkdtemp("/private/tmp/worklouder-input-test-");
  process.env.WORKLOUDER_STATE_DIR = temporary;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  process.env.WORKLOUDER_INPUT_PORT = String(server.address().port);
  const { Device } = await import("../src/input.mjs");
  const calls = [];
  const buttons = [];
  let peer;
  const info = {
    deviceType: "codex_micro", devicePid: "8360", portPath: "mock", serialNumber: "micro-1",
    connectionType: 1, layoutType: "universal", isUsbConnection: true,
    deviceStatus: { selectedProfileIndex: 0, selectedLayerIndex: 1 },
  };
  const replies = {
    requestAuthorization: { applicationId: "test-app", token: "test-token" },
    authenticate: { authenticated: true },
    getDevices: [{ id: 1, deviceType: "codex_micro" }, { id: 2, deviceType: "other" }],
    getDeviceInfo: info,
    addLayer: { added: true },
    setKeyLighting: { applied: true },
  };
  server.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (data) => {
      const call = JSON.parse(data);
      calls.push(call);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: replies[call.method] }));
    });
  });
  const device = new Device({ onChange() {}, onKey(event) { buttons.push(event); } });
  t.after(async () => {
    await device.stop();
    await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });
  await device.load();
  device.connect();
  assert.equal(calls.length, 0);
  await device.pair();
  assert.equal(device.state, "connected");
  assert.equal(device.selected.id, 1);
  assert.equal(device.devices.length, 1);
  const settings = JSON.parse(await readFile(join(temporary, "settings.json"), "utf8"));
  assert.deepEqual(settings.credentials, replies.requestAuthorization);

  peer.send(JSON.stringify({ jsonrpc: "2.0", method: "keyTriggered",
    params: { deviceId: 1, identifier: "claude.agent.1", action: "click" } }));
  for (let index = 0; index < 10 && !buttons.length; index++) await delay(30);
  assert.equal(buttons[0]?.identifier, "claude.agent.1");
  const slots = [{ id: "session", state: "working" }, null, null, null, null, null];
  await device.render(slots, "session");
  await device.render(slots, "session");
  const lighting = calls.filter(({ method }) => method === "setKeyLighting");
  assert.equal(lighting.length, 6);
  assert.deepEqual(lighting[0].params, {
    deviceId: 1, identifier: "claude.agent.1", isRegex: false,
    color: 0x2864ff, brightness: 0.8, effect: 6, speed: 0.35,
  });
  assert.equal(lighting[5].params.brightness, 0);
  const target = device.layerTarget;
  const layer = JSON.parse(await readFile(new URL("../resources/claude-layer.json", import.meta.url), "utf8"));
  await assert.rejects(device.addLayer({ ...target, profileIndex: 1 }, layer), /profile changed/);
  assert.deepEqual(await device.addLayer(target, layer), { added: true });
  assert.equal(calls.filter(({ method }) => method === "addLayer").length, 1);
  peer.close();
  for (let index = 0; index < 40 && !calls.some(({ method }) => method === "authenticate"); index++) await delay(80);
  assert.equal(calls.filter(({ method }) => method === "requestAuthorization").length, 1);
  assert.equal(calls.filter(({ method }) => method === "authenticate").length, 1);
});
