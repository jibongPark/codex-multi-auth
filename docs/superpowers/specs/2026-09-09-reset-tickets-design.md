# Reset Tickets Design

## Goal

Let users inspect banked Codex rate-limit reset tickets for every managed
account and consume a ticket for one explicitly selected account, using the
same account pool that powers Codex CLI and desktop-app routing.

## Scope

The fork adds the short standalone `codex-reset` command. Its options and
results mirror the `codex-reset` tool contract in `oc-codex-multi-auth`, while
using this package's Codex CLI and desktop-app account storage:

```console
codex-reset
codex-reset account=2
codex-reset action=consume account=2 confirm=true
codex-reset action=consume account=2 creditId=RateLimitResetCredit_1 confirm=true
codex-reset action=consume account=2 dryRun=true format=json
```

- `action=status` is the default. It lists the target account's tickets and
  current usage in parallel. With no `account`, the active Codex account is
  the target; `account` is an optional 1-based account number.
- `action=consume` makes no write unless `confirm=true`; it is a preview when
  confirmation is absent. `dryRun=true` always remains a preview, even with
  `confirm=true`.
- `creditId` optionally selects one available ticket. Without it, consumption
  selects the available ticket with the earliest valid `expires_at`. Equal
  expiry times use the ticket id as a deterministic tie-breaker. Tickets with
  unreadable expiry sort after tickets with valid expiry but remain eligible
  when no valid expiry is available.
- `format=text|json` defaults to text. `includeSensitive=true` only changes
  account identity fields in JSON output; no output ever contains OAuth or
  refresh tokens.

## Architecture

Add a lower-layer `lib/codex-reset.ts` client for the two currently observed
ChatGPT backend endpoints: list tickets and consume one ticket. It uses the
existing `CODEX_BASE_URL`, `createCodexHeaders`, error sanitization, timeout
rules, and a deterministic per-ticket idempotency key. The request layer does
not log tokens or server bodies.

Add `lib/codex-manager/commands/reset.ts` as the CLI orchestration layer, then
expose it through a small `scripts/codex-reset.js` package-bin wrapper. The
wrapper accepts the OpenCode-style `key=value` arguments above and translates
them to the command parser without accepting unknown keys. The command resolves
and refreshes the selected stored account through the existing refresh queue,
persists a rotated refresh token through the account storage transaction, and
calls the lower-layer ticket client. It will not alter official Codex app
binaries or OpenCode configuration.

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
stable idempotency keys, active/default and explicit 1-based account
resolution, status's parallel ticket-and-usage reads, token refresh
persistence, preview/confirmed/dry-run consumption, successful consume with
usage reread failure, unknown consume outcome, text/JSON contracts,
OpenCode-style argument parsing in the package-bin wrapper, and
post-consumption local rate-limit/cache invalidation. The focused suite, full
test suite, typecheck, lint, and build must pass before the fork branch is
pushed.

## Non-goals

- Installing or configuring `oc-codex-multi-auth` / OpenCode.
- Modifying Codex desktop-app binaries, OpenCode files, or the user's existing
  global package during development.
- Automatically spending tickets, spending tickets across every account, or
  adding a graphical desktop-app control.
- Depending on or exposing undocumented credential values.
