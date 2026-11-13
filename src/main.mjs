import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { callHelper, listen, localOrigin } from "./local.mjs";
import { APPS, focusSession, hookEvent, newSession, readOwner, Sessions } from "./sessions.mjs";

const AGENT = /^claude\.agent\.([1-6])$/;
const SESSION = /^claude\.session\.(next|previous)$/;

async function openBrowser(url) {
  if (process.env.WORKLOUDER_NO_OPEN === "1") return;
  if (process.platform !== "darwin") throw new Error("Opening setup is currently supported on macOS.");
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_REPL_EXTERNAL_MODULE;
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", [url], {
      detached: true,
      stdio: "ignore",
      env: environment,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function openSetup(automatic) {
  const result = await callHelper("setup-url", { automatic }, { timeout: 1000 });
  if (!result?.url) return false;
  await openBrowser(result.url);
  return true;
}

async function hook() {
  try {
    if (process.env.CLAUDE_CODE_REMOTE === "true") return;
    const at = Date.now();
    const parts = [];
    let size = 0;
    for await (const part of process.stdin) {
      size += part.length;
      if (size > 4 * 1024 * 1024) return;
      parts.push(part);
    }
    const raw = JSON.parse(Buffer.concat(parts).toString("utf8"));
    const pid = Number(process.env.WORKLOUDER_OWNER_PID) || process.ppid;
    const owner = await readOwner(pid) ?? (raw.hook_event_name === "SessionEnd" && pid > 1 ? { pid } : null);
    const event = hookEvent(raw, owner, process.env, at);
    if (event) {
      await callHelper("event", event, { startup: 1100, timeout: 450, start: event.event !== "SessionEnd" });
      if (event.event === "SessionStart") await openSetup(true);
    }
  } catch { /* A device or helper failure must never interrupt Claude Code. */ }
}

async function serve() {
  const { Device } = await import("./input.mjs");
  const sessions = new Sessions();
  const down = new Set();
  const releases = new Map();
  const actions = [];
  let activeAction = false;
  let rendering = false;
  let dirty = false;
  let closed = false;
  let lastActivity = Date.now();
  let lastAction = null;
  const setupTokens = new Map();
  const [setupHtml, setupScript, setupStyle, layer, plugin] = await Promise.all([
    readFile(new URL("../resources/setup/index.html", import.meta.url)),
    readFile(new URL("../resources/setup/app.js", import.meta.url)),
    readFile(new URL("../resources/setup/style.css", import.meta.url)),
    readFile(new URL("../resources/claude-layer.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  function refresh() {
    dirty = true;
    if (rendering || closed) return;
    rendering = true;
    void (async () => {
      while (dirty && !closed) {
        dirty = false;
        await device.render(sessions.slots(), sessions.selectedId);
      }
    })().finally(() => { rendering = false; });
  }

  async function runActions() {
    if (activeAction) return;
    activeAction = true;
    try {
      while (actions.length && !closed) {
        const identifier = actions.shift();
        const slots = sessions.slots();
        const index = AGENT.exec(identifier);
        let session = index && slots[Number(index[1]) - 1];
        if (SESSION.test(identifier)) {
          const active = slots.filter((slot) => slot?.terminal);
          const current = active.findIndex(({ id }) => id === sessions.selectedId);
          const step = identifier.endsWith(".next") ? 1 : -1;
          const offset = current < 0 && step < 0 ? 0 : current;
          session = active[(offset + step + active.length) % active.length];
        }
        try {
          if (identifier === "claude.new") {
            await newSession(sessions.items.get(sessions.selectedId) ?? slots[0]);
            lastAction = "Opened a new Claude Code session.";
          } else {
            if (!session) throw new Error("No focusable Claude Code session is available.");
            await focusSession(session);
            sessions.selectedId = session.id;
            lastAction = `Selected ${session.owner.tty} in ${APPS[session.terminal]}.`;
            refresh();
          }
        } catch (error) {
          lastAction = error.message;
        }
      }
    } finally {
      activeAction = false;
    }
  }

  const device = new Device({
    onChange: () => { down.clear(); releases.clear(); refresh(); },
    onKey: ({ identifier, action }) => {
      if (!AGENT.test(identifier) && !SESSION.test(identifier) && identifier !== "claude.new") return;
      if (action === "press") { down.add(identifier); return; }
      if (action === "release") {
        if (!down.delete(identifier)) return;
        releases.set(identifier, Date.now());
      } else if (action !== "click" || down.has(identifier)
        || Date.now() - (releases.get(identifier) ?? 0) < 80) return;
      lastActivity = Date.now();
      if (actions.length < 8) actions.push(identifier);
      void runActions();
    },
  });
  await device.load();

  const status = () => ({
    input: device.state,
    devices: device.publicDevices,
    selectedDevice: device.selected?.id ?? null,
    layerTarget: device.layerTarget,
    canAutoPair: device.canAutoPair,
    layerInstalled: device.settings.layerInstalled === true,
    pluginVersion: plugin.version,
    node: { version: process.version, path: process.execPath },
    error: device.error ?? null,
    lastAction,
    slots: sessions.status(),
  });
  const json = (res, code, value) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const setupHeaders = (res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  };
  const setupAssets = new Map([
    ["/setup/", ["text/html; charset=utf-8", setupHtml]],
    ["/setup/app.js", ["text/javascript; charset=utf-8", setupScript]],
    ["/setup/style.css", ["text/css; charset=utf-8", setupStyle]],
  ]);
  const authenticatedSetup = (req) => {
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
    return setupTokens.has(authorization.slice(7));
  };
  const handleSetupRequest = async (req, res, { origin, readJson }) => {
    const url = new URL(req.url, origin);
    if (!url.pathname.startsWith("/setup")) return false;
    setupHeaders(res);
    if (req.headers.origin && req.headers.origin !== origin) {
      json(res, 403, { error: "Local requests only." });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/setup") {
      res.writeHead(308, { Location: "/setup/" }).end();
      return true;
    }
    const asset = setupAssets.get(url.pathname);
    if (req.method === "GET" && asset) {
      res.writeHead(200, { "Content-Type": asset[0] });
      res.end(asset[1]);
      return true;
    }
    if (!url.pathname.startsWith("/setup/api/") || !authenticatedSetup(req)) {
      json(res, 401, { error: "Reopen setup from Claude Code." });
      return true;
    }
    lastActivity = Date.now();
    if (req.method === "GET" && url.pathname === "/setup/api/status") {
      await device.markOnboardingShown();
      json(res, 200, status());
      return true;
    }
    if (req.method !== "POST" || !req.headers["content-type"]?.startsWith("application/json")) {
      json(res, 415, { error: "JSON required." });
      return true;
    }
    const data = await readJson();
    if (url.pathname === "/setup/api/pair") await device.pair(data?.automatic === true);
    else if (url.pathname === "/setup/api/device") await device.choose(data?.id);
    else if (url.pathname === "/setup/api/add-layer") {
      const result = await device.addLayer(data?.target, layer);
      if (result?.added !== true) throw new Error("Input did not confirm the layer change. Check Input before trying again.");
    } else {
      json(res, 404, { error: "Unknown setup request." });
      return true;
    }
    json(res, 200, status());
    return true;
  };
  const server = await listen(async (command, data) => {
    if (closed) throw new Error("The Work Louder helper is shutting down.");
    lastActivity = Date.now();
    switch (command) {
      case "event":
        if (sessions.receive(data)) refresh();
        return {};
      case "status": return status();
      case "device": await device.choose(data?.id); return status();
      case "add-layer": {
        return device.addLayer(data, layer);
      }
      case "setup-url": {
        if (data?.automatic && !device.claimOnboarding()) return { url: null };
        const token = randomBytes(32).toString("hex");
        setupTokens.set(token, Date.now());
        while (setupTokens.size > 8) setupTokens.delete(setupTokens.keys().next().value);
        return { url: `${localOrigin}/setup/#${token}` };
      }
      default: throw new Error("Unknown Work Louder command.");
    }
  }, handleSetupRequest);
  if (!server) return;

  async function stop() {
    if (closed) return;
    closed = true;
    clearInterval(maintenance);
    server.close();
    await device.stop().catch(() => {});
  }

  const maintenance = setInterval(() => {
    if (sessions.prune()) refresh();
    if (!sessions.items.size && !device.writing && !device.connecting && !rendering
      && Date.now() - lastActivity > 90000) void stop();
  }, 5000);
  process.on("SIGTERM", () => { void stop(); });
  process.on("SIGINT", () => { void stop(); });
  device.connect();
}

function printStatus(status) {
  console.log(`Input: ${status.input}`);
  for (const { id, deviceType } of status.devices) {
    console.log(`  ${id}  ${deviceType}${id === status.selectedDevice ? " (selected)" : ""}`);
  }
  if (status.slots.some(Boolean)) {
    console.log("Agent Keys");
    status.slots.forEach((slot, index) => {
      if (slot) console.log(`  ${index + 1}  ${slot.name}  ${slot.state}  ${slot.tty}${slot.terminal ? "" : " (lights only)"}`);
    });
  }
  if (status.lastAction) console.log(status.lastAction);
  if (status.error) console.log(status.error);
  console.log(`Claude Code layer: ${status.layerInstalled ? "added" : "not confirmed"}`);
  console.log(`Node.js: ${status.node.version} at ${status.node.path}`);
}

async function command(name, argument) {
  switch (name) {
    case "setup":
      await openSetup(false);
      console.log("Work Louder setup opened in your browser.");
      break;
    // scripts/install-node runs this once Node.js is installed, for a first session that started without it.
    case "onboard": await openSetup(true); break;
    case "status": printStatus(await callHelper("status")); break;
    case "device": {
      const id = Number(argument);
      if (!Number.isSafeInteger(id) || id < 1) throw new Error("Supply the device number shown by status.");
      printStatus(await callHelper("device", { id }));
      break;
    }
    case "add-layer": {
      const { layerTarget: target } = await callHelper("status");
      if (!target) throw new Error("Pair with Input and select a ready Micro with an active profile first.");
      if (!process.stdin.isTTY) throw new Error("Run add-layer in Terminal to confirm the profile change.");
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await prompt.question(`Add the Claude Code layer to device ${target.deviceId}, profile ${target.profileIndex + 1}? [y/N] `);
        if (!/^y(?:es)?$/i.test(answer.trim())) return;
      } finally {
        prompt.close();
      }
      const result = await callHelper("add-layer", target, { timeout: 130000 });
      if (!result.added) throw new Error("Input did not confirm the layer change. Check Input before retrying.");
      console.log("Layer added. Select Claude Code on the device to use it.");
      break;
    }
    default:
      console.log("Usage: worklouder setup | status | device <id> | add-layer");
  }
}

// InputKit needs the stable global WebSocket from Node 22.4. Exit code 3 tells scripts/worklouder to
// try its downloaded Node.js; it must come before a hook reads its input.
const [major, minor] = process.versions.node.split(".").map(Number);
const supported = major > 22 || (major === 22 && minor >= 4);

try {
  const [mode, argument] = process.argv.slice(2);
  if (!supported) process.exitCode = 3;
  else if (mode === "hook") await hook();
  else if (mode === "serve") await serve();
  else await command(mode, argument);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
