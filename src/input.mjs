import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { InputClient } from "@worklouder/input-kit";
import { directory, readPrivate, writePrivate } from "./local.mjs";

const stateFile = join(directory, "settings.json");
const COLORS = { idle: 0xffffff, working: 0x2864ff, waiting: 0xffb020, complete: 0x26cc62, error: 0xff3030 };
const SUPPORTED = new Set(["codex_micro", "creator_micro_v2", "creator_micro_v2_base", "creator_micro_v2_pro"]);
const MISSING_KEYS = "Input could not find the Claude Code Agent Keys. Add the Claude Code layer in setup.";

export class Device {
  settings = {};
  devices = [];
  info = new Map();
  state = "unpaired";
  applied = new Map();
  revision = 0;
  refreshRevision = 0;
  instance = randomUUID();

  constructor({ onChange, onKey }) {
    this.onChange = onChange;
    this.onKey = onKey;
  }

  async load() {
    this.settings = (await readPrivate(stateFile)) || {};
    if (Object.keys(this.settings).length && this.settings.onboardingShown === undefined) {
      await this.save({ onboardingShown: true, inputAuthorizationAttempted: true });
    }
    if (this.settings.revoked) this.state = "revoked";
  }

  save(changes) {
    const write = (this.saving ?? Promise.resolve()).then(async () => {
      const next = { ...this.settings, ...changes };
      await writePrivate(stateFile, next);
      this.settings = next;
    });
    this.saving = write.catch(() => {});
    return write;
  }

  get selected() {
    const serial = this.settings.serial;
    if (serial) return this.devices.find(({ id }) => this.info.get(id)?.serialNumber === serial) ?? null;
    return this.devices.length === 1 ? this.devices[0] : null;
  }

  get publicDevices() {
    return this.devices.map(({ id, deviceType }) => ({
      id,
      deviceType,
      serialNumber: this.info.get(id)?.serialNumber ?? null,
    }));
  }

  get canAutoPair() {
    return !this.settings.credentials && !this.settings.revoked
      && this.settings.inputAuthorizationAttempted !== true;
  }

  claimOnboarding() {
    if (this.settings.onboardingShown || this.onboardingClaimed) return false;
    this.onboardingClaimed = true;
    return true;
  }

  async markOnboardingShown() {
    if (!this.settings.onboardingShown) await this.save({ onboardingShown: true });
  }

  get layerTarget() {
    const deviceId = this.selected?.id;
    const profileIndex = this.info.get(deviceId)?.deviceStatus?.selectedProfileIndex;
    if (this.state !== "connected" || !Number.isSafeInteger(profileIndex) || profileIndex < 0) return null;
    return { deviceId, profileIndex, revision: this.revision, instance: this.instance };
  }

  resetLighting() {
    this.applied.clear();
    this.revision++;
    this.onChange();
  }

  connect() {
    if (this.settings.credentials && this.state !== "connected" && !this.connecting && !this.stopped) {
      this.open(false).catch(() => {});
    }
  }

  async pair(automatic = false) {
    if (automatic && !this.canAutoPair) return;
    if (this.settings.inputAuthorizationAttempted !== true) {
      await this.save({ inputAuthorizationAttempted: true });
    }
    if (this.settings.credentials) {
      this.connect();
      if (this.connecting) await this.connecting;
    }
    if (this.state === "connected") return;
    await this.open(true);
  }

