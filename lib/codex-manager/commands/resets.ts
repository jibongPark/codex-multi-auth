import { AccountManager } from "../../accounts.js";
import { loadAccounts } from "../../storage.js";
import { runWithGlobalStoragePath } from "../../storage/path-state.js";
import { createResetCreditService, resetTargetForStoredAccount, resetAccountLabel } from "../../runtime/account-reset-credits.js";
import { withCheckProgress } from "../../ui/check-progress.js";
import { runResetCommand } from "./reset.js";
import { syncConfirmedResetState } from "../reset-state-sync.js";

const usage = "Usage: codex-multi-auth resets list [--refresh] [--account <number>] [--json] | redeem <account-number> [--json] | auto manual|last-resort";
export interface ResetsCommandDeps {
 restartRuntime?: () => Promise<"restarted" | "unavailable">;
}

function parseArgs(args: string[]) {
 const [command = "list", ...rest] = args;
 if (!["list", "redeem", "auto"].includes(command)) return null;
 let json = false, refresh = false, account: number | undefined;
 const positional: string[] = [];
 for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (arg === undefined) return null;
  if (arg === "--json" && !json && command !== "auto") json = true;
  else if (arg === "--refresh" && !refresh && command === "list") refresh = true;
  else if (arg === "--account" && account === undefined && command === "list") {
   const value = rest[++i];
   if (!/^[1-9][0-9]*$/.test(value ?? "")) return null;
   account = Number(value);
   if (!Number.isSafeInteger(account)) return null;
  } else if (!arg.startsWith("--")) positional.push(arg);
  else return null;
 }
 if (command === "list" && positional.length) return null;
 if (command === "redeem") {
  if (positional.length !== 1 || !/^[1-9][0-9]*$/.test(positional[0] ?? "")) return null;
  account = Number(positional[0]);
  if (!Number.isSafeInteger(account)) return null;
 }
 if (command === "auto" && (positional.length !== 1 || !["manual", "last-resort"].includes(positional[0] ?? ""))) return null;
 return { command, json, refresh, account, policy: positional[0] as "manual" | "last-resort" };
}

