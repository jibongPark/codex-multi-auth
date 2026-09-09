# Reset Tickets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `codex-reset` with OC-compatible reset-ticket actions and earliest-expiry automatic selection.

**Architecture:** `lib/codex-reset.ts` owns endpoint data and selection. `lib/codex-manager/commands/reset.ts` owns account selection, refresh, preview/consume, and local cache invalidation. `scripts/codex-reset.js` exposes OpenCode-style `key=value` inputs.

**Tech Stack:** TypeScript, Node.js 18.17+, fetch, Vitest, ESLint.

**Spec:** `docs/superpowers/specs/2026-09-09-reset-tickets-design.md`

## Global Constraints

- Use existing headers, refresh queue, storage transaction, quota cache, and redaction helpers; do not edit `dist/` or Codex app binaries.
- Accept only `action`, `creditId`, `confirm`, `dryRun`, `account`, `format`, and `includeSensitive` inputs.
- Default to `action=status` and the active account; explicit accounts are 1-based.
- `confirm=true` is required to consume; `dryRun=true` never consumes.
- Auto-select by valid `expires_at` ascending, then id; entries with unreadable expiry are last.
- Never output OAuth tokens or refresh tokens.

---

### Task 1: Implement the reset API client

**Files:**
- Create: `lib/codex-reset.ts`
- Create: `test/codex-reset.test.ts`

**Interfaces:**
- Produces: `parseCodexResetCredits`, `selectRedeemableCredit`, `fetchCodexResetCredits`, `consumeCodexResetCredit`, `createRedeemRequestId`.
- Consumes: `CODEX_BASE_URL` and `createCodexHeaders`.

- [ ] **Step 1: Write failing expiry-selection tests**

```ts
it("selects the available credit with the earliest valid expiry", () => {
  const summary = parseCodexResetCredits({ credits: [
    { id: "later", status: "available", expires_at: "2026-10-10T00:00:00Z" },
    { id: "earlier", status: "available", expires_at: "2026-09-10T00:00:00Z" },
  ] });
  expect(selectRedeemableCredit(summary)).toMatchObject({ type: "selected", credit: { id: "earlier" } });
});
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run test/codex-reset.test.ts`

Expected: FAIL because the reset client is missing.

- [ ] **Step 3: Implement the client**

```ts
const available = summary.credits.filter((credit) => credit.isAvailable);
const sorted = available.toSorted(compareCreditsByExpiryThenId);
return sorted[0] ? { type: "selected", credit: sorted[0] } : { type: "none-available" };
```

Implement GET `/wham/rate-limit-reset-credits`, POST `/wham/rate-limit-reset-credits/consume`, stable per-credit idempotency, timeout cleanup, and sanitized response errors.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run test/codex-reset.test.ts`

Expected: PASS for explicit IDs, unavailable IDs, equal/missing expiry, endpoints, headers, idempotency, and token-redacted errors.

- [ ] **Step 5: Commit**

```bash
git add lib/codex-reset.ts test/codex-reset.test.ts
git commit -m "feat(reset): 만료 임박 티켓 선택 추가"
```

### Task 2: Implement OC-compatible reset command

**Files:**
- Create: `lib/codex-manager/commands/reset.ts`
- Create: `test/codex-manager-reset-command.test.ts`
- Modify: `lib/codex-manager.ts`

**Interfaces:**
- Produces: `runResetCommand(args, deps): Promise<number>` and the manager `reset` registry entry.
- Consumes: Task 1, `queuedRefresh`, `withAccountStorageTransaction`, quota cache helpers, and active-index resolution.

- [ ] **Step 1: Write failing action tests**

```ts
it("uses the active account and reads credits and usage for status", async () => {
  await runResetCommand([], deps);
  expect(deps.fetchCredits).toHaveBeenCalledWith(expect.objectContaining({ accountId: "active" }));
  expect(deps.fetchUsage).toHaveBeenCalledWith(expect.objectContaining({ accountId: "active" }));
});

it("does not POST for unconfirmed consume", async () => {
  await runResetCommand(["action=consume", "account=2"], deps);
  expect(deps.consumeCredit).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run test/codex-manager-reset-command.test.ts`

Expected: FAIL because the command is missing.

- [ ] **Step 3: Implement action lifecycle**

```ts
type ResetOptions = { action: "status" | "consume"; account?: number; creditId?: string; confirm: boolean; dryRun: boolean; format: "text" | "json"; includeSensitive: boolean };
```

Reject unknown keys. Resolve active or 1-based account, refresh and persist stale credentials, call credits and usage with `Promise.all` for status, and return preview without POST for unconfirmed/dry-run consume. After successful POST, retain `redeemed: true` if usage reread fails; return `redeemed: null` when POST outcome is uncertain. Clear only the selected account's active rate-limit state and invalidate its quota cache transactionally.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run test/codex-manager-reset-command.test.ts`

Expected: PASS for status, explicit account, preview, dry run, confirmed consume, usage reread failure, unknown outcome, JSON redaction, and storage updates.

- [ ] **Step 5: Commit**

```bash
git add lib/codex-manager/commands/reset.ts test/codex-manager-reset-command.test.ts lib/codex-manager.ts
git commit -m "feat(reset): OC 호환 초기화권 동작 추가"
```

### Task 3: Publish the standalone executable and documentation

**Files:**
- Create: `scripts/codex-reset.js`
- Modify: `package.json`, `lib/codex-manager/help.ts`, `docs/reference/commands.md`, `docs/features.md`, `CHANGELOG.md`
- Modify: `test/package-bin.test.ts`, `test/documentation.test.ts`

**Interfaces:**
- Produces: a `codex-reset` package bin that delegates to `runCodexMultiAuthCli(["reset", ...args])`.

- [ ] **Step 1: Write failing bin and docs tests**

```ts
expect(packageJson.bin["codex-reset"]).toBe("scripts/codex-reset.js");
expect(commandReference).toContain("codex-reset action=consume account=2 confirm=true");
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run test/package-bin.test.ts test/documentation.test.ts`

Expected: FAIL because no bin or documentation exists.

- [ ] **Step 3: Implement the wrapper and references**

```js
const { runCodexMultiAuthCli } = await import("../dist/lib/codex-manager.js");
process.exitCode = await runCodexMultiAuthCli(["reset", ...process.argv.slice(2)]);
```

Register the bin and document every supported key, OC-compatible preview semantics, earliest-expiry selection, and the undocumented backend limitation.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run test/package-bin.test.ts test/documentation.test.ts`

Expected: PASS with executable and documentation contracts.

- [ ] **Step 5: Commit**

```bash
git add scripts/codex-reset.js package.json lib/codex-manager/help.ts docs/reference/commands.md docs/features.md CHANGELOG.md test/package-bin.test.ts test/documentation.test.ts
git commit -m "feat(reset): codex-reset 실행 명령 제공"
```

### Task 4: Validate and publish the branch

**Files:**
- Modify: no additional files.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: a clean verified fork branch.

- [ ] **Step 1: Run focused reset tests**

Run: `npx vitest run test/codex-reset.test.ts test/codex-manager-reset-command.test.ts test/package-bin.test.ts test/documentation.test.ts`

Expected: PASS.

- [ ] **Step 2: Run full validation**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

Expected: every command exits 0.

- [ ] **Step 3: Inspect and push**

Run: `git diff --check origin/main...HEAD && git diff --stat origin/main...HEAD && git status --short --branch && git push`

Expected: no whitespace errors, only reset-ticket changes, and a clean branch after push.
