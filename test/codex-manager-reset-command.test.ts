import { describe, expect, it, vi } from "vitest";

import { runResetCommand } from "../lib/codex-manager/commands/reset.js";

function createDeps() {
	const storage = {
		version: 3 as const,
		activeIndex: 0,
		accounts: [
			{
				accountId: "active",
				refreshToken: "refresh-token",
				accessToken: "access-token",
				expiresAt: Date.now() + 60 * 60_000,
				addedAt: 1,
				lastUsed: 1,
				rateLimitResetTimes: { codex: Date.now() + 60_000 },
				coolingDownUntil: Date.now() + 60_000,
			},
			{
				accountId: "second",
				refreshToken: "second-refresh-token",
				accessToken: "second-access-token",
				expiresAt: Date.now() + 60 * 60_000,
				addedAt: 1,
				lastUsed: 1,
			},
		],
	};
	const logInfo = vi.fn();
	const logError = vi.fn();
	return {
		storage,
		logInfo,
		logError,
		deps: {
			loadAccounts: vi.fn(async () => structuredClone(storage)),
			saveAccounts: vi.fn(async () => undefined),
			resolveActiveIndex: vi.fn(() => 0),
			queuedRefresh: vi.fn(),
			fetchCredits: vi.fn(async () => ({
				credits: [
					{ id: "later", status: "available", expires_at: "2026-12-01T00:00:00Z" },
					{ id: "earlier", status: "available", expires_at: "2026-10-01T00:00:00Z" },
				],
			})),
			fetchUsage: vi.fn(async () => ({ plan_type: "pro" })),
			consumeCredit: vi.fn(async () => ({ code: "ok" })),
			logInfo,
			logError,
		},
	};
}

describe("reset manager command", () => {
	it("uses the active account and reads credits and usage for status", async () => {
		const { deps, logInfo } = createDeps();

		await expect(runResetCommand([], deps)).resolves.toBe(0);
		expect(deps.fetchCredits).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "active", accessToken: "access-token" }),
		);
		expect(deps.fetchUsage).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "active", accessToken: "access-token" }),
		);
		expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("earlier"));
	});

	it("previews the earliest-expiring ticket without posting when unconfirmed", async () => {
		const { deps, logInfo } = createDeps();

		await expect(runResetCommand(["action=consume"], deps)).resolves.toBe(0);
		expect(deps.consumeCredit).not.toHaveBeenCalled();
		expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("earlier"));
	});

	it("consumes the selected account ticket only after confirmation and clears local limits", async () => {
		const { deps } = createDeps();

		await expect(
			runResetCommand(["action=consume", "account=1", "confirm=true"], deps),
		).resolves.toBe(0);
		expect(deps.consumeCredit).toHaveBeenCalledWith(
			expect.objectContaining({ creditId: "earlier" }),
		);
		const savedStorage = deps.saveAccounts.mock.calls[0]?.[0];
		expect(savedStorage?.accounts[0]?.rateLimitResetTimes).toBeUndefined();
		expect(savedStorage?.accounts[0]?.coolingDownUntil).toBeUndefined();
	});

	it("rejects unknown key=value inputs", async () => {
		const { deps, logError } = createDeps();

		await expect(runResetCommand(["unsafe=true"], deps)).resolves.toBe(1);
		expect(logError).toHaveBeenCalledWith("Unknown reset option: unsafe");
	});

	it("does not expose account identity in text output", async () => {
		const { deps, logInfo } = createDeps();

		await expect(runResetCommand(["includeSensitive=true"], deps)).resolves.toBe(0);
		expect(logInfo.mock.calls[0]?.[0]).not.toContain("active");
	});
});
