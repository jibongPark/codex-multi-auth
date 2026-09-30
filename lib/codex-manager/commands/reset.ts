import { AccountManager, extractAccountId } from "../../accounts.js";
import {
	consumeCodexResetCredit,
	createRedeemRequestId,
	fetchCodexResetCredits,
	parseCodexResetCredits,
	selectRedeemableCredit,
	type CodexResetCredit,
	type CodexResetConsumePayload,
	type CodexResetCreditsPayload,
} from "../../codex-reset.js";
import {
	loadQuotaCache,
	saveQuotaCache,
	type QuotaCacheData,
} from "../../quota-cache.js";
import {
	buildQuotaEmailFallbackState,
	hasSafeQuotaEmailFallback,
	hasUniqueQuotaAccountId,
	normalizeQuotaAccountId,
	normalizeQuotaEmail,
} from "../../quota-readiness.js";
import { queuedRefresh } from "../../refresh-queue.js";
import {
	cloneTrackedAccountStorage,
	loadAccounts,
	saveAccounts,
	type AccountStorageV3,
} from "../../storage.js";
import type { TokenResult } from "../../types.js";
import { resolveActiveIndex } from "../../runtime/account-status.js";
import { createResetCreditService, resetTargetForStoredAccount } from "../../runtime/account-reset-credits.js";
import type { ResetCreditService } from "../../runtime/reset-credits.js";
import { hasUsableAccessToken } from "../account-credentials.js";

type ResetAction = "status" | "consume";
type ResetFormat = "text" | "json";

interface ResetOptions {
	action: ResetAction;
	account?: number;
	creditId?: string;
	confirm: boolean;
	dryRun: boolean;
	format: ResetFormat;
	includeSensitive: boolean;
}

export interface ResetCommandDeps {
	/** Recovery must never select a new ticket after another process resolved it. */
	requirePendingTicket?: boolean;
	loadAccounts?: () => Promise<AccountStorageV3 | null>;
	saveAccounts?: (storage: AccountStorageV3) => Promise<void>;
	resolveActiveIndex?: (storage: AccountStorageV3, family?: "codex") => number;
	queuedRefresh?: (refreshToken: string) => Promise<TokenResult>;
	fetchCredits?: (params: {
		accountId: string;
		accessToken: string;
		organizationId: string | undefined;
	}) => Promise<CodexResetCreditsPayload>;
	consumeCredit?: (params: {
		accountId: string;
		accessToken: string;
		organizationId: string | undefined;
		creditId: string;
		redeemRequestId: string;
	}) => Promise<CodexResetConsumePayload>;
	redeemSelectedTicket?: ResetCreditService["redeemSelectedTicket"];
	loadQuotaCache?: () => Promise<QuotaCacheData>;
	saveQuotaCache?: (cache: QuotaCacheData) => Promise<void>;
	/** Restarts an already-bound runtime router after the durable limit state changes. */
	restartRuntime?: () => Promise<"restarted" | "unavailable">;
	getNow?: () => number;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
}

type ParsedArgs = { ok: true; options: ResetOptions } | { ok: false; error: string };

const VALID_OPTIONS = new Set([
	"action",
	"account",
	"creditId",
	"confirm",
	"dryRun",
	"format",
	"includeSensitive",
]);

function parseBoolean(value: string): boolean | null {
	if (value === "true") return true;
	if (value === "false") return false;
	return null;
}

function parseResetArgs(args: string[]): ParsedArgs {
	const values = new Map<string, string>();
	for (const arg of args) {
		const separator = arg.indexOf("=");
		if (separator <= 0) {
			return { ok: false, error: `Expected reset option in key=value form: ${arg}` };
		}
		const key = arg.slice(0, separator);
		const value = arg.slice(separator + 1);
		if (!VALID_OPTIONS.has(key)) return { ok: false, error: `Unknown reset option: ${key}` };
		if (values.has(key)) return { ok: false, error: `Duplicate reset option: ${key}` };
		values.set(key, value);
	}

	const action = values.get("action") ?? "status";
	if (action !== "status" && action !== "consume") {
		return { ok: false, error: "action must be status or consume" };
	}
	const format = values.get("format") ?? "text";
	if (format !== "text" && format !== "json") {
		return { ok: false, error: "format must be text or json" };
	}
	const booleanValues = ["confirm", "dryRun", "includeSensitive"] as const;
	const parsedBooleans: Record<(typeof booleanValues)[number], boolean> = {
		confirm: false,
		dryRun: false,
		includeSensitive: false,
	};
	for (const key of booleanValues) {
		const raw = values.get(key);
		if (raw === undefined) continue;
		const parsed = parseBoolean(raw);
		if (parsed === null) return { ok: false, error: `${key} must be true or false` };
		parsedBooleans[key] = parsed;
	}

	let account: number | undefined;
	const rawAccount = values.get("account");
	if (rawAccount !== undefined) {
		if (!/^[1-9]\d*$/.test(rawAccount)) {
			return { ok: false, error: "account must be a positive 1-based integer" };
		}
		account = Number.parseInt(rawAccount, 10);
	}
	const creditId = values.get("creditId")?.trim() || undefined;
	return {
		ok: true,
		options: { action, account, creditId, format, ...parsedBooleans },
	};
}

