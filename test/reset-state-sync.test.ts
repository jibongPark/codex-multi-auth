import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

let directory: string;
let previousRoot: string | undefined;
beforeEach(async () => {
 previousRoot = process.env.CODEX_MULTI_AUTH_DIR;
 directory = await fs.mkdtemp(join(tmpdir(), "reset-state-sync-"));
 process.env.CODEX_MULTI_AUTH_DIR = directory;
 vi.resetModules();
});
afterEach(async () => {
 if (previousRoot === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
 else process.env.CODEX_MULTI_AUTH_DIR = previousRoot;
 await removeWithRetry(directory, { recursive: true, force: true });
});

async function setup() {
 const { setStoragePath, saveAccounts, loadAccounts } = await import("../lib/storage.js");
 setStoragePath(join(directory, "accounts.json"));
 const account = { recordId: "fixture-reset-record", accountId: "fixture-workspace", email: "reader@example.test", refreshToken: "fixture-reset-token", addedAt: 1, lastUsed: 1, cooldownReason: "rate-limit" as const, coolingDownUntil: Date.now() + 60_000, rateLimitResetTimes: { codex: Date.now() + 60_000 } };
 await saveAccounts({ version: 3, activeIndex: 0, accounts: [account, { recordId: "fixture-other-record", accountId: "fixture-other", refreshToken: "fixture-other-token", addedAt: 2, lastUsed: 2, rateLimitResetTimes: { codex: 1234 } }] });
 const { saveQuotaCache, loadQuotaCache } = await import("../lib/quota-cache.js");
 await saveQuotaCache({ byAccountId: { "fixture-workspace": { updatedAt: 1, status: 429, model: "fixture", primary: { usedPercent: 100 }, secondary: {} }, "fixture-other": { updatedAt: 1, status: 200, model: "fixture", primary: { usedPercent: 35 }, secondary: {} } }, byEmail: {} });
 const { resetTargetForStoredAccount } = await import("../lib/runtime/account-reset-credits.js");
 const target = resetTargetForStoredAccount(account);
 if (!target) throw new Error("Missing fixture target");
 const { syncConfirmedResetState } = await import("../lib/codex-manager/reset-state-sync.js");
 const snapshot = { updatedAt: Date.now(), availableCount: 1, ordinaryUsageAllowed: true, planType: "pro", primary: { usedPercent: 0 }, secondary: { usedPercent: 0 } };
 return { loadAccounts, loadQuotaCache, target, syncConfirmedResetState, snapshot };
}

it("persists post-reset quota and clears only the recovered account's rate-limit cooldown", async () => {
 const s = await setup();
 await s.syncConfirmedResetState(s.target, s.snapshot);
 const pool = await s.loadAccounts();
 expect(pool?.accounts[0]?.rateLimitResetTimes).toBeUndefined();
 expect(pool?.accounts[0]?.cooldownReason).toBeUndefined();
 expect(pool?.accounts[1]?.rateLimitResetTimes).toEqual({ codex: 1234 });
 const cache = await s.loadQuotaCache();
 expect(cache.byAccountId["fixture-workspace"]?.primary.usedPercent).toBe(0);
 expect(cache.byAccountId["fixture-other"]?.primary.usedPercent).toBe(35);
});
it("retains local throttles when the backend still reports usage blocked", async () => {
 const s = await setup();
 await s.syncConfirmedResetState(s.target, { ...s.snapshot, ordinaryUsageAllowed: false, primary: { usedPercent: 100 } });
 expect((await s.loadAccounts())?.accounts[0]?.cooldownReason).toBe("rate-limit");
 expect((await s.loadQuotaCache()).byAccountId["fixture-workspace"]?.primary.usedPercent).toBe(100);
});
it("does not clear local throttles without confirmed post-reset usage", async () => {
 const s = await setup();
 await expect(s.syncConfirmedResetState(s.target, undefined)).rejects.toThrow();
 expect((await s.loadAccounts())?.accounts[0]?.cooldownReason).toBe("rate-limit");
});
it("does not overwrite a newer blocking observation or clear its account cooldown", async () => {
 const s = await setup();
 const { saveQuotaCache } = await import("../lib/quota-cache.js");
 await saveQuotaCache({ byAccountId: { "fixture-workspace": { updatedAt: s.snapshot.updatedAt + 10, status: 429, model: "fixture", primary: { usedPercent: 100 }, secondary: {} } }, byEmail: {} });
 await s.syncConfirmedResetState(s.target, s.snapshot);
 expect((await s.loadQuotaCache()).byAccountId["fixture-workspace"]?.primary.usedPercent).toBe(100);
 expect((await s.loadAccounts())?.accounts[0]?.cooldownReason).toBe("rate-limit");
});
it("preserves the actual post-reset observation time in the persisted quota", async () => {
 const s = await setup();
 const observedAt = Date.now() - 1_000;
 await s.syncConfirmedResetState(s.target, { ...s.snapshot, updatedAt: observedAt });
 expect((await s.loadQuotaCache()).byAccountId["fixture-workspace"]?.updatedAt).toBe(observedAt);
});
