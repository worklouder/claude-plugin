import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const directory = resolve(process.env.WORKLOUDER_STATE_DIR
  || join(homedir(), "Library", "Application Support", "Work Louder", "Claude Code"));
const runtimeFile = join(directory, "runtime.json");
const port = 40000 + createHash("sha256").update(directory).digest().readUInt16BE() % 9000;
const host = "127.0.0.1";
export const localOrigin = `http://${host}:${port}`;
const maxBody = 32768;

async function prepareDirectory() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error("Unsafe Work Louder data directory.");
  if ((stat.mode & 0o777) !== 0o700) await chmod(directory, 0o700);
}

export async function readPrivate(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > maxBody) {
      throw new Error("Unsafe Work Louder data file.");
    }
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writePrivate(path, value) {
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function readBody(stream) {
  const parts = [];
  let size = 0;
  for await (const part of stream) {
    size += part.length;
    if (size > maxBody) throw new Error("Work Louder message is too large.");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

function request(token, command, data, timeout) {
  return new Promise((resolveRequest, reject) => {
    const body = JSON.stringify({ command, data });
    const req = http.request({
      hostname: host, port, method: "POST", path: "/", agent: false,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body) },
    }, (response) => {
      readBody(response).then((value) => {
        if (response.statusCode === 200) resolveRequest(value);
        else reject(Object.assign(new Error(value.error || "Work Louder request failed."), { status: response.statusCode }));
      }, reject);
    });
    const timer = setTimeout(() => req.destroy(new Error("Work Louder helper did not respond in time.")), timeout);
    req.once("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(body);
  });
}

export async function callHelper(command, data, { startup = 1500, timeout = 800, start = true } = {}) {
  await prepareDirectory();
  const deadline = Date.now() + startup;
  let launched = false;
  do {
    const runtime = await readPrivate(runtimeFile);
    if (/^[a-f0-9]{64}$/.test(runtime?.token) && Number.isSafeInteger(runtime.pid) && runtime.pid > 1) {
      const health = await request(runtime.token, "ping", null, 180).catch(() => null);
      if (health?.pid === runtime.pid) {
        // A write may have taken effect even if its response is lost. Never repeat it.
        return request(runtime.token, command, data, timeout);
      }
    }
    if (!start) return null;
    if (!launched) {
      const child = spawn(process.execPath, [fileURLToPath(new URL("main.mjs", import.meta.url)), "serve"], {
        detached: true, stdio: "ignore", env: { ...process.env, NODE_OPTIONS: "" },
      });
      child.on("error", () => {});
      child.unref();
      launched = true;
    }
    await delay(40);
  } while (Date.now() < deadline);
  throw new Error("Could not start the local Work Louder helper.");
}

export async function listen(dispatch, handleWebRequest) {
  await prepareDirectory();
  const token = randomBytes(32).toString("hex");
  const server = http.createServer({ requestTimeout: 5000 }, async (req, res) => {
    if (req.headers.host !== `${host}:${port}`) {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(403).end(JSON.stringify({ error: "Forbidden." }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/") {
      try {
        if (handleWebRequest && await handleWebRequest(req, res, {
          origin: localOrigin,
          readJson: () => readBody(req),
        })) return;
        res.setHeader("Content-Type", "application/json");
        res.writeHead(404).end(JSON.stringify({ error: "Not found." }));
      } catch (error) {
        if (res.headersSent) res.end();
        else {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400).end(JSON.stringify({ error: error.message }));
        }
      }
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.headers.origin || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end(JSON.stringify({ error: "Forbidden." }));
      return;
    }
    try {
      const { command, data } = await readBody(req);
      const value = command === "ping" ? { pid: process.pid } : await dispatch(command, data);
      res.end(JSON.stringify(value));
    } catch (error) {
      res.writeHead(400).end(JSON.stringify({ error: error.message }));
    }
  });
  server.keepAliveTimeout = 1000;
  try {
    await new Promise((ready, reject) => server.once("error", reject).listen(port, host, ready));
    // Binding happens first. Only the winning process publishes its token.
    await writePrivate(runtimeFile, { pid: process.pid, token });
  } catch (error) {
    server.close();
    if (error.code === "EADDRINUSE") return null;
    throw error;
  }
  return server;
}
