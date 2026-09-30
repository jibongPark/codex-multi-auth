import { cloneTrackedAccountStorage, loadAccounts, saveAccounts } from "../storage.js";
import { loadQuotaCache, saveQuotaCache } from "../quota-cache.js";
import { findQuotaCacheEntryForAccount } from "../quota-readiness.js";
import { cloneQuotaCacheData, updateQuotaCacheForWorkspace } from "./quota-cache-helpers.js";
import { resetTargetForStoredAccount } from "../runtime/account-reset-credits.js";
import { resetSnapshotQuota, type ResetSnapshot, type ResetTarget } from "../runtime/reset-credits.js";

/** Publish the backend's post-reset quota before restarting a bound router. */
export async function syncConfirmedResetState(target: ResetTarget, snapshot: ResetSnapshot | undefined): Promise<void> {
 if (!snapshot) throw new Error("Post-reset usage is unavailable.");
 const storage = await loadAccounts();
 const matches = storage?.accounts.map((account, index) => ({ account, index })).filter(({ account }) => resetTargetForStoredAccount(account)?.key === target.key) ?? [];
 if (!storage || matches.length !== 1) throw new Error("Reset account changed.");
 const match = matches[0];
 if (!match) throw new Error("Reset account changed.");
 const { account, index } = match;
 const cache = await loadQuotaCache();
 const current = findQuotaCacheEntryForAccount(cache, account, storage.accounts, undefined, target.accountId);
 // A router may have observed newer usage while the redemption read completed.
 // Keep that quota and its cooldown instead of making the older reset look fresh.
 if (current && current.updatedAt > snapshot.updatedAt) return;
 const baseline = cloneQuotaCacheData(cache);
 if (snapshot.ordinaryUsageAllowed === true) {
  const next = cloneTrackedAccountStorage(storage);
  const nextAccount = next.accounts[index];
  if (!nextAccount) throw new Error("Reset account changed.");
  delete nextAccount.rateLimitResetTimes;
  if (nextAccount.cooldownReason === "rate-limit") {
   delete nextAccount.cooldownReason;
   delete nextAccount.coolingDownUntil;
  }
  await saveAccounts(next);
 }
 const quota = resetSnapshotQuota(snapshot);
 updateQuotaCacheForWorkspace(cache, account, target.accountId, quota, storage.accounts);
 // The shared probe helper stamps new entries at write time; reset snapshots
 // already carry their observation time, which the cache CAS must compare.
 for (const namespace of ["byAccountId", "byEmail", "byWorkspace"] as const) {
  const entries = cache[namespace];
  if (!entries) continue;
  for (const [key, entry] of Object.entries(entries)) {
   if (entry !== baseline[namespace]?.[key]) entries[key] = { ...entry, updatedAt: snapshot.updatedAt };
  }
 }
 await saveQuotaCache(cache, baseline);
}
