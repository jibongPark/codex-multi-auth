import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { withFileOperationRetry } from "../../fs-retry.js";

const APP_NAME = "Codex Multi Auth Quota.app";
const EXECUTABLE = "CodexMultiAuthQuota";
const LABEL = "com.ndycode.codex-multi-auth-quota";
const USAGE = "Usage: codex-multi-auth menubar <install|uninstall|status>";

export type MenubarCommandDeps = {
	platform?: NodeJS.Platform;
	home?: string;
	uid?: number;
	packageRoot?: string;
	execPath?: string;
	path?: string;
	run?: (file: string, args: string[]) => Promise<void>;
	writeFile?: (path: string, contents: string) => Promise<void>;
	readFile?: (path: string) => Promise<Buffer>;
	copyFile?: (source: string, destination: string) => Promise<void>;
	mkdir?: (path: string, options: { recursive: true }) => Promise<unknown>;
	rm?: (path: string, options: { recursive: boolean; force: true }) => Promise<void>;
	exists?: (path: string) => Promise<boolean>;
	log?: (message: string) => void;
};

function runProcess(file: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, { stdio: "inherit", shell: false });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(Object.assign(new Error(`${file} failed (${signal ?? code})`), { code }));
		});
	});
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function xml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function plistDocument(contents: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${contents}\n</dict></plist>\n`;
}

export async function runMenubarCommand(args: string[], deps: MenubarCommandDeps = {}): Promise<number> {
	const log = deps.log ?? console.log;
	if ((deps.platform ?? process.platform) !== "darwin") {
		log("The menubar companion is supported only on macOS.");
		return 1;
	}
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		log(USAGE);
		return 0;
	}
	const [action] = args;
	if (args.length !== 1 || !action || !["install", "uninstall", "status"].includes(action)) {
		log(USAGE);
		return 1;
	}
	const home = deps.home ?? homedir();
	const app = join(home, "Applications", APP_NAME);
	const agent = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
	const exists = deps.exists ?? pathExists;
	try {
		if (action === "status") {
			const appExists = await exists(app);
			const agentExists = await exists(agent);
			log(`Menu bar app: ${appExists ? "installed" : "not installed"}\nLogin agent: ${agentExists ? "installed" : "not installed"}`);
			return 0;
		}
		const uid = deps.uid ?? process.getuid?.();
		if (uid === undefined || !Number.isInteger(uid) || uid < 0) throw new Error("Cannot determine the macOS user ID.");
		const run = deps.run ?? runProcess;
		const bootout = async () => {
			if (!(await exists(agent))) return;
			try {
				await run("launchctl", ["bootout", `gui/${uid}`, agent]);
			} catch (error) {
				// ESRCH means the plist remains but its service is no longer loaded.
				if (!(error instanceof Error && "code" in error && error.code === 3)) throw error;
			}
		};
		if (action === "uninstall") {
			await bootout();
			const remove = deps.rm ?? rm;
			await withFileOperationRetry(() => remove(app, { recursive: true, force: true }));
			await withFileOperationRetry(() => remove(agent, { recursive: false, force: true }));
			log("Menu bar companion uninstalled. Accounts and Codex are preserved.");
			return 0;
		}
		const packageRoot = deps.packageRoot ?? dirname(createRequire(import.meta.url).resolve("codex-multi-auth/package.json"));
		const source = join(packageRoot, "apps", "macos-menubar");
		await run("swift", ["build", "--package-path", source, "--configuration", "release", "--product", EXECUTABLE]);
		const read = deps.readFile ?? readFile;
		const packageInfo: { version?: unknown } = JSON.parse((await read(join(packageRoot, "package.json"))).toString("utf8"));
		if (typeof packageInfo.version !== "string" || !packageInfo.version.trim()) throw new Error("Package version is unavailable.");
		const sourceBinary = join(source, ".build", "release", EXECUTABLE);
		const digest = createHash("sha256").update(await read(sourceBinary)).digest("hex");
		const infoPath = join(app, "Contents", "Info.plist");
		const info = plistDocument(`<key>CFBundleIdentifier</key><string>${LABEL}</string>\n<key>CFBundleName</key><string>Codex Multi Auth Quota</string>\n<key>CFBundleExecutable</key><string>${EXECUTABLE}</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>CFBundleShortVersionString</key><string>${xml(packageInfo.version)}</string>\n<key>CFBundleVersion</key><string>${xml(packageInfo.version)}</string>\n<key>CodexMultiAuthBuildDigest</key><string>${digest}</string>\n<key>LSUIElement</key><true/>\n<key>NSAppleEventsUsageDescription</key><string>Opens Codex Multi Auth in Terminal when you choose Open Codex Multi Auth.</string>`);
		const installed = await exists(app);
		const current = installed && await exists(infoPath) && (await read(infoPath)).toString("utf8") === info;
		await bootout();
		const makeDirectory = deps.mkdir ?? mkdir;
		const write = deps.writeFile ?? writeFile;
		const binary = join(app, "Contents", "MacOS", EXECUTABLE);
		await makeDirectory(dirname(binary), { recursive: true });
		await (deps.copyFile ?? copyFile)(sourceBinary, binary);
		await write(infoPath, info);
		await run("codesign", ["--force", "--sign", "-", app]);
		// Preserve custom npm/version-manager bins for launchd's clean environment.
		const npmModules = dirname(packageRoot);
		const npmBin = basename(npmModules) === "node_modules" && basename(dirname(npmModules)) === "lib"
			? resolve(npmModules, "..", "..", "bin") : "";
		const path = [...new Set([dirname(deps.execPath ?? process.execPath), npmBin, ...(deps.path ?? process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean))].join(":");
		await makeDirectory(dirname(agent), { recursive: true });
		await write(agent, plistDocument(`<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array><string>${xml(binary)}</string></array>\n<key>RunAtLoad</key><true/>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>`));
		await run("launchctl", ["bootstrap", `gui/${uid}`, agent]);
		await run("open", [app]);
		log(current
			? "Menu bar companion already current; installation and login startup renewed."
			: `Menu bar companion ${installed ? "updated" : "installed"} and configured to start at login.`);
		return 0;
	} catch (error) {
		log(`Menu bar ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
