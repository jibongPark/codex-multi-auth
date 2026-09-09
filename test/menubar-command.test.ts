import { afterEach, describe, expect, it, vi } from "vitest";
import { runMenubarCommand, type MenubarCommandDeps } from "../lib/codex-manager/commands/menubar.js";
import { shouldHandleMultiAuthAuth } from "../scripts/codex-routing.js";

const app = "/Users/test/Applications/Codex Multi Auth Quota.app";
const plist = "/Users/test/Library/LaunchAgents/com.ndycode.codex-multi-auth-quota.plist";
const startup = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../lib/runtime/first-run.js", () => ({ ensureFirstRunSetup: startup }));
vi.mock("../lib/storage.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../lib/storage.js")>(),
	loadAccounts: async () => null,
}));

function createMenubarEffects(overrides: MenubarCommandDeps = {}) {
	const commands: string[][] = [];
	const writes = new Map<string, string>();
	const copies: string[][] = [];
	const directories: string[] = [];
	const removed: string[] = [];
	const reads: string[] = [];
	const logs: string[] = [];
	const deps: MenubarCommandDeps = {
		platform: "darwin", home: "/Users/test", uid: 501,
		packageRoot: "/opt/custom/lib/node_modules/codex-multi-auth",
		execPath: "/opt/node/bin/node", path: "/custom/npm/bin:/usr/bin",
		run: async (file, args) => { commands.push([file, ...args]); },
		writeFile: async (path, contents) => { writes.set(path, contents); },
		readFile: async (path) => Buffer.from(path.endsWith("package.json") ? '{"version":"2.14.0"}' : writes.get(path) ?? "binary-v1"),
		copyFile: async (source, destination) => { copies.push([source, destination]); },
		mkdir: async (path) => { directories.push(path); },
		rm: async (path) => { removed.push(path); },
		exists: async (path) => { reads.push(path); return true; },
		log: (message) => { logs.push(message); },
		...overrides,
	};
	return { deps, commands, writes, copies, directories, removed, reads, logs };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("menubar command", () => {
	it("reports first install, already-current reinstall, and changed-build update from durable metadata", async () => {
		const e = createMenubarEffects();
		e.deps.exists = async (path) => e.writes.has(path) || e.copies.some(([, destination]) => destination === path || destination?.startsWith(`${path}/`));
		expect(await runMenubarCommand(["install"], e.deps)).toBe(0);
		expect(e.logs.at(-1)).toContain("companion installed");
		const metadata = e.writes.get(`${app}/Contents/Info.plist`);
		expect(metadata).toContain("<key>CFBundleShortVersionString</key><string>2.14.0</string>");
		expect(metadata).toMatch(/<key>CodexMultiAuthBuildDigest<\/key><string>[a-f0-9]{64}<\/string>/);
		expect(await runMenubarCommand(["install"], e.deps)).toBe(0);
		expect(e.logs.at(-1)).toContain("already current");
		e.deps.readFile = async (path) => Buffer.from(path.endsWith("package.json") ? '{"version":"2.14.0"}' : e.writes.get(path) ?? "binary-v2");
		expect(await runMenubarCommand(["install"], e.deps)).toBe(0);
		expect(e.logs.at(-1)).toContain("companion updated");
		expect(e.writes.get(`${app}/Contents/Info.plist`)).not.toBe(metadata);
		expect(e.commands.filter(([file]) => file === "codesign")).toHaveLength(3);
		expect(e.commands.filter(([file, action]) => file === "launchctl" && action === "bootstrap")).toHaveLength(3);
	});

	it.each([["limits", "--json"], ["auth", "limits", "--json"], ["auth", "limits", "--json", "--refresh"]])("initial companion read %j skips first-run setup and returns empty-pool JSON", async (...args) => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		vi.stubEnv("CODEX_MULTI_AUTH_QUOTA_PARENT_PID", String(process.ppid));
		startup.mockClear();
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		expect(await runCodexMultiAuthCli(args)).toBe(0);
		expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ schemaVersion: 1, accounts: [] });
		expect(startup).not.toHaveBeenCalled();
		expect(process.env.CODEX_MULTI_AUTH_QUOTA_PARENT_PID).toBeUndefined();
	});

	it.each([
		{ args: ["limits", "--json"], signal: undefined },
		{ args: ["auth", "limits", "--json"], signal: undefined },
		{ args: ["limits", "--json"], signal: "1" },
		{ args: ["limits", "--json"], signal: "invalid" },
		{ args: ["limits", "--help"], signal: "parent" },
		{ args: ["limits", "--json", "--help"], signal: "parent" },
		{ args: ["--help"], signal: "parent" },
	])("preserves ordinary setup for $args with signal $signal", async ({ args, signal }) => {
		vi.stubEnv("CODEX_MULTI_AUTH_QUOTA_PARENT_PID", signal === "parent" ? String(process.ppid) : signal);
		startup.mockClear();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		expect(await runCodexMultiAuthCli(args)).toBe(0);
		expect(startup).toHaveBeenCalledOnce();
	});

	it("builds, signs, and starts only the companion bundle and login agent", async () => {
		const e = createMenubarEffects();
		expect(await runMenubarCommand(["install"], e.deps)).toBe(0);
		expect(e.commands[0]).toEqual(["swift", "build", "--package-path", "/opt/custom/lib/node_modules/codex-multi-auth/apps/macos-menubar", "--configuration", "release", "--product", "CodexMultiAuthQuota"]);
		expect(e.copies).toEqual([["/opt/custom/lib/node_modules/codex-multi-auth/apps/macos-menubar/.build/release/CodexMultiAuthQuota", `${app}/Contents/MacOS/CodexMultiAuthQuota`]]);
		expect([...e.writes.keys()]).toEqual([`${app}/Contents/Info.plist`, plist]);
		expect(e.writes.get(`${app}/Contents/Info.plist`)).toMatch(/<key>LSUIElement<\/key>\s*<true\/>/);
		expect(e.writes.get(`${app}/Contents/Info.plist`)).toContain("<key>NSAppleEventsUsageDescription</key><string>Opens Codex Multi Auth in Terminal when you choose Open Codex Multi Auth.</string>");
		expect(e.writes.get(plist)).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
		expect(e.writes.get(plist)).toContain(`${app}/Contents/MacOS/CodexMultiAuthQuota`);
		for (const bin of ["/custom/npm/bin", "/opt/custom/bin", "/opt/node/bin", "/usr/bin"]) expect(e.writes.get(plist)).toContain(bin);
		expect(e.commands).toContainEqual(["codesign", "--force", "--sign", "-", app]);
		expect(e.commands).toContainEqual(["launchctl", "bootstrap", "gui/501", plist]);
		expect(e.commands.at(-1)).toEqual(["open", app]);
		expect(e.directories).toEqual([`${app}/Contents/MacOS`, "/Users/test/Library/LaunchAgents"]);
		expect(e.removed).toEqual([]);
	});

	it.each(["linux", "win32"] as const)("has no filesystem/process effects on %s", async (platform) => {
		for (const action of ["install", "uninstall", "status"]) {
			const e = createMenubarEffects({ platform });
			expect(await runMenubarCommand([action], e.deps)).toBe(1);
			expect([e.commands, e.copies, e.directories, e.removed, e.reads, [...e.writes]]).toEqual([[], [], [], [], [], []]);
		}
	});

	it.each([[], ["other"], ["uninstall", "/Users/test/.codex"]])("rejects unsupported arguments %j before effects", async (...args) => {
		const e = createMenubarEffects();
		expect(await runMenubarCommand(args, e.deps)).toBe(1);
		expect([e.commands, e.reads, e.removed, [...e.writes]]).toEqual([[], [], [], []]);
	});

	it.each([true, false])("status reports presence %s using only the two fixed existence checks", async (present) => {
		const e = createMenubarEffects();
		e.deps.exists = async (path) => { e.reads.push(path); return present; };
		expect(await runMenubarCommand(["status"], e.deps)).toBe(0);
		expect(e.reads).toEqual([app, plist]);
		expect(e.logs.join("\n")).toContain(present ? "installed" : "not installed");
		expect([e.commands, e.copies, e.directories, e.removed, [...e.writes]]).toEqual([[], [], [], [], []]);
	});

	it("escapes paths in generated XML", async () => {
		const e = createMenubarEffects({ home: "/Users/A&B", path: "/bin/<tools>" });
		expect(await runMenubarCommand(["install"], e.deps)).toBe(0);
		const xml = [...e.writes.values()].join("\n");
		expect(xml).toContain("/Users/A&amp;B/");
		expect(xml).toContain("/bin/&lt;tools&gt;");
	});

	it("bootouts and retries removal only of the fixed companion targets", async () => {
		vi.useFakeTimers();
		const e = createMenubarEffects();
		let attempts = 0;
		e.deps.rm = async (path) => {
			e.removed.push(path);
			if (attempts++ === 0) throw Object.assign(new Error("locked"), { code: "EBUSY" });
		};
		const result = runMenubarCommand(["uninstall"], e.deps);
		await vi.runAllTimersAsync();
		expect(await result).toBe(0);
		expect(e.commands).toEqual([["launchctl", "bootout", "gui/501", plist]]);
		expect(e.removed).toEqual([app, app, plist]);
		expect([...e.writes]).toEqual([]);
	});

	it("allows uninstall when launchd reports the service is already absent", async () => {
		const e = createMenubarEffects({ run: async () => { throw Object.assign(new Error("No such process"), { code: 3 }); } });
		expect(await runMenubarCommand(["uninstall"], e.deps)).toBe(0);
		expect(e.removed).toEqual([app, plist]);
	});

	it("reports a failed build without creating installed files", async () => {
		const e = createMenubarEffects({ run: async () => { throw new Error("Swift compiler unavailable"); } });
		expect(await runMenubarCommand(["install"], e.deps)).toBe(1);
		expect([e.copies, e.directories, [...e.writes]]).toEqual([[], [], []]);
		expect(e.logs.join("\n")).toContain("Swift compiler unavailable");
	});

	it("routes the auth-namespaced wrapper command locally", () => {
		expect(shouldHandleMultiAuthAuth(["auth", "menubar", "status"])).toBe(true);
	});

	it.each([["menubar", "--help"], ["auth", "menubar", "--help"]])("dispatches %j without first-run housekeeping", async (...args) => {
		startup.mockClear();
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		expect(await runCodexMultiAuthCli(args)).toBe(process.platform === "darwin" ? 0 : 1);
		expect(output.mock.calls.flat().join("\n")).toContain("menubar");
		expect(startup).not.toHaveBeenCalled();
	});
});
