"use strict";

const $ = (id) => document.getElementById(id);
let token = location.hash.slice(1);
if (token) {
  sessionStorage.setItem("worklouder-setup-token", token);
  history.replaceState(null, "", "/setup/");
} else {
  token = sessionStorage.getItem("worklouder-setup-token");
}

let state;
let busy = false;
let automaticPairStarted = false;
const labels = {
  connected: "Connected",
  connecting: "Connecting…",
  pairing: "Waiting for approval…",
  unpaired: "Needs pairing",
  disconnected: "Disconnected",
  revoked: "Permission revoked",
};

function say(message, error = false) {
  $(error ? "error" : "message").textContent = message || "";
  $(error ? "error" : "message").hidden = !message;
  if (message) $(error ? "message" : "error").hidden = true;
}

async function api(route, body) {
  const response = await fetch(`api/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token || ""}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Setup request failed.");
  return result;
}

function deviceLabel(device) {
  const names = {
    codex_micro: "Codex Micro",
    creator_micro_v2: "Creator Micro V2",
    creator_micro_v2_base: "Creator Micro V2",
    creator_micro_v2_pro: "Creator Micro V2 Pro",
  };
  return device.serialNumber ? `${names[device.deviceType] || "Work Louder device"} · ${device.serialNumber}`
    : names[device.deviceType] || `Device ${device.id}`;
}

function render(next) {
  state = next;
  $("version").textContent = next.pluginVersion ? `v${next.pluginVersion}` : "";
  $("connection").textContent = labels[next.input] || next.input;
  $("connection").dataset.state = next.input;
  $("pair").textContent = next.input === "connected" ? "Input connected" : "Pair with Input";
  $("pair").disabled = busy || next.input === "pairing" || next.input === "connecting" || next.input === "connected";
  $("error").textContent = next.error || "";
  $("error").hidden = !next.error;

  const current = $("device").value;
  $("device").replaceChildren(...next.devices.map((device) => {
    const option = document.createElement("option");
    option.value = device.id;
    option.textContent = deviceLabel(device);
    option.selected = Number(current || next.selectedDevice) === device.id;
    return option;
  }));
  $("device-row").hidden = next.devices.length < 2;
  $("choose-device").disabled = busy;

  const target = next.layerTarget;
  if (target) {
    const selected = next.devices.find((device) => device.id === target.deviceId);
    $("layer-detail").textContent = `Add the Claude Code layer to profile ${target.profileIndex + 1} on ${selected ? deviceLabel(selected) : `device ${target.deviceId}`}.`;
  } else if (next.input === "connected") {
    $("layer-detail").textContent = "Connect a supported Work Louder device in Input and select the profile you want to use.";
  } else {
    $("layer-detail").textContent = "Connect Input to see the active device profile.";
  }
  $("add-layer").disabled = busy || !target;
  $("add-layer").textContent = next.layerInstalled ? "Confirm and add Claude Code layer again" : "Confirm and add Claude Code layer";
  $("layer-state").textContent = next.layerInstalled ? "Added" : target ? "Ready" : "Waiting";
  $("layer-state").className = `badge ${next.layerInstalled ? "complete" : "muted"}`;
  $("ready-state").textContent = next.layerInstalled ? "Ready" : "After setup";
  $("ready-state").className = `badge ${next.layerInstalled ? "complete" : "muted"}`;
}

async function refresh() {
  const next = await api("status");
  render(next);
  if (!automaticPairStarted && next.canAutoPair) {
    automaticPairStarted = true;
    await pair(true);
  }
}

async function action(callback) {
  if (busy) return;
  busy = true;
  if (state) render(state);
  try {
    await callback();
    await refresh();
  } catch (error) {
    say(error.message, true);
  } finally {
    busy = false;
    if (state) render(state);
  }
}

async function pair(automatic = false) {
  say("Approve Work Louder for Claude Code in Input.");
  const next = await api("pair", { automatic });
  render(next);
  say("Input is connected.");
}

$("pair").onclick = () => action(() => pair(false));
$("choose-device").onclick = () => action(async () => {
  const next = await api("device", { id: Number($("device").value) });
  render(next);
  say("Device selected.");
});
$("add-layer").onclick = () => action(async () => {
  const target = state?.layerTarget;
  if (!target) throw new Error("Input has not reported a ready device profile yet.");
  say("Adding the Claude Code layer. Keep Input open.");
  const next = await api("add-layer", { target });
  render(next);
  say("Claude Code layer added. Select it on your device to start using it.");
});

refresh().catch((error) => say(error.message, true));
setInterval(() => {
  if (!busy) refresh().catch((error) => say(`${error.message} Run /worklouder:setup in Claude Code to reopen setup.`, true));
}, 2000);
