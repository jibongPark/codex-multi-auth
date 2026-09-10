import { afterEach, describe, expect, it, vi } from "vitest";

import {
	consumeCodexResetCredit,
	createRedeemRequestId,
	fetchCodexResetCredits,
	parseCodexResetCredits,
	selectRedeemableCredit,
} from "../lib/codex-reset.js";

const CREDITS_URL =
	"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CONSUME_URL = `${CREDITS_URL}/consume`;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("codex reset credits", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("chooses the available credit that expires first", () => {
		const summary = parseCodexResetCredits({
			credits: [
				{ id: "later", status: "available", expires_at: "2026-12-01T00:00:00Z" },
				{ id: "earlier", status: "available", expires_at: "2026-10-01T00:00:00Z" },
				{ id: "spent", status: "redeemed", expires_at: "2026-09-01T00:00:00Z" },
			],
		});

		expect(selectRedeemableCredit(summary)).toMatchObject({
			type: "selected",
			credit: { id: "earlier" },
		});
	});

	it("uses the ticket id as a stable expiry tie-breaker and puts unreadable dates last", () => {
		const summary = parseCodexResetCredits({
			credits: [
				{ id: "z-same", status: "available", expires_at: "2026-10-01T00:00:00Z" },
				{ id: "no-date", status: "available", expires_at: "not-a-date" },
				{ id: "a-same", status: "available", expires_at: "2026-10-01T00:00:00Z" },
			],
		});

		expect(selectRedeemableCredit(summary)).toMatchObject({
			type: "selected",
			credit: { id: "a-same" },
		});
	});

	it("honors an explicit available credit id instead of automatic selection", () => {
		const summary = parseCodexResetCredits({
			credits: [
				{ id: "later", status: "available", expires_at: "2026-12-01T00:00:00Z" },
				{ id: "earlier", status: "available", expires_at: "2026-10-01T00:00:00Z" },
			],
		});

		expect(selectRedeemableCredit(summary, "later")).toMatchObject({
			type: "selected",
			credit: { id: "later" },
		});
	});

	it("never selects expired or malformed available credits", () => {
		const summary = parseCodexResetCredits({
			credits: [
				{ id: "expired", status: "available", expires_at: "2025-01-01T00:00:00Z" },
				{ id: "malformed", status: "available", expires_at: "not-a-date" },
				{ id: "valid", status: "available", expires_at: "2027-01-01T00:00:00Z" },
			],
		});
		const now = Date.parse("2026-01-01T00:00:00Z");

		expect(selectRedeemableCredit(summary, undefined, now)).toMatchObject({
			type: "selected",
			credit: { id: "valid" },
		});
		expect(selectRedeemableCredit(summary, "expired", now)).toMatchObject({
			type: "not-found",
			creditId: "expired",
		});
	});

	it("fetches ticket credits with the managed Codex credentials", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ available_count: 1, credits: [] }));
		vi.stubGlobal("fetch", fetchMock);

		await fetchCodexResetCredits({
			accountId: "account-1",
			accessToken: "access-token",
			organizationId: "org-1",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			CREDITS_URL,
			expect.objectContaining({ method: "GET" }),
		);
		const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
		expect(headers.get("authorization")).toBe("Bearer access-token");
		expect(headers.get("chatgpt-account-id")).toBe("account-1");
		expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
	});

	it("posts an explicit ticket id with a stable idempotency key", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ code: "ok" }));
		vi.stubGlobal("fetch", fetchMock);
		const redeemRequestId = createRedeemRequestId("ticket-1");

		await consumeCodexResetCredit({
			accountId: "account-1",
			accessToken: "access-token",
			organizationId: undefined,
			creditId: "ticket-1",
			redeemRequestId,
		});

		expect(fetchMock).toHaveBeenCalledWith(
			CONSUME_URL,
			expect.objectContaining({ method: "POST" }),
		);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			credit_id: "ticket-1",
			redeem_request_id: redeemRequestId,
		});
		expect(createRedeemRequestId("ticket-1")).toBe(redeemRequestId);
	});

	it("does not echo sensitive failed backend responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("denied for private@example.com Bearer secret-access-token", { status: 403 })),
		);

		await expect(
			fetchCodexResetCredits({
				accountId: "account-1",
				accessToken: "access-token",
				organizationId: undefined,
			}),
		).rejects.toThrow("HTTP 403: request failed");
	});
});
