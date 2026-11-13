import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const TTY = /^ttys[0-9]+$/;
const STATES = new Map([
  ["SessionStart", "idle"],
  ["UserPromptSubmit", "working"],
  ["PermissionRequest", "waiting"],
  ["PreToolUse", "waiting"],
  ["PostToolUse", "working"],
  ["PostToolUseFailure", "working"],
  ["Elicitation", "waiting"],
  ["ElicitationResult", "working"],
  ["Stop", "complete"],
  ["StopFailure", "error"],
  ["SessionEnd", "closed"],
]);
const TERMINALS = new Map([
  ["Apple_Terminal", "terminal"],
  ["iTerm.app", "iterm2"],
  ["ghostty", "ghostty"],
]);
export const APPS = { terminal: "Terminal", iterm2: "iTerm2", ghostty: "Ghostty" };

export async function readOwner(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  try {
    const { stdout } = await run("/bin/ps", ["-p", String(pid), "-o", "tty=,lstart="], {
      env: { ...process.env, LC_ALL: "C" },
      timeout: 400,
    });
    const [tty, ...started] = stdout.trim().split(/\s+/);
    if (TTY.test(tty) && started.length === 5) return { pid, tty, started: started.join(" ") };
  } catch { /* The session may have exited before the hook ran. */ }
  return null;
}

export function hookEvent(raw, owner, env = process.env, at = Date.now()) {
  if (!owner || env.CLAUDE_CODE_REMOTE === "true" || raw?.agent_id) return null;
  const { session_id: id, hook_event_name: event } = raw ?? {};
  if (typeof id !== "string" || !/^[\w-]{1,128}$/.test(id) || !STATES.has(event)) return null;
  if (event === "PreToolUse" && raw.tool_name !== "AskUserQuestion") return null;
  const cwd = typeof raw.cwd === "string" && raw.cwd.startsWith("/") ? raw.cwd : null;
  return {
    id, event, at, owner, cwd,
    terminal: env.TMUX || env.STY ? null : TERMINALS.get(env.TERM_PROGRAM) ?? null,
  };
}

function sameOwner(a, b) {
  return a?.pid === b.pid && a.tty === b.tty && a.started === b.started;
}

export class Sessions {
  items = new Map();
  ended = new Map();
  selectedId = null;

  receive(update) {
    const state = STATES.get(update?.event);
    if (!state || typeof update.id !== "string" || !/^[\w-]{1,128}$/.test(update.id)
      || !Number.isSafeInteger(update.owner?.pid) || update.owner.pid < 2 || !Number.isFinite(update.at)) return false;
    const current = this.items.get(update.id);
    if (current && current.at > update.at) return false;
    if (state === "closed") {
      if (current?.owner.pid !== update.owner.pid || (update.owner.tty && !sameOwner(current.owner, update.owner))) return false;
      this.ended.set(update.id, update.at);
      if (this.ended.size > 64) this.ended.delete(this.ended.keys().next().value);
      return this.remove(update.id);
    }
    if (!TTY.test(update.owner.tty) || typeof update.owner.started !== "string") return false;
    if (this.ended.has(update.id)) {
      if (update.event !== "SessionStart" || this.ended.get(update.id) > update.at) return false;
      this.ended.delete(update.id);
    }
    if (current && !sameOwner(current.owner, update.owner) && update.event !== "SessionStart") return false;
    for (const session of this.items.values()) {
      if (session.id !== update.id && sameOwner(session.owner, update.owner)) {
        if (update.event !== "SessionStart" || session.at > update.at) return false;
        this.remove(session.id);
      }
    }
    if (!current && this.items.size >= 64) return false;
    this.items.set(update.id, { ...update, state });
    if (update.event === "UserPromptSubmit") this.selectedId = update.id;
    return true;
  }

  remove(id) {
    if (this.selectedId === id) this.selectedId = null;
    return this.items.delete(id);
  }

  prune() {
    let changed = false;
    for (const { id, owner } of this.items.values()) {
      try { process.kill(owner.pid, 0); }
      catch (error) { if (error.code === "ESRCH") changed = this.remove(id) || changed; }
    }
    return changed;
  }

  slots() {
    const active = [...this.items.values()].slice(0, 6);
    return Array.from({ length: 6 }, (_, index) => active[index] ?? null);
  }

  status() {
    return this.slots().map((session) => session && ({
      name: `${basename(session.cwd || "/Session")} · ${session.id.slice(0, 8)}`,
      state: session.state,
      tty: session.owner.tty,
      terminal: session.terminal,
    }));
  }
}

const SELECT_TAB = `
on run argv
  set wantedTTY to item 1 of argv
  if application "Terminal" is not running then error "Terminal is not running."
  tell application "Terminal"
    repeat with candidate in (every window)
      set targetID to id of candidate
      set targetWindow to window id targetID
      repeat with candidateTab in (every tab of targetWindow)
        if tty of candidateTab is wantedTTY then
          set targetTab to first tab of targetWindow whose tty is wantedTTY
          set selected of targetTab to true
          activate
          if miniaturized of targetWindow then set miniaturized of targetWindow to false
          set frontmost of targetWindow to true
          repeat 10 times
            if (id of front window is targetID) and (tty of selected tab of front window is wantedTTY) then return
            delay 0.1
          end repeat
          error "Terminal did not activate the session."
        end if
      end repeat
    end repeat
    error "The session is no longer in Terminal."
  end tell
end run`;

