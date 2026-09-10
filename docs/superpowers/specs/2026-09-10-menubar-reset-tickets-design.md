# Menu Bar Reset Tickets Design

## Goal

Extend the macOS menu-bar quota popover so a person can see the number of
available rate-limit reset tickets and the nearest expiration for each managed
account, then redeem one ticket for the account represented by the selected
button.

## Scope

- Reuse the package's stored account pool and masked account labels.
- Add a narrow CLI JSON contract that the menu-bar companion can invoke to
  fetch reset-ticket status for one account and redeem a selected ticket.
- Show a compact reset-ticket summary inside each existing account card. The
  primary quota display, fixed popover width, account order, and footer remain
  unchanged.
- Redeem the available, unexpired ticket with the nearest expiration for the
  specific account card. A native confirmation dialog must identify the masked
  account and chosen expiration before any irreversible request is made.
- On successful redemption, invalidate only the matching account's local
  quota/reset state and reload that row. Do not alter another account's state.

## Data Flow

The TypeScript account manager owns provider interaction and credentials. It
uses the existing account selection, queued OAuth refresh, Codex-header, and
redaction utilities to request reset-ticket data. The CLI serializes masked,
versioned JSON; the Swift companion continues to execute the CLI and never
reads tokens or account-storage files directly.

The companion loads cached quota data as it does today. Reset-ticket status is
loaded separately when the popover data is first requested and on explicit
manual refresh, never on the existing 60-second cached-quota poll. The UI
shows a small "initialization tickets N" summary and the earliest valid
expiration; unavailable or unknown status has a compact neutral state.

## Safety and Error Handling

- Provider routes are observed, undocumented ChatGPT backend routes. The
  feature must report sanitized failures and must not claim live-provider
  support unless it has been verified with a user-selected account.
- A consume request is preceded by native confirmation. A user can cancel with
  no provider or storage write.
- Ticket parsing rejects missing IDs and expired/malformed expiration values
  from the redeemable set. The selection is deterministic: earliest valid
  expiration, then ticket ID.
- Consume requests carry a stable per-ticket idempotency identifier. An
  uncertain request result is surfaced as uncertain and is not retried as a
  new redemption.
- Requests use bounded timeouts. Errors, logs, and JSON output do not include
  access tokens, refresh tokens, or unmasked emails.
- A post-redemption cache refresh failure preserves the last known display and
  does not reinterpret it as a failed redemption.

## Testing and Validation

- TypeScript tests cover ticket parsing, expiration validation and selection,
  request headers/body/error redaction/timeout, account targeting, refresh
  persistence, confirmation-only redemption, idempotency, and narrow local
  state invalidation.
- Swift tests cover the versioned reset-ticket JSON decode, compact display
  strings, command arguments, confirmation gating, and row reload behavior.
- Run focused TypeScript and Swift suites, then the repository type check,
  lint, build, and the complete Node test suite.

## Non-goals

- Changing the macOS menu-bar icon or general quota layout.
- Automatically redeeming tickets, redeeming tickets across every account, or
  querying reset-ticket data on the background 60-second quota poll.
- Changing official Codex application binaries or exposing credentials to the
  menu-bar process.
