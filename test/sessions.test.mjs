import assert from "node:assert/strict";
import { test } from "node:test";
import { focusSession, hookEvent, newSession, Sessions } from "../src/sessions.mjs";

const owner = { pid: 100, tty: "ttys007", started: "Tue Nov 10 12:00:00 2026" };
const env = { TERM_PROGRAM: "Apple_Terminal" };
const event = (name, id = "session-1", processOwner = owner, at = 100) => hookEvent(
  { session_id: id, hook_event_name: name, cwd: "/private/tmp/project", prompt: "secret", tool_input: { content: "private" } },
  processOwner, env, at,
);

test("Claude hooks preserve session identity and strip prompt and tool data", () => {
  const submitted = event("UserPromptSubmit");
  assert.deepEqual(Object.keys(submitted), ["id", "event", "at", "owner", "cwd", "terminal"]);
  assert.equal(submitted.terminal, "terminal");
  const raw = { session_id: "session-1", hook_event_name: "SessionStart" };
  assert.equal(hookEvent(raw, owner, { ...env, TMUX: "active" }).terminal, null);
  assert.equal(hookEvent(raw, owner, { ...env, CLAUDE_CODE_REMOTE: "true" }), null);
  assert.equal(hookEvent({ ...raw, agent_id: "subagent" }, owner, env), null);
});

test("Agent Key slots remain stable across state changes and release on session end", () => {
  const sessions = new Sessions();
  const other = { ...owner, pid: 101, tty: "ttys008" };
  sessions.receive(event("SessionStart"));
  sessions.receive(event("SessionStart", "session-2", other));
  sessions.receive(event("UserPromptSubmit", "session-2", other, 200));
  sessions.receive(event("PermissionRequest", "session-2", other, 300));
  assert.deepEqual(sessions.slots().slice(0, 2).map(({ state }) => state), ["idle", "waiting"]);
  assert.equal(sessions.receive(event("Stop", "session-2", other, 250)), false);
  sessions.receive(event("StopFailure", "session-2", other, 400));
  assert.equal(sessions.slots()[1].state, "error");
  assert.equal(sessions.receive(event("SessionEnd", "session-2", owner, 450)), false);
  assert.equal(sessions.receive(event("SessionEnd", "session-2", { pid: other.pid }, 500)), true);
  assert.equal(sessions.slots()[1], null);
  assert.equal(sessions.receive(event("PostToolUse", "session-2", other, 501)), false);
  assert.equal(sessions.receive(event("SessionStart", "session-2", other, 600)), true);
});

test("navigation passes the exact verified TTY to AppleScript and refuses a reused PID", async () => {
  const update = event("SessionStart");
  let execution;
  await focusSession(update, async () => owner, async (...args) => { execution = args; });
  assert.equal(execution[0], "/usr/bin/osascript");
  assert.equal(execution[1].at(-1), "/dev/ttys007");
  execution = null;
  await assert.rejects(focusSession(update, async () => ({ ...owner, started: "later" }), () => { execution = true; }), /closed/);
  assert.equal(execution, null);
});

test("sessions record which supported terminal they run in", () => {
  const raw = { session_id: "session-1", hook_event_name: "SessionStart" };
  const terminal = (environment) => hookEvent(raw, owner, environment).terminal;
  assert.equal(terminal({ TERM_PROGRAM: "iTerm.app" }), "iterm2");
  assert.equal(terminal({ TERM_PROGRAM: "ghostty" }), "ghostty");
  assert.equal(terminal({ TERM_PROGRAM: "ghostty", STY: "screen" }), null);
  assert.equal(terminal({ TERM_PROGRAM: "vscode" }), null);
  assert.equal(terminal({}), null);
});

test("navigation and new sessions run the script for the session's terminal", async () => {
  const calls = [];
  const execute = async (...args) => { calls.push(args); };
  for (const terminal of ["terminal", "iterm2", "ghostty"]) {
    const session = { owner, terminal, cwd: "/private/tmp/project" };
    await focusSession(session, async () => owner, execute);
    await newSession(session, async () => owner, execute);
  }
  const scripts = calls.map(([, args]) => args[1]);
  assert.equal(new Set(scripts).size, 6);
  assert.match(scripts[2], /application id "com\.googlecode\.iterm2"/);
  assert.match(scripts[3], /application id "com\.googlecode\.iterm2"/);
  assert.match(scripts[3], /create tab with default profile/);
  assert.match(scripts[4], /application "Ghostty"/);
  assert.match(scripts[5], /new tab in targetWindow/);
  assert.deepEqual(calls[3][1].slice(2), ["/dev/ttys007", "/private/tmp/project"]);
  await assert.rejects(focusSession({ owner, terminal: null }, async () => owner, execute), /outside Terminal, iTerm2 and Ghostty/);
  await assert.rejects(newSession({ owner, terminal: null, cwd: "/" }, async () => owner, execute), /Select an active/);
  assert.equal(calls.length, 6);
});

test("terminal script failures name the app that needs attention", async () => {
  const fail = (stderr) => async () => { throw Object.assign(new Error("osascript failed"), { stderr }); };
  const session = (terminal) => ({ owner, terminal, cwd: "/private/tmp/project" });
  await assert.rejects(focusSession(session("iterm2"), async () => owner, fail("execution error: (-1743)")),
    /control iTerm2 in macOS Privacy/);
  await assert.rejects(focusSession(session("ghostty"), async () => owner, fail("syntax error (-2741)")), /Update Ghostty/);
  await assert.rejects(newSession(session("ghostty"), async () => owner, fail("boom")),
    (error) => error.message === "Could not open a new Claude Code session in Ghostty." && error.cause.stderr === "boom");
});
