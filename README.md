# Work Louder for Claude Code

Use a Codex Micro or Creator Micro V2 with Claude Code in Terminal, iTerm2 or Ghostty on macOS. The plugin uses InputKit to connect to the local WebSocket API in Work Louder Input. Input handles the hardware connection.

The plugin runs on Node.js, and you don't need to install it. If your `PATH` has Node.js 22.4 or later, the plugin uses it. Otherwise, the first time it runs, it downloads the official Node.js 22.23.4 for your Mac from nodejs.org (about 26 MB), checks it against the SHA-256 hash pinned in `scripts/node-runtime`, and keeps it for later sessions. Until the download finishes, the device lights stay off; setup opens on its own once it's done.

## Platform support

This plugin supports macOS only. Agent Keys depend on finding the exact tab or pane that runs each Claude Code session. On macOS, Terminal, iTerm2 and Ghostty expose each tab's TTY through AppleScript, so the plugin can match sessions exactly. Windows Terminal has no equivalent: nothing maps a running process to its tab or pane, so a Windows version couldn't reliably select the right session.

## Install and set up

1. Install Claude Code CLI and open a version of Work Louder Input that supports the WebSocket API. Connect your Micro in Input.
2. Add the marketplace and install the plugin:

   ```sh
   claude plugin marketplace add worklouder/claude-plugin
   claude plugin install worklouder@worklouder
   ```

3. Start Claude Code normally. On the first session, the local Work Louder setup page opens once and makes one authorization request. Approve **Work Louder for Claude Code** in Input. A denial, restart, or later revocation is never retried automatically.
4. In the setup page, select a device if more than one is connected and confirm adding the **Claude Code** layer to the profile named on the page. Input appends the layer without changing existing layers. A failed or uncertain write is never retried automatically.
5. Select **Claude Code** on the device. Future Claude sessions reconnect automatically without opening setup again.

Run `/worklouder:setup` inside Claude Code to reopen pairing and layer setup. Run `/worklouder:status` to see the connection, selected device, Agent Key slots, and recent control result. Users never need the plugin cache path or its internal launcher.

The first Agent Key switch in each terminal app may ask macOS for permission to control Terminal, iTerm2 or Ghostty. Allow it in **Privacy & Security → Automation**.

## Controls

| Control | Behavior |
| --- | --- |
| Agent Keys 1–6 | Activate the assigned running Claude Code session in Terminal, iTerm2 or Ghostty using its TTY. The first six observed sessions occupy the keys in arrival order. A closed session frees its slot. |
| Encoder rotate / press | Send Up or Down to move through questions, menus, and prompt history. Press to send Enter and accept the highlighted option. |
| Joystick left / right | Switch to the previous or next focusable Claude Code session. |
| Joystick up / down | Send Page Up or Page Down to scroll the conversation. |
| Lights | White idle, blue working, amber waiting, green completed, red turn failure. The last selected or prompted session pulses. Empty keys are off. |
| Review Changes | Type `/diff` and press Enter to open Claude Code's interactive changes viewer. |
| New Chat | Run `claude` from the selected session's project in the same terminal app. iTerm2 and Ghostty open a new tab in the selected session's window; Terminal opens a new window. The new shell must be able to find `claude`. |
| Approve / Send | Send a native Enter to the focused app. |
| Decline | Send a native Escape. In Claude Code this declines a permission prompt or interrupts the current turn, depending on the active screen. |
| Model picker | Send Option+P. Claude Code needs Option to act as Meta: enable **Use Option as Meta key** in the Terminal profile, set **Left Option key** to **Esc+** in the iTerm2 profile, or set `macos-option-as-alt = true` in Ghostty. |
| Microphone | Send Space to Claude Code voice dictation. Voice mode must be enabled first. |

Before using the Microphone key, run `/voice` once inside Claude Code and complete its microphone check. Claude Code remembers the setting for future sessions. The default `/voice hold` mode records while the key is held; `/voice tap` starts recording on the first press and stops on the second.

Permission lights are observational. Use Claude Code's confirmation dialog for approvals.

## Supported terminals and limitations

Agent Keys, joystick session switching and New Chat work in these apps when Claude Code runs directly in a tab, window or split pane:

| App | Requirement | Notes |
| --- | --- | --- |
| Terminal | Included with macOS | New Chat opens a new window, because Terminal's AppleScript has no command for a new tab. |
| iTerm2 | Verified with 3.7.7 | Tabs and split panes are matched exactly by TTY. |
| Ghostty | 1.4.0 or later | Ghostty added AppleScript in 1.3.0, but the plugin needs each terminal's TTY, which is verified in 1.4.0. Older versions report "Update Ghostty to use Agent Keys with it." AppleScript must stay enabled; `macos-applescript = false` turns it off. |

Limitations:

