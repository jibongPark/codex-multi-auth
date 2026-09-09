import { extractAccountId } from "../../accounts.js";
import {
	consumeCodexResetCredit,
	createRedeemRequestId,
	fetchCodexResetCredits,
	parseCodexResetCredits,
	selectRedeemableCredit,
	type CodexResetConsumePayload,
	type CodexResetCreditsPayload,
} from "../../codex-reset.js";
import { CODEX_BASE_URL } from "../../constants.js";
import { createCodexHeaders } from "../../request/fetch-helpers.js";
import { queuedRefresh } from "../../refresh-queue.js";
import {
	loadAccounts,
	saveAccounts,
	type AccountStorageV3,
} from "../../storage.js";
import type { TokenResult } from "../../types.js";
import { resolveActiveIndex } from "../../runtime/account-status.js";
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

type UsagePayload = Record<string, unknown>;

export interface ResetCommandDeps {
	loadAccounts?: () => Promise<AccountStorageV3 | null>;
	saveAccounts?: (storage: AccountStorageV3) => Promise<void>;
	resolveActiveIndex?: (storage: AccountStorageV3, family?: "codex") => number;
	queuedRefresh?: (refreshToken: string) => Promise<TokenResult>;
	fetchCredits?: (params: {
		accountId: string;
		accessToken: string;
		organizationId: string | undefined;
	}) => Promise<CodexResetCreditsPayload>;
	fetchUsage?: (params: {
		accountId: string;
		accessToken: string;
		organizationId: string | undefined;
	}) => Promise<UsagePayload>;
	consumeCredit?: (params: {
		accountId: string;
		accessToken: string;
		organizationId: string | undefined;
		creditId: string;
		redeemRequestId: string;
	}) => Promise<CodexResetConsumePayload>;
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

async function defaultFetchUsage(params: {
	accountId: string;
	accessToken: string;
	organizationId: string | undefined;
}): Promise<UsagePayload> {
	const response = await fetch(`${CODEX_BASE_URL}/wham/usage`, {
		method: "GET",
		headers: createCodexHeaders(undefined, params.accountId, params.accessToken),
	});
	if (!response.ok) throw new Error(`Usage request failed with HTTP ${response.status}`);
	return (await response.json()) as UsagePayload;
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
	logInfo(`${state}: ${account}${credit?.id ? `; ticket=${credit.id}` : ""}${credit?.expiresAt ? `; expires=${credit.expiresAt}` : ""}`);
}

function clearLocalRateLimitState(storage: AccountStorageV3, index: number): AccountStorageV3 {
	const next = structuredClone(storage);
	const account = next.accounts[index];
	if (!account) return next;
	delete account.rateLimitResetTimes;
	delete account.coolingDownUntil;
	delete account.cooldownReason;
	return next;
}

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
		workingStorage = structuredClone(storage);
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
	const accountId = selectedAccount?.accountId ?? extractAccountId(accessToken);
	if (!accountId) {
		logError("The selected account has no account id.");
		return 1;
	}
	const requestAccount = { accountId, accessToken, organizationId: undefined };
	const fetchCredits = deps.fetchCredits ?? fetchCodexResetCredits;
	const fetchUsage = deps.fetchUsage ?? defaultFetchUsage;
	const identity =
		options.format === "json" && options.includeSensitive
			? accountId
			: redactedAccount(accountId, index);

	if (options.action === "status") {
		try {
			const [creditsPayload, usage] = await Promise.all([
				fetchCredits(requestAccount),
				fetchUsage(requestAccount),
			]);
			const credits = parseCodexResetCredits(creditsPayload);
			printResult(options, logInfo, {
				command: "reset",
				action: "status",
				account: identity,
				availableCount: credits.availableCount,
				credits: credits.credits,
				usage,
			});
			return 0;
		} catch (error) {
			logError(`Failed to fetch reset status: ${error instanceof Error ? error.message : String(error)}`);
			return 1;
		}
	}

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
	const credit = selection.credit;
	if (!options.confirm || options.dryRun) {
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
		const consumed = await (deps.consumeCredit ?? consumeCodexResetCredit)({
			...requestAccount,
			creditId: credit.id,
			redeemRequestId: createRedeemRequestId(credit.id),
		});
		const nextStorage = clearLocalRateLimitState(workingStorage, index);
		await (deps.saveAccounts ?? saveAccounts)(nextStorage);
		let usage: UsagePayload | null = null;
		let usageError: string | null = null;
		try {
			usage = await fetchUsage(requestAccount);
		} catch (error) {
			usageError = error instanceof Error ? error.message : String(error);
		}
		printResult(options, logInfo, {
			command: "reset",
			action: "consume",
			account: identity,
			credit,
			redeemed: true,
			consume: consumed,
			usage,
			usageError,
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