function redactedAccount(accountId: string, index: number): string {
	const tail = accountId.length > 4 ? accountId.slice(-4) : accountId;
	return `account ${index + 1} (id:***${tail})`;
}

function printResult(
	options: ResetOptions,
	logInfo: (message: string) => void,
	payload: Record<string, unknown>,
): void {
	if (options.format === "json") {
		logInfo(JSON.stringify(payload, null, 2));
		return;
	}
	if (payload.action === "status") {
		const credits = Array.isArray(payload.credits)
			? (payload.credits as Array<{ id: string; status: string; expiresAt: string | null }>)
			: [];
		const lines = [
			`Reset tickets for ${payload.account}: ${String(payload.availableCount ?? 0)} available`,
			...credits.map((entry) =>
				`${entry.id}  status=${entry.status}${entry.expiresAt ? `  expires=${entry.expiresAt}` : ""}`,
			),
		];
		logInfo(lines.join("\n"));
		return;
	}
	const credit = payload.credit as { id?: string; expiresAt?: string | null } | null;
	const account = payload.account as string;
	const state = payload.redeemed === true ? "Redeemed" : payload.redeemed === null ? "Redemption outcome uncertain" : "Preview";
	const cleanupError = payload.localCleanupError;
	logInfo(`${state}: ${account}${credit?.id ? `; ticket=${credit.id}` : ""}${credit?.expiresAt ? `; expires=${credit.expiresAt}` : ""}${typeof cleanupError === "string" ? `; local cleanup failed: ${cleanupError}` : ""}`);
}

function clearLocalRateLimitState(storage: AccountStorageV3, index: number): AccountStorageV3 {
	const next = cloneTrackedAccountStorage(storage);
	const account = next.accounts[index];
	if (!account) return next;
	delete account.rateLimitResetTimes;
	if (account.cooldownReason === "rate-limit") {
		delete account.coolingDownUntil;
		delete account.cooldownReason;
	}
	return next;
}

function invalidateQuotaCacheForAccount(
	cache: QuotaCacheData,
	account: AccountStorageV3["accounts"][number],
	accounts: AccountStorageV3["accounts"],
): QuotaCacheData | null {
	const next = structuredClone(cache);
	let changed = false;
	const accountId = normalizeQuotaAccountId(account.accountId);
	if (accountId && hasUniqueQuotaAccountId(accounts, account) && next.byAccountId[accountId]) {
		delete next.byAccountId[accountId];
		changed = true;
	}
	const email = normalizeQuotaEmail(account.email);
	if (
		email &&
		hasSafeQuotaEmailFallback(buildQuotaEmailFallbackState(accounts), account) &&
		next.byEmail[email]
	) {
		delete next.byEmail[email];
		changed = true;
	}
	return changed ? next : null;
}

