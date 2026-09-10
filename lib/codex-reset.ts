import { createHash } from "node:crypto";

import { CODEX_BASE_URL } from "./constants.js";
import { createCodexHeaders } from "./request/fetch-helpers.js";

export const CODEX_RESET_CREDIT_AVAILABLE_STATUS = "available";

const RESET_CREDITS_PATH = "/wham/rate-limit-reset-credits";
const RESET_CREDITS_CONSUME_PATH = `${RESET_CREDITS_PATH}/consume`;
const RESET_REQUEST_TIMEOUT_MS = 10_000;

export type CodexResetCreditEntry = {
	id?: string;
	status?: string;
	reset_type?: string;
	granted_at?: string;
	expires_at?: string;
	title?: string;
};

export type CodexResetCreditsPayload = {
	credits?: CodexResetCreditEntry[] | null;
	available_count?: number;
};

export type CodexResetConsumePayload = {
	code?: string;
	windows_reset?: unknown;
	credit?: { id?: string; status?: string; redeemed_at?: string } | null;
};

export type CodexResetCredit = {
	id: string;
	status: string;
	isAvailable: boolean;
	resetType: string | null;
	grantedAt: string | null;
	expiresAt: string | null;
	title: string | null;
};

export type CodexResetCreditsSummary = {
	availableCount: number;
	credits: CodexResetCredit[];
};

export type CodexResetCreditSelection =
	| { type: "selected"; credit: CodexResetCredit }
	| { type: "none-available" }
	| { type: "not-found"; creditId: string };

function toTrimmedString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeResetCreditCount(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: null;
}

export function parseCodexResetCredits(
	payload: CodexResetCreditsPayload,
): CodexResetCreditsSummary {
	const credits: CodexResetCredit[] = [];
	for (const entry of payload.credits ?? []) {
		const id = toTrimmedString(entry.id);
		if (!id) continue;
		const status = toTrimmedString(entry.status) ?? "unknown";
		credits.push({
			id,
			status,
			isAvailable: status === CODEX_RESET_CREDIT_AVAILABLE_STATUS,
			resetType: toTrimmedString(entry.reset_type),
			grantedAt: toTrimmedString(entry.granted_at),
			expiresAt: toTrimmedString(entry.expires_at),
			title: toTrimmedString(entry.title),
		});
	}

	return {
		availableCount:
			normalizeResetCreditCount(payload.available_count) ??
			credits.filter((credit) => credit.isAvailable).length,
		credits,
	};
}

function expirySortValue(credit: CodexResetCredit): number | null {
	if (!credit.expiresAt) return null;
	const value = Date.parse(credit.expiresAt);
	return Number.isFinite(value) ? value : null;
}

function hasFutureExpiry(credit: CodexResetCredit, now: number): boolean {
	const expiresAt = expirySortValue(credit);
	return expiresAt !== null && expiresAt > now;
}

export function selectRedeemableCredit(
	summary: CodexResetCreditsSummary,
	creditId?: string,
	now = Date.now(),
): CodexResetCreditSelection {
	const available = summary.credits.filter(
		(credit) => credit.isAvailable && hasFutureExpiry(credit, now),
	);
	const requestedId = creditId?.trim();
	if (requestedId) {
		const credit = available.find((entry) => entry.id === requestedId);
		return credit
			? { type: "selected", credit }
			: { type: "not-found", creditId: requestedId };
	}

	available.sort((left, right) => {
		const leftExpiry = expirySortValue(left);
		const rightExpiry = expirySortValue(right);
		if (leftExpiry !== null && rightExpiry !== null && leftExpiry !== rightExpiry) {
			return leftExpiry - rightExpiry;
		}
		if (leftExpiry !== null && rightExpiry === null) return -1;
		if (leftExpiry === null && rightExpiry !== null) return 1;
		return left.id.localeCompare(right.id);
	});

	const credit = available[0];
	return credit ? { type: "selected", credit } : { type: "none-available" };
}

export function createRedeemRequestId(creditId: string): string {
	const digest = createHash("sha256")
		.update(`codex-multi-auth:redeem-request:${creditId}`)
		.digest();
	const bytes = digest.subarray(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function requestCodexResetJson<T>(params: {
	path: string;
	method: "GET" | "POST";
	accountId: string;
	accessToken: string;
	body?: unknown;
}): Promise<T> {
	const headers = createCodexHeaders(undefined, params.accountId, params.accessToken);
	headers.set("accept", "application/json");
	if (params.body !== undefined) headers.set("content-type", "application/json");

	const response = await fetch(`${CODEX_BASE_URL}${params.path}`, {
		method: params.method,
		headers,
		body: params.body === undefined ? undefined : JSON.stringify(params.body),
		signal: AbortSignal.timeout(RESET_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: request failed`);
	}
	return (await response.json()) as T;
}

export async function fetchCodexResetCredits(params: {
	accountId: string;
	accessToken: string;
	organizationId: string | undefined;
}): Promise<CodexResetCreditsPayload> {
	return await requestCodexResetJson<CodexResetCreditsPayload>({
		...params,
		path: RESET_CREDITS_PATH,
		method: "GET",
	});
}

export async function consumeCodexResetCredit(params: {
	accountId: string;
	accessToken: string;
	organizationId: string | undefined;
	creditId: string;
	redeemRequestId: string;
}): Promise<CodexResetConsumePayload> {
	const { creditId, redeemRequestId, ...requestParams } = params;
	return await requestCodexResetJson<CodexResetConsumePayload>({
		...requestParams,
		path: RESET_CREDITS_CONSUME_PATH,
		method: "POST",
		body: { credit_id: creditId, redeem_request_id: redeemRequestId },
	});
}