  open(pairing) {
    if (this.connecting) return this.connecting;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connecting = this.openSocket(pairing).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async openSocket(pairing) {
    const input = new InputClient({
      applicationName: "Work Louder for Claude Code",
      port: Number(process.env.WORKLOUDER_INPUT_PORT || 19147),
      requestTimeoutMs: 3000,
    });
    this.input = input;
    this.state = pairing ? "pairing" : "connecting";
    input.on("disconnected", () => {
      if (this.input === input && this.state === "connected") this.disconnected();
    });
    input.on("devicesUpdated", ({ devices }) => {
      if (this.input === input && this.state === "connected") {
        void this.replaceDevices(input, devices).catch((error) => { this.error = error.message; });
      }
    });
    input.on("deviceInfoChanged", ({ deviceId, deviceInfo }) => {
      if (this.input !== input || !this.devices.some(({ id }) => id === deviceId)) return;
      this.info.set(deviceId, deviceInfo);
      this.resetLighting();
    });
    input.on("keyTriggered", (event) => {
      if (this.input === input && this.state === "connected" && this.selected?.id === event.deviceId) this.onKey(event);
    });

    try {
      await input.connect();
      if (pairing) {
        const credentials = await input.requestAuthorization();
        await this.save({ credentials, revoked: false });
      } else {
        await input.authenticate(this.settings.credentials);
      }
      if (this.stopped || !input.connected) throw new Error("Input disconnected.");
      this.state = "connected";
      this.backoff = 0;
      this.error = null;
      const refreshRevision = this.refreshRevision;
      const devices = await input.getDevices();
      if (refreshRevision === this.refreshRevision) await this.replaceDevices(input, devices);
    } catch (error) {
      await input.close().catch(() => {});
      if (!pairing && error.code === -32001) {
        await this.save({ credentials: undefined, revoked: true });
        this.error = "Input authorization was revoked. Run /worklouder:setup to pair again.";
      } else {
        this.error = error.message;
      }
      this.disconnected();
      throw new Error(this.error, { cause: error });
    }
  }

  disconnected() {
    this.state = this.settings.credentials ? "disconnected" : (this.settings.revoked ? "revoked" : "unpaired");
    this.devices = [];
    this.info.clear();
    this.resetLighting();
    if (this.stopped || !this.settings.credentials || this.reconnectTimer) return;
    const delays = [1000, 2000, 5000, 10000, 30000];
    const step = Math.min(this.backoff ?? 0, delays.length - 1);
    this.backoff = step + 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delays[step]);
  }

  async replaceDevices(input, devices) {
    if (this.input !== input || this.state !== "connected") return;
    const refresh = ++this.refreshRevision;
    this.devices = devices.filter(({ deviceType }) => SUPPORTED.has(deviceType));
    const ready = new Set(this.devices.map(({ id }) => id));
    for (const id of this.info.keys()) if (!ready.has(id)) this.info.delete(id);
    this.resetLighting();
    for (const { id } of this.devices) {
      const previous = this.info.get(id);
      let info;
      try { info = await input.getDeviceInfo(id); }
      catch (error) {
        if (this.input === input && refresh === this.refreshRevision) this.error = error.message;
        continue;
      }
      if (this.input !== input || refresh !== this.refreshRevision || this.state !== "connected") return;
      if (this.info.get(id) === previous) this.info.set(id, info);
    }
    this.resetLighting();
  }

  async choose(id) {
    const serial = this.info.get(id)?.serialNumber;
    if (!serial || !this.devices.some((device) => device.id === id)) {
      throw new Error("Choose a ready Micro whose serial number is available.");
    }
    await this.save({ serial });
    this.resetLighting();
  }

  async addLayer(expected, definition) {
    const target = this.layerTarget;
    if (!target || target.instance !== expected?.instance || target.revision !== expected.revision || target.deviceId !== expected.deviceId
      || target.profileIndex !== expected.profileIndex) throw new Error("The device or profile changed. Run add-layer again.");
    if (this.writing) throw new Error("A layer installation is already in progress.");
    if (this.error === MISSING_KEYS) this.error = null;
    this.writing = true;
    try {
      const { deviceId, profileIndex } = target;
      const result = await this.input.addLayer({ deviceId, profileIndex, definition });
      if (result?.added === true) await this.save({ layerInstalled: true });
      return result;
    } finally {
      this.writing = false;
      this.resetLighting();
    }
  }

  async render(slots, selectedId) {
    const input = this.input;
    const deviceId = this.selected?.id;
    const revision = this.revision;
    if (this.state !== "connected" || !deviceId || this.writing) return;
    for (let index = 0; index < slots.length; index++) {
      if (this.revision !== revision || this.state !== "connected" || this.writing) return;
      const slot = slots[index];
      const color = COLORS[slot?.state] ?? 0;
      const brightness = slot ? 0.8 : 0;
      const effect = slot && slot.id === selectedId ? 6 : 1;
      const signature = `${color}:${brightness}:${effect}`;
      if (this.applied.get(index) === signature) continue;
      try {
        await input.setKeyLighting({
          deviceId, identifier: `claude.agent.${index + 1}`, isRegex: false, color, brightness, effect, speed: 0.35,
        });
        if (this.revision === revision) {
          this.applied.set(index, signature);
          if (this.error === MISSING_KEYS) this.error = null;
        }
      } catch (error) {
        if (this.revision === revision) this.error = error.code === -32009 ? MISSING_KEYS : error.message;
        if (error.code === -32009 && this.revision === revision) this.applied.set(index, signature);
        else return;
      }
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    await this.input?.close();
  }
}