// iTerm2 and Ghostty expose each session's TTY, so they are matched as exactly as Terminal tabs.
const SELECT_ITERM = `
on run argv
  set wantedTTY to item 1 of argv
  if application id "com.googlecode.iterm2" is not running then error "iTerm2 is not running."
  tell application id "com.googlecode.iterm2"
    repeat with candidateWindow in windows
      repeat with candidateTab in tabs of candidateWindow
        repeat with candidateSession in sessions of candidateTab
          if tty of candidateSession is wantedTTY then
            select candidateWindow
            select candidateTab
            select candidateSession
            activate
            return
          end if
        end repeat
      end repeat
    end repeat
    error "The session is no longer in iTerm2."
  end tell
end run`;

const SELECT_GHOSTTY = `
on run argv
  set wantedTTY to item 1 of argv
  if application "Ghostty" is not running then error "Ghostty is not running."
  tell application "Ghostty"
    set matches to every terminal whose tty is wantedTTY
    if (count of matches) is 0 then error "The session is no longer in Ghostty."
    focus (item 1 of matches)
    activate
  end tell
end run`;

function scriptFailure(error, terminal, action) {
  const app = APPS[terminal];
  if (error.stderr?.includes("(-1743)")) {
    return new Error(`Allow the helper to control ${app} in macOS Privacy & Security → Automation.`);
  }
  // Ghostty releases without the AppleScript terminal dictionary reject its terms.
  if (terminal === "ghostty" && /\((-1708|-2741|-2753)\)/.test(error.stderr ?? "")) {
    return new Error("Update Ghostty to use Agent Keys with it.");
  }
  return new Error(`Could not ${action} in ${app}.`, { cause: error });
}

const FOCUS = { terminal: SELECT_TAB, iterm2: SELECT_ITERM, ghostty: SELECT_GHOSTTY };

export async function focusSession(session, ownerLookup = readOwner, execute = run) {
  if (!FOCUS[session?.terminal]) {
    throw new Error("This session is outside Terminal, iTerm2 and Ghostty, or uses a terminal multiplexer.");
  }
  if (!sameOwner(await ownerLookup(session.owner.pid), session.owner)) {
    throw new Error("That Claude Code session has closed.");
  }
  try {
    await execute("/usr/bin/osascript", ["-e", FOCUS[session.terminal], `/dev/${session.owner.tty}`], { timeout: 5000 });
  } catch (error) {
    throw scriptFailure(error, session.terminal, "activate the Claude Code session");
  }
}

// Terminal has no AppleScript command for a new tab, so it opens a window.
const NEW_TERMINAL = `
on run argv
  set projectPath to quoted form of item 2 of argv
  tell application "Terminal"
    do script "cd " & projectPath & " && claude"
    activate
  end tell
end run`;

const NEW_ITERM = `
on run argv
  set wantedTTY to item 1 of argv
  set startCommand to "cd " & (quoted form of item 2 of argv) & " && claude"
  if application id "com.googlecode.iterm2" is not running then error "iTerm2 is not running."
  tell application id "com.googlecode.iterm2"
    set targetID to missing value
    repeat with candidateWindow in windows
      repeat with candidateTab in tabs of candidateWindow
        repeat with candidateSession in sessions of candidateTab
          if tty of candidateSession is wantedTTY then set targetID to id of candidateWindow
        end repeat
      end repeat
    end repeat
    if targetID is missing value then
      set newSession to current session of (create window with default profile)
    else
      tell window id targetID to set newSession to current session of (create tab with default profile)
    end if
    tell newSession to write text startCommand
    activate
  end tell
end run`;

const NEW_GHOSTTY = `
on run argv
  set wantedTTY to item 1 of argv
  if application "Ghostty" is not running then error "Ghostty is not running."
  tell application "Ghostty"
    set surfaceConfig to new surface configuration
    set initial working directory of surfaceConfig to item 2 of argv
    set initial input of surfaceConfig to "claude" & linefeed
    set targetWindow to missing value
    repeat with candidateWindow in windows
      if (count of (every terminal of candidateWindow whose tty is wantedTTY)) > 0 then set targetWindow to contents of candidateWindow
    end repeat
    if targetWindow is missing value then
      new window with configuration surfaceConfig
    else
      new tab in targetWindow with configuration surfaceConfig
    end if
    activate
  end tell
end run`;

const NEW = { terminal: NEW_TERMINAL, iterm2: NEW_ITERM, ghostty: NEW_GHOSTTY };

export async function newSession(session, ownerLookup = readOwner, execute = run) {
  if (!NEW[session?.terminal] || !session.cwd || !sameOwner(await ownerLookup(session.owner.pid), session.owner)) {
    throw new Error("Select an active Claude Code session in Terminal, iTerm2 or Ghostty first.");
  }
  try {
    await execute("/usr/bin/osascript", ["-e", NEW[session.terminal], `/dev/${session.owner.tty}`, session.cwd], { timeout: 5000 });
  } catch (error) {
    throw scriptFailure(error, session.terminal, "open a new Claude Code session");
  }
}
