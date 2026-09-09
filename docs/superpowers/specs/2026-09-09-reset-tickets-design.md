# Reset Tickets Design

## Goal

Let users inspect banked Codex rate-limit reset tickets for every managed
account and consume a ticket for one explicitly selected account, using the
same account pool that powers Codex CLI and desktop-app routing.

## Scope

The fork adds the short standalone `codex-reset` command. It is backed by the
same manager dispatcher as `codex-multi-auth reset`, so both surfaces have
identical behavior while daily use stays concise:

```console
codex-reset
codex-reset <account>
codex-reset <account> use --confirm
codex-reset <account> use --confirm --ticket <ticket-id>
```

- `codex-reset` lists every stored account, including disabled accounts, and its
  current ticket availability.
- `codex-reset <account>` lists tickets only for that one account.
- `<account>` is a required 1-based storage index for `use`, matching the
  existing `rotation reset-rate-limits --account <idx>` convention.
- `use` performs no write without the exact `--confirm` flag. When no
  `--ticket` is supplied it automatically selects the server-reported
  available ticket with the earliest valid `expires_at`. Equal expiry times
  use the ticket id as a deterministic tie-breaker. Tickets with no readable
  expiry sort after every ticket with a valid expiry, but remain eligible if
  they are the only available tickets. `--ticket` must name a currently
  available ticket for that account and explicitly overrides auto-selection.
- `--json` is available for both read and consume paths. It never contains
  OAuth tokens, refresh tokens, or raw email addresses.

## Architecture

Add a lower-layer `lib/codex-reset.ts` client for the two currently observed
ChatGPT backend endpoints: list tickets and consume one ticket. It uses the
existing `CODEX_BASE_URL`, `createCodexHeaders`, error sanitization, timeout
rules, and a deterministic per-ticket idempotency key. The request layer does
not log tokens or server bodies.

Add `lib/codex-manager/commands/reset.ts` as the only CLI orchestration layer,
then expose it through a small `scripts/codex-reset.js` package-bin wrapper.
The command resolves and refreshes the selected stored account through the
existing refresh queue, persists a rotated refresh token through the account
storage transaction, and calls the lower-layer ticket client. It will not
alter the official Codex app binaries or OpenCode configuration.

On a confirmed successful consume, the command clears only the target
account's active `rateLimitResetTimes`, `coolingDownUntil`, and
`cooldownReason` when that reason is `rate-limit`, then persists through the
existing storage transaction. It invalidates the target's cached quota entry
instead of claiming an unverified post-consumption quota. Existing runtime
live-sync can reload the changed account pool; command output will tell the
user to restart the app if a running runtime proxy retains an in-memory timer.

## Error and Safety Contract

- Empty account storage, malformed account indexes, missing account identity,
  token refresh failure, unknown options, and backend failures return a
  nonzero exit code with a sanitized message.
- Listing and selection never consume a ticket.
- Consumption only follows `use --confirm`; it cannot be triggered by a
  default command or by a dry listing.
- A lost consume response is reported as an uncertain outcome and must not be
  blindly retried with a new idempotency key.
- Account labels follow existing redaction conventions in JSON output.
- The backend endpoints are undocumented and may change; this fork documents
  that limitation without presenting the feature as an official API.

## Verification

Vitest coverage will exercise payload normalization, expiry-first automatic
ticket selection (including same-expiry and missing-expiry fallbacks),
unavailable-ticket and unknown-ticket rejection, safe error-body redaction,
stable idempotency keys, account index parsing, token refresh persistence,
list-all/list-one JSON contracts, explicit-confirm consumption, package-bin
routing, and post-consumption local rate-limit/cache invalidation. The focused
suite, full test suite, typecheck, lint, and build must pass before the fork
branch is pushed.

## Non-goals

- Installing or configuring `oc-codex-multi-auth` / OpenCode.
- Modifying Codex desktop-app binaries, OpenCode files, or the user's existing
  global package during development.
- Automatically spending tickets, spending tickets across every account, or
  adding a graphical desktop-app control.
- Depending on or exposing undocumented credential values.
