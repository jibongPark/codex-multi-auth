# macOS Menu Bar Quota Dashboard Design

## Goal

Ship an optional macOS menu bar companion that makes the configured active
Codex account and every saved account's current quota windows visible without
opening the CLI dashboard or exposing OAuth credentials.

## Scope

- macOS 13+ only.
- Show the configured current account first, followed by every other account.
- For each account, show its masked label, enabled state, and the primary and
  secondary quota windows returned by `codex-multi-auth limits --json`.
- Render each available window as remaining percentage, a progress bar, and a
  countdown to its `resetAtMs` when supplied.
- Provide manual refresh, open-Codex-Multi-Auth, and quit actions.
- Launch automatically at macOS login after the user installs the companion.

The companion deliberately does not show local token-ledger usage, edit
accounts, switch accounts, or make background quota network requests.

## Architecture

The npm package owns a small, native SwiftUI/AppKit companion app under
`apps/macos-menubar`. The app is an `LSUIElement` status-bar application: it
does not appear in the Dock, holds a `NSStatusItem`, and presents a SwiftUI
popover when the user clicks its icon.

The companion treats the installed `codex-multi-auth` executable as its sole
data source. It launches `codex-multi-auth limits --json` when opening the
popover and during its 60-second local refresh interval. The CLI reads the
local quota cache only. A user-initiated refresh launches
`codex-multi-auth limits --json --refresh`; the existing CLI refresh policy
remains the only code allowed to contact the quota provider. No companion code
reads `auth.json`, account-storage JSON, cache files, or process environment
for credential data.

The app decodes only the documented schema-version-1 limits contract:
`generatedAt`, `selection`, and account rows with `label`, `enabled`,
`current`, and optional `quota.primary` / `quota.secondary` windows. It must
reject unsupported schema versions, malformed JSON, failed subprocesses, and
timeout responses without replacing the last valid snapshot.

## User Interface

The status item displays a monochrome gauge icon. Its accessibility label is
`Codex Multi Auth quota dashboard`.

The popover contains:

1. A header showing `현재 활성 계정` and the single row whose `current` value is
   true. If no accounts are configured, it says `연결된 계정이 없습니다`.
2. An `계정별 할당량` list. The active row is visually accented; disabled rows
   are dimmed and explicitly marked `비활성`.
3. Each quota row labels primary and secondary windows from `windowMinutes`
   (`5시간`, `7일`, or a generic minute/hour/day label), shows `N% 남음`, fills a
   progress indicator to the remaining percentage, and shows `HH:MM 후 재설정`
   when `resetAtMs` is valid. Missing quota is `할당량 정보 없음`; a missing reset
   timestamp hides only the countdown.
4. A footer with `새로고침`, `Codex Multi Auth 열기`, and `종료`.

The icon and popover never include raw emails, access tokens, refresh tokens,
account IDs, headers, command stderr, or unmasked JSON. The already masked
`label` is rendered as returned by the CLI.

## Data and Refresh Flow

```text
status-item click / 60-second timer
        -> codex-multi-auth limits --json
        -> validated snapshot
        -> SwiftUI view model
        -> menu-bar popover

explicit 새로고침
        -> codex-multi-auth limits --json --refresh
        -> existing age-gated sequential quota refresh
        -> validated snapshot -> popover
```

The app serializes refresh commands: at most one command runs at a time. A
cached refresh has a 10-second timeout and a manual network refresh has a
30-second timeout. The UI disables `새로고침` while a command runs, shows an
inline progress label, and retains its last successful snapshot if a command
fails. With no prior snapshot, it shows a short Korean error message and a
retry button. It calculates countdowns locally from `resetAtMs` and refreshes
the displayed duration once per minute while the popover is visible.

## Installation and Lifecycle

`codex-multi-auth menubar install` builds or installs the bundled signed
macOS `.app` into `~/Applications/Codex Multi Auth Quota.app`, enables the
app's LaunchAgent login item, and opens it. The command is idempotent and
reports whether it installed, updated, or found an existing current version.

`codex-multi-auth menubar uninstall` stops the app, removes only the
companion's LaunchAgent and `.app`, and leaves Codex, the multi-auth package,
all account storage, and quota cache untouched. Both commands fail with a
clear message on non-macOS hosts. Installation never patches the official
Codex app or its binaries.

## Test Strategy

- TypeScript CLI-command tests cover macOS platform gating, idempotent install
  planning, generated LaunchAgent/app paths, and scoped uninstall targets.
- Swift package unit tests cover limits JSON decoding, schema rejection,
  remaining-percent conversion, window labels, active-account ordering,
  stale-snapshot retention, error states, and refresh-command serialization.
- A macOS UI smoke test verifies that the app launches as an agent, exposes the
  accessibility label, renders the active-account section, and does not show
  token-like fixture values.
- Existing `limits` contract tests remain unchanged; the companion consumes
  that stable contract rather than changing its schema.

## Non-Goals and Constraints

- Do not add Electron, Tauri, a browser runtime, or a Node GUI dependency.
- Do not send analytics or quota data off-device.
- Do not issue automatic provider refreshes in the background.
- Do not claim that `current` predicts every live routed request: it remains
  the configured routing target defined by the limits contract.
- Keep all user-visible Korean copy local to the companion; CLI output remains
  backward-compatible.