export async function runResetsCommand(args: string[], deps: ResetsCommandDeps = {}): Promise<number> {
 if (args.length === 1 && ["--help", "-h"].includes(args[0] ?? "")) { console.log(usage); return 0; }
 const options = parseArgs(args);
 if (!options) { console.error(usage); return 1; }
 const { command, json, refresh, account: number, policy } = options;
 return runWithGlobalStoragePath(async () => {
  const storage = await loadAccounts();
  if (number !== undefined && !storage?.accounts[number - 1]) { console.error("Choose a configured account number."); return 1; }
  const manager = new AccountManager(undefined, storage);
  const service = createResetCreditService(manager);
  let confirmedRedemption = false;
  const progress = <T>(label: string, operation: () => Promise<T>) => json ? operation() : withCheckProgress(label, operation);
  try {
   if (command === "auto") { await service.setPolicy(policy); console.log(`Automatic reset redemption: ${policy}`); return 0; }
   if (command === "redeem") {
    if (number === undefined) throw new Error("Missing account number.");
    const index = number - 1;
    const selectedAccount = storage?.accounts[index];
    const target = selectedAccount && resetTargetForStoredAccount(selectedAccount);
    if (!target) { console.error("Choose a configured, enabled subscription account/workspace."); return 1; }
    const before = await service.status();
    // Only an existing, uncertain HTTP ticket may use the old transport. New
    // redemptions always go through the native Codex reset-credit service.
    if (before.pending?.transport === "ticket" && before.pending.key === target.key) {
     const exitCode = await runResetCommand(["action=consume", `account=${number}`, "confirm=true", `format=${json ? "json" : "text"}`], {
      requirePendingTicket: true,
      restartRuntime: deps.restartRuntime,
      logInfo: (message) => {
       if (!json) { console.log(message); return; }
       const result = JSON.parse(message) as Record<string, unknown>;
       console.log(JSON.stringify({ ...result, command: "resets", action: "redeem", account: number, outcome: result.redeemed === true ? "reset" : null }));
      },
     });
     confirmedRedemption = exitCode === 0;
     return exitCode;
    }
    const outcome = await progress(`Redeeming a reset for account ${number}`, () => service.redeem(target));
    const redeemed = outcome === "reset" || outcome === "alreadyRedeemed";
    confirmedRedemption = redeemed;
    let localCleanupError: string | null = null;
    let runtimeReset: "restarted" | "unavailable" | "failed" = "unavailable";
    if (redeemed) {
     try {
      await manager.flushPendingSave();
      const state = await service.status();
      await syncConfirmedResetState(target, state.snapshots[target.key]);
     } catch { localCleanupError = "Could not update local reset state; refresh usage before retrying."; }
     if (deps.restartRuntime) {
      try { runtimeReset = await deps.restartRuntime(); }
      catch { runtimeReset = "failed"; }
     }
    }
    if (json) console.log(JSON.stringify({ command: "resets", action: "redeem", account: number, outcome, redeemed, localCleanupError, runtimeReset }));
    else {
     console.log(`Account ${number}: ${outcome}. Usage was re-read.`);
     if (localCleanupError) console.error(localCleanupError);
     if (redeemed && runtimeReset !== "restarted") console.error("Reopen Codex if its running runtime still shows old limits.");
    }
    return 0;
   }
   const rows = (storage?.accounts ?? []).map((a, index) => ({ account: a, index, target: resetTargetForStoredAccount(a) }));
   const keyCounts = new Map<string, number>();
   for (const { target } of rows) if (target) keyCounts.set(target.key, (keyCounts.get(target.key) ?? 0) + 1);
   const selected = number === undefined ? rows : rows.filter(row => row.index === number - 1);
   const targets = selected.flatMap(row => row.target && keyCounts.get(row.target.key) === 1 ? [row.target] : []);
   const refreshed = refresh ? await progress("Refreshing reset-credit availability", () => service.refresh(targets)) : null;
   const state = await service.status();
   const snapshots = refreshed ?? state.snapshots;
   let failed = 0;
   const output = selected.map(({ account, index, target }) => {
    const ambiguous = Boolean(target && (keyCounts.get(target.key) ?? 0) > 1);
    const snapshot = target && !ambiguous ? snapshots[target.key] : undefined;
    if (refresh && ((target && !snapshot) || (number !== undefined && !target))) failed++;
    if (!json) console.log(`${resetAccountLabel(account, index)}: ${snapshot?.availableCount ?? "unknown"} reset credits${snapshot ? ` (checked ${Math.max(0, Math.floor((Date.now() - snapshot.updatedAt) / 1000))}s ago)` : ""}${ambiguous ? " [ambiguous account identity; repair duplicate records]" : ""}${target?.key === state.pending?.key ? " [redemption pending; retry this account]" : ""}`);
    return { account: index + 1, availableCount: snapshot?.availableCount ?? null, credits: [], updatedAt: snapshot?.updatedAt ?? null, ambiguous, pending: target?.key === state.pending?.key };
   });
   if (json) console.log(JSON.stringify({ command: "resets", action: "list", policy: state.policy, ...(number === undefined ? { accounts: output } : output[0]) }));
   else {
    console.log(`Automatic redemption: ${state.policy}`);
    if (state.lastRedemption) {
     const row = rows.find(row => row.target?.key === state.lastRedemption?.key);
     console.log(`Last confirmed reset: ${row ? `account ${row.index + 1}` : "removed account"}; ${state.lastRedemption.outcome}; ${state.lastRedemption.automatic ? "automatic" : "explicit"}`);
    }
   }
   if (failed) { console.error(`${failed} of ${selected.filter(row => row.target || number !== undefined).length} reset-credit reads failed. Check account authentication and the native Codex backend (CODEX_MULTI_AUTH_USAGE_CODEX_BIN selects an executable). No credits were redeemed.`); return 1; }
   return 0;
  } catch {
   const pending = command === "redeem" ? await service.status().then(s => s.pending ?? null, () => ({ key: undefined })) : null;
   const owner = pending?.key ? (storage?.accounts ?? []).findIndex(a => resetTargetForStoredAccount({ ...a, enabled: true, workspaces: undefined })?.key === pending.key) : -1;
   const pendingAccount = owner >= 0 ? storage?.accounts[owner] : undefined;
   const disabled = pendingAccount ? resetTargetForStoredAccount(pendingAccount) === null : false;
   const retry = disabled ? `account ${owner + 1} or its workspace is disabled; re-enable it before retrying the pending result` : pending?.key && owner < 0 ? "check it there (the pending account was removed)" : owner >= 0 && owner !== (number ?? 0) - 1 ? `retry account ${owner + 1}, which holds the pending result` : "retry the same account";
   console.error(command === "list" ? "Reset-credit availability could not be refreshed. No credits were redeemed." : command === "auto" ? "Reset-credit settings could not be updated." : pending ? `Reset operation could not be confirmed. No new automatic redemption will be attempted while a result is pending; use resets list and ${retry}.` : "No reset credit was redeemed. Availability could not be confirmed or a reset was just redeemed; run resets list --refresh and try again.");
   return 1;
  } finally {
   try { await manager.flushPendingSave(); }
   catch (error) {
    if (!confirmedRedemption) throw error;
    console.error("Reset was confirmed, but local state could not be saved. Refresh usage; do not redeem another credit to repair local state.");
   }
  }
 });
}
