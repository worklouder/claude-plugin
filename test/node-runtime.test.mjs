import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../scripts/worklouder", import.meta.url));
const version = process.versions.node;
const arch = execFileSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).trim() === "1" ? "arm64" : "x64";
const exists = (path) => access(path).then(() => true, () => false);

async function waitFor(check, what) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await delay(100);
  }
  assert.fail(`Timed out waiting for ${what}`);
}

// A local stand-in for nodejs.org: a real .tar.xz whose bin/node runs the Node.js running this test.
async function fixture(t, { badHash = false } = {}) {
  const root = await mkdtemp("/private/tmp/worklouder-runtime-test-");
  const name = `node-v${version}-darwin-${arch}`;
  await mkdir(join(root, "package", name, "bin"), { recursive: true });
  await writeFile(join(root, "package", name, "bin", "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  await chmod(join(root, "package", name, "bin", "node"), 0o755);
  await writeFile(join(root, "package", name, "LICENSE"), "Node.js license\n");
  execFileSync("/usr/bin/tar", ["-cJf", join(root, "node.tar.xz"), "-C", join(root, "package"), name]);
  const archive = await readFile(join(root, "node.tar.xz"));
  const sha = badHash ? "0".repeat(64) : createHash("sha256").update(archive).digest("hex");

  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === `/v${version}/${name}.tar.xz`) res.end(archive);
    else res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await writeFile(join(root, "node-runtime"), [
    `node_version=${version}`,
    `node_dist=http://127.0.0.1:${server.address().port}`,
    `node_sha256_arm64=${sha}`,
    `node_sha256_x64=${sha}`,
  ].join("\n") + "\n");

  const bin = join(root, "bin");
  await mkdir(bin);
  const state = join(root, "state");
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, WORKLOUDER_STATE_DIR: state,
    WORKLOUDER_NODE_RUNTIME: join(root, "node-runtime"), WORKLOUDER_NO_OPEN: "1", WORKLOUDER_INPUT_PORT: "1",
  };
  t.after(async () => {
    server.close();
    // The downloader opens setup once Node.js is installed, which starts a helper for this state folder.
    const runtime = await readFile(join(state, "runtime.json"), "utf8").then(JSON.parse, () => null);
    if (runtime?.pid) try { process.kill(runtime.pid); } catch { /* already gone */ }
    await rm(root, { recursive: true, force: true });
  });
  const run = (args, input = "") => spawnSync(launcher, args, { env, input, encoding: "utf8", timeout: 10000 });
  return { bin, state, requests, run, installed: join(state, "runtime", `v${version}`) };
}

test("Node.js 22.4 or later on PATH runs the plugin without a download", async (t) => {
  const { bin, state, requests, run } = await fixture(t);
  await symlink(process.execPath, join(bin, "node"));
  const result = run(["help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: worklouder/);
  await delay(300);
  assert.deepEqual(requests, []);
  assert.equal(await exists(join(state, "runtime")), false);
});

test("an older Node.js on PATH falls back to a verified download that later runs use", async (t) => {
  const { bin, state, requests, run, installed } = await fixture(t);
  // src/main.mjs exits with 3 on Node.js older than 22.4.
  await writeFile(join(bin, "node"), "#!/bin/sh\nexit 3\n");
  await chmod(join(bin, "node"), 0o755);

  const hook = run(["hook"], JSON.stringify({ hook_event_name: "SessionStart", session_id: "abc" }));
  assert.equal(hook.status, 0, "a hook never fails while Node.js downloads");
  assert.equal(hook.stdout + hook.stderr, "");
  await waitFor(() => exists(join(installed, "bin", "node")), "the download to install");

  assert.equal(await readFile(join(installed, "LICENSE"), "utf8"), "Node.js license\n");
  const result = run(["help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: worklouder/);
  assert.deepEqual(requests, [`/v${version}/node-v${version}-darwin-${arch}.tar.xz`]);
  await waitFor(async () => !(await exists(join(state, "runtime", ".lock"))), "the download lock to clear");
  assert.deepEqual((await readdir(join(state, "runtime"))).sort(), [`v${version}`]);
});

test("a download that fails its hash check is never used and status explains why", async (t) => {
  const { state, run, installed } = await fixture(t, { badHash: true });
  const first = run(["status"]);
  assert.equal(first.status, 1);
  assert.match(first.stderr, /downloading Node\.js .* Try again in a minute/);
  await waitFor(() => exists(join(state, "runtime", ".failed")), "the failure to be recorded");
  await waitFor(async () => !(await exists(join(state, "runtime", ".lock"))), "the download lock to clear");

  assert.equal(await exists(installed), false);
  assert.deepEqual((await readdir(join(state, "runtime"))).filter((entry) => entry.startsWith(".download")), []);
  const again = run(["status"]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /did not match its expected SHA-256 hash.*install Node\.js 22\.4 or later/);
});
