# macOS validation

## Passed

- Claude Code 2.1.311 validated both manifests with `--strict`. The package check also verified the launcher, setup and status skills, local setup assets, and device layer identifiers.
- All 11 automated tests passed. They cover InputKit pairing and reconnection with a simulated server, per-key lighting, lifecycle state, stale-session protection, terminal detection, per-terminal focus and New Chat scripts, terminal error messages, and the complete first-run browser flow.
- The onboarding test verifies the one-time setup claim, one automatic authorization attempt, bearer-token and browser-origin enforcement, current device/profile confirmation, and one confirmed layer write.
- Two actual Claude Code CLI processes loaded the plugin and answered a local model fixture. Each supplied a distinct TTY, caused its own Agent Key to turn blue on a simulated Input server, and released its slot on exit.
- A separate macOS Terminal probe switched between two exact TTYs in both directions and restored the starting selection.
- Every focus and New Chat AppleScript compiled against the installed apps. The plugin's focus code switched by TTY from Terminal to iTerm2 3.7.7, to Ghostty 1.4.0, and back to Terminal, and typed input reached the focused iTerm2 and Ghostty sessions. New Chat opened a tab running `claude` in the existing iTerm2 window and the existing Ghostty window.

## Hardware acceptance

Start a new Claude Code session with the real Input app running. Confirm that setup opens once, Input shows one authorization request, and `/worklouder:setup` reopens the page. Confirm the Claude Code layer on a target profile, then check the device's physical lighting and Agent Keys. Verify that the encoder sends Up, Down and Enter; the joystick switches sessions left and right; and joystick up and down send Page Up and Page Down. Repeat Agent Key and joystick switching with sessions in Terminal, iTerm2 and Ghostty open at once, including an iTerm2 split pane and a second Ghostty tab, and confirm New Chat opens in the selected session's app. Confirm Review Changes opens `/diff`, Approve sends Enter, the key beside Microphone opens New Chat, and Microphone sends Space after `/voice` is enabled. The simulated tests exercise these integration paths without changing the real device's profiles or pairing settings.