- **Other terminals show lights only.** Sessions in VS Code, Cursor, Warp, WezTerm, Kitty, Alacritty and other apps light their Agent Key, but pressing it, switching with the joystick, or New Chat from them does nothing. `/worklouder:status` marks them "(lights only)".
- **Multiplexers show lights only.** Sessions inside tmux or GNU screen can't be matched to a tab, even when the multiplexer runs in a supported app.
- **The terminal is detected once, when the session starts,** from the `TERM_PROGRAM` variable. A session started through a wrapper that changes or removes it shows lights only.
- **Each app asks for Automation permission separately.** If you deny it, the key reports which app to allow in **Privacy & Security → Automation**.
- **Only the first six sessions get Agent Keys.** The joystick cycles through those six; later sessions take a key when an earlier one closes.
- **New Chat follows the selected session.** It opens in that session's app and project. In iTerm2 and Ghostty it opens a new window instead of a tab if the selected session's window has closed.
- **Remote sessions are not tracked.** Claude Code sessions running remotely don't report to the device.

## Examples

- **Run several sessions at once.** Start Claude Code in a few Terminal, iTerm2 or Ghostty tabs. Each session lights its own Agent Key: blue while it works, amber when it waits for you, green when it's done. Press a key to jump to that session's tab, or push the joystick left or right to step through them.
- **Answer a prompt without the mouse.** When a key turns amber, press it to bring that session forward, turn the encoder to pick an option, then press Approve to accept or Decline to refuse.
- **Review what changed.** When a key turns green, press it, then press Review Changes to open `/diff`. Press New Chat to start a fresh `claude` in the same project.

## Troubleshooting

Run `/worklouder:status` first. It shows the Input connection, the selected device, the Agent Key slots, the last control result and the Node.js in use.

- **The lights stay off and status says Input is disconnected.** Open Work Louder Input, make sure it's a version with the WebSocket API, and connect your Micro. The plugin reconnects on its own; run `/worklouder:status` again after a few seconds.
- **Status says Work Louder is downloading Node.js, or that it needs Node.js 22.4 or later.** The first run downloads Node.js from nodejs.org. Check that your Mac can reach nodejs.org, or install Node.js 22.4 or later yourself, then run `/worklouder:status` again.
- **"Input authorization was revoked", or you denied the request.** Run `/worklouder:setup` and approve **Work Louder for Claude Code** in Input.
- **The keys light up but pressing them does nothing.** Select the **Claude Code** layer on the device. If status says Input couldn't find the Agent Keys, run `/worklouder:setup` and add the layer.
- **A key reports that the helper needs permission to control an app.** Allow it in **System Settings → Privacy & Security → Automation**, then press the key again.
- **A session's key lights but can't be selected.** The session runs outside Terminal, iTerm2 and Ghostty, or inside tmux or screen. See [Supported terminals and limitations](#supported-terminals-and-limitations).
- **Model picker does nothing.** Set Option to act as Meta in your terminal, as described in [Controls](#controls).
- **"Could not start the local Work Louder helper."** Run the command again. If it keeps failing, report it at [feedback.worklouder.cc](https://feedback.worklouder.cc/) with the output of `/worklouder:status`.

## What the plugin runs, stores and sends

- **Hooks.** Claude Code runs `scripts/worklouder` on session, prompt, tool and permission events. The hooks forward only session identity, lifecycle, process and terminal information, and the working directory to the local helper. They never send prompts, responses or tool input and output.
- **Local helper.** The plugin starts one helper process when a session or setup command needs it. It connects to Input at `ws://127.0.0.1:19147/input`, reconnects with saved Input authorization, shares one device connection across sessions, and exits after about 90 seconds with no active sessions or setup activity.
- **Setup page.** The setup page is served only on loopback, uses an ephemeral bearer token removed from the address bar, rejects other browser origins, and requires a current device and profile confirmation before each layer write. On the first session it opens once in your browser.
- **Terminal control.** Agent Keys, joystick switching and New Chat use AppleScript to select a tab by its TTY or open a new one in Terminal, iTerm2 or Ghostty. macOS asks before each app is controlled the first time.
- **Network.** The plugin talks only to Input on your Mac. The one exception is the Node.js download from nodejs.org, which happens only when no Node.js 22.4 or later is on your `PATH`. When Claude Code installs the plugin, it may also install the pinned InputKit version from the npm registry because the plugin includes `package-lock.json`; the plugin already ships the same version.
- **Stored files.** Saved pairing and device selection use a private file in `~/Library/Application Support/Work Louder/Claude Code`. A downloaded Node.js is kept in its `runtime` folder. Uninstalling the plugin doesn't remove that folder; `/worklouder:status` shows which Node.js the plugin uses, and you can delete the folder after uninstalling.

## Develop

Run `npm ci --ignore-scripts`, `npm test`, and `npm run validate`. For development from source, use Node 22.4 or later on PATH or set `WORKLOUDER_NODE_PATH` to its executable.

To move to a newer Node.js, change `node_version` in `scripts/node-runtime` and replace both hashes with the `darwin-arm64.tar.xz` and `darwin-x64.tar.xz` entries from that release's `SHASUMS256.txt`. The next run downloads the new version and removes the old one.

InputKit has no runtime dependencies, and its installed copy in `node_modules/@worklouder/input-kit` is committed so the plugin works without `npm install`. After changing its version, run `npm install` and commit the updated folder; `npm run validate` checks that it matches the lockfile. `ws` is a development dependency for the tests only.

## Feedback and issues

Report problems and share ideas at [feedback.worklouder.cc](https://feedback.worklouder.cc/).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