/** Private compatibility transport used only to recover a previously pending ticket. */
export async function runResetCommand(
	args: string[],
	deps: ResetCommandDeps = {},
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	const parsed = parseResetArgs(args);
	if (!parsed.ok) {
		logError(parsed.error);
		return 1;
	}
	const options = parsed.options;
	const storage = await (deps.loadAccounts ?? loadAccounts)();
	if (!storage || storage.accounts.length === 0) {
		logError("No accounts configured.");
		return 1;
	}
	const index = options.account === undefined
		? (deps.resolveActiveIndex ?? resolveActiveIndex)(storage, "codex")
		: options.account - 1;
	const account = storage.accounts[index];
	if (!account) {
		logError(`Account ${options.account} was not found.`);
		return 1;
	}

	const now = deps.getNow?.() ?? Date.now();
	let accessToken = account.accessToken;
	let workingStorage = storage;
	if (!hasUsableAccessToken(account, now)) {
		const refreshed = await (deps.queuedRefresh ?? queuedRefresh)(account.refreshToken);
		if (refreshed.type !== "success") {
			logError("Could not refresh the selected account credentials.");
			return 1;
		}
		accessToken = refreshed.access;
		workingStorage = cloneTrackedAccountStorage(storage);
		const refreshedAccount = workingStorage.accounts[index];
		if (!refreshedAccount) return 1;
		refreshedAccount.accessToken = refreshed.access;
		refreshedAccount.refreshToken = refreshed.refresh;
		refreshedAccount.expiresAt = refreshed.expires;
		const tokenAccountId = extractAccountId(refreshed.access);
		if (tokenAccountId) refreshedAccount.accountId = tokenAccountId;
		await (deps.saveAccounts ?? saveAccounts)(workingStorage);
	}
	if (!accessToken) {
		logError("The selected account has no usable access token.");
		return 1;
	}
	const selectedAccount = workingStorage.accounts[index];
	if (!selectedAccount) {
		logError("The selected account is no longer available.");
		return 1;
	}
	const accountId = selectedAccount?.accountId ?? extractAccountId(accessToken);
	if (!accountId) {
		logError("The selected account has no account id.");
		return 1;
	}
	const requestAccount = { accountId, accessToken, organizationId: undefined };
	const fetchCredits = deps.fetchCredits ?? fetchCodexResetCredits;
	const identity =
		options.format === "json" && options.includeSensitive
			? accountId
			: redactedAccount(accountId, index);

	if (options.action === "status") {
		try {
			const creditsPayload = await fetchCredits(requestAccount);
			const credits = parseCodexResetCredits(creditsPayload);
			printResult(options, logInfo, {
				command: "reset",
				action: "status",
				account: identity,
				availableCount: credits.availableCount,
				credits: credits.credits,
			});
			return 0;
		} catch (error) {
			logError(`Failed to fetch reset status: ${error instanceof Error ? error.message : String(error)}`);
			return 1;
		}
	}

	let credit: CodexResetCredit | null = null;
	if (!options.confirm || options.dryRun) {
		let creditsPayload: CodexResetCreditsPayload;
		try {
			creditsPayload = await fetchCredits(requestAccount);
		} catch (error) {
			logError(`Failed to fetch reset tickets: ${error instanceof Error ? error.message : String(error)}`);
			return 1;
		}
		const selection = selectRedeemableCredit(parseCodexResetCredits(creditsPayload), options.creditId);
		if (selection.type === "none-available") {
			logError("No reset tickets are available.");
			return 1;
		}
		if (selection.type === "not-found") {
			logError(`The requested reset ticket is not available: ${selection.creditId}`);
			return 1;
		}
		credit = selection.credit;
		printResult(options, logInfo, {
			command: "reset",
			action: "consume",
			account: identity,
			credit,
			redeemed: false,
			preview: true,
		});
		return 0;
	}

	try {
		const target = resetTargetForStoredAccount(selectedAccount);
		if (!target) {
			logError("The selected account is not an enabled subscription workspace.");
			return 1;
		}
		const manager = deps.redeemSelectedTicket ? null : new AccountManager(undefined, workingStorage);
		const service = manager ? createResetCreditService(manager) : null;
		const redeemSelectedTicket = deps.redeemSelectedTicket ?? service?.redeemSelectedTicket.bind(service);
		if (!redeemSelectedTicket) throw new Error("Reset-credit service is unavailable.");
		let managerCleanupError: string | null = null;
		let redemptionConfirmed = false;
		try {
			let postAccount: typeof requestAccount | null = null;
			const result = await redeemSelectedTicket<CodexResetCredit>(
				target,
				async (pending) => {
					if (deps.requirePendingTicket && !pending) throw new Error("The pending ticket was already resolved; no new ticket was consumed.");
					if (pending && options.creditId) {
						const idempotencyKey = createRedeemRequestId(options.creditId);
						if (idempotencyKey !== pending.idempotencyKey) {
							throw new Error("A different ticket redemption is pending; retry the same creditId.");
						}
						credit = { id: options.creditId, status: "unknown", isAvailable: false, resetType: null, grantedAt: null, expiresAt: null, title: null };
						return { ticket: credit, idempotencyKey, ticketId: credit.id };
					}
					if (pending?.ticketId) {
						credit = { id: pending.ticketId, status: "unknown", isAvailable: false, resetType: null, grantedAt: null, expiresAt: null, title: null };
						return { ticket: credit, idempotencyKey: pending.idempotencyKey, ticketId: credit.id };
					}
					const latest = parseCodexResetCredits(await fetchCredits(requestAccount));
					if (pending) {
						const prior = latest.credits.find((entry) => createRedeemRequestId(entry.id) === pending.idempotencyKey);
						if (!prior) throw new Error("The pending ticket is absent from the account list. Retry with its original creditId; no other ticket was consumed.");
						credit = prior;
						return { ticket: prior, idempotencyKey: pending.idempotencyKey, ticketId: prior.id };
					}
					const selected = selectRedeemableCredit(latest, options.creditId, deps.getNow?.() ?? Date.now());
					if (selected.type !== "selected") throw new Error(
						selected.type === "not-found" ? `The requested reset ticket is not available: ${selected.creditId}` : "No reset tickets are available.",
					);
					credit = selected.credit;
					return { ticket: credit, idempotencyKey: createRedeemRequestId(credit.id), ticketId: credit.id };
				},
				async (selectedCredit, idempotencyKey) => {
					const currentPostAccount = postAccount;
					if (!currentPostAccount) throw new Error("Account revalidation did not complete; no ticket was consumed.");
					const response = await (deps.consumeCredit ?? consumeCodexResetCredit)({
						...currentPostAccount,
						creditId: selectedCredit.id,
						redeemRequestId: idempotencyKey,
					});
					if (response.code !== undefined && response.code !== "ok") {
						throw new Error("Reset ticket provider did not confirm consumption.");
					}
					return "reset";
				},
				async () => {
					const latestStorage = await (deps.loadAccounts ?? loadAccounts)();
					const matchingAccounts = latestStorage?.accounts.filter((candidate) => {
						const currentTarget = resetTargetForStoredAccount(candidate);
						return currentTarget?.key === target.key && currentTarget.accountId === target.accountId;
					}) ?? [];
					const currentAccount = matchingAccounts[0];
					if (matchingAccounts.length !== 1 || !currentAccount || typeof currentAccount.accessToken !== "string" || !hasUsableAccessToken(currentAccount, deps.getNow?.() ?? Date.now())) {
						throw new Error("The selected account changed or its credentials expired; no ticket was consumed.");
					}
					postAccount = {
						accountId: target.accountId,
						accessToken: currentAccount.accessToken,
						organizationId: undefined,
					};
				},
			);
			credit = result.ticket;
			redemptionConfirmed = true;
		} finally {
			try {
				await manager?.flushPendingSave();
			} catch (error) {
				if (!redemptionConfirmed) throw error;
				managerCleanupError = error instanceof Error ? error.message : String(error);
			}
		}
		let localCleanupError: string | null = managerCleanupError;
		try {
			const nextStorage = clearLocalRateLimitState(workingStorage, index);
			await (deps.saveAccounts ?? saveAccounts)(nextStorage);
		} catch (error) {
			localCleanupError = error instanceof Error ? error.message : String(error);
		}
		let quotaCacheInvalidated = false;
		let quotaCacheError: string | null = null;
		let runtimeReset: "restarted" | "failed" | "unavailable" = "unavailable";
		let runtimeResetError: string | null = null;
		try {
			const quotaCache = await (deps.loadQuotaCache ?? loadQuotaCache)();
			const nextQuotaCache = invalidateQuotaCacheForAccount(
				quotaCache,
				selectedAccount,
				workingStorage.accounts,
			);
			if (nextQuotaCache) {
				await (deps.saveQuotaCache ?? saveQuotaCache)(nextQuotaCache);
				quotaCacheInvalidated = true;
			}
		} catch (error) {
			quotaCacheError = error instanceof Error ? error.message : String(error);
		}
		if (deps.restartRuntime) {
			try {
				runtimeReset = await deps.restartRuntime();
			} catch (error) {
				runtimeReset = "failed";
				runtimeResetError = error instanceof Error ? error.message : String(error);
			}
		}
		printResult(options, logInfo, {
			command: "reset",
			action: "consume",
			account: identity,
			credit,
			redeemed: true,
			localCleanupError,
			quotaCacheInvalidated,
			quotaCacheError,
			runtimeReset,
			runtimeResetError,
		});
		return 0;
	} catch (error) {
		printResult(options, logInfo, {
			command: "reset",
			action: "consume",
			account: identity,
			credit,
			redeemed: null,
			error: error instanceof Error ? error.message : String(error),
		});
		return 1;
	}
}
