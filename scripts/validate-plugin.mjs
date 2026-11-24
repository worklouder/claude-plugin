import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const pkg = await readJson("../package.json");
const lock = await readJson("../package-lock.json");
const plugin = await readJson("../.claude-plugin/plugin.json");
const market = await readJson("../.claude-plugin/marketplace.json");
const { hooks } = await readJson("../hooks/hooks.json");
const layer = await readJson("../resources/claude-layer.json");

assert.equal(pkg.version, plugin.version);
assert.equal(lock.version, pkg.version);
assert.equal(market.plugins.find(({ name }) => name === plugin.name)?.version, plugin.version);
assert.deepEqual(Object.keys(pkg.dependencies), ["@worklouder/input-kit"]);
// Marketplace installs run without npm, so the committed InputKit must match the lockfile and need nothing else.
const inputKit = await readJson("../node_modules/@worklouder/input-kit/package.json");
assert.equal(inputKit.version, lock.packages["node_modules/@worklouder/input-kit"].version);
assert.deepEqual(inputKit.dependencies ?? {}, {});
assert.ok(hooks.SessionStart && hooks.SessionEnd);
for (const configs of Object.values(hooks)) {
  for (const { hooks: commands } of configs) {
    for (const hook of commands) {
      assert.equal(hook.command, "${CLAUDE_PLUGIN_ROOT}/scripts/worklouder");
      assert.deepEqual(hook.args, ["hook"]);
    }
  }
}
const mappings = new Set(layer.smartActions.map(({ payload }) => payload.id));
for (let index = 1; index <= 6; index++) assert.ok(mappings.has(`claude.agent.${index}`));
for (const identifier of ["claude.session.next", "claude.session.previous", "claude.new"]) assert.ok(mappings.has(identifier));
assert.deepEqual(layer.layer.layout.encoders[0].map(({ keycode }) => keycode), ["KC_UP", "KC_DOWN", "KC_ENT"]);
assert.deepEqual(layer.layer.layout.joystick.sectors.map(({ k }) => k), ["KC_PGUP", "SA_14", "KC_PGDN", "SA_13"]);
assert.deepEqual(layer.layer.layout.base[2].map(({ keycode }) => keycode), ["KA_5", "KC_ENT", "KC_ESC", "KA_4"]);
assert.deepEqual(layer.layer.layout.base[3].map(({ keycode }) => keycode), ["KC_SPC", "KC_NONE", "SA_20"]);
assert.deepEqual(layer.layer.lights, { backlight: { effect: 0 }, underglow: { effect: 0 } });
for (const group of [...layer.actionGroups, ...layer.multiactionGroups, ...layer.smartActionGroups]) {
  assert.equal(group.color, "#D97757");
}
const review = layer.actions.find(({ id }) => id === 5);
assert.deepEqual(review?.keyInputs.map(({ keycode, actionType }) => [keycode, actionType]), [
  ["KC_SLSH", 2], ["KC_D", 2], ["KC_I", 2], ["KC_F", 2], ["KC_F", 2], ["KC_ENT", 2],
]);
await access(new URL("worklouder", import.meta.url), constants.X_OK);
await access(new URL("install-node", import.meta.url), constants.X_OK);
const runtime = Object.fromEntries((await readFile(new URL("node-runtime", import.meta.url), "utf8"))
  .split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split("=")));
assert.match(runtime.node_version, /^22\.\d+\.\d+$/);
assert.equal(runtime.node_dist, "https://nodejs.org/dist");
for (const arch of ["arm64", "x64"]) assert.match(runtime[`node_sha256_${arch}`], /^[a-f0-9]{64}$/);
await access(new URL("../skills/setup/SKILL.md", import.meta.url));
await access(new URL("../skills/status/SKILL.md", import.meta.url));
await access(new URL("../resources/setup/index.html", import.meta.url));
console.log("Plugin manifests, hook launcher, and device layer passed validation.");
