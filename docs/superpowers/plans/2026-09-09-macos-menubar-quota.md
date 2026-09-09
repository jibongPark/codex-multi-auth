# macOS Menu Bar Quota Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Add an optional native macOS menu bar application that shows the configured active account and safe per-account quota windows from codex-multi-auth.

**Architecture:** A SwiftUI/AppKit \`LSUIElement\` application runs as a status-bar companion and obtains all display data by invoking the documented \`codex-multi-auth limits --json\` contract. A TypeScript \`menubar\` CLI command owns app assembly, ad-hoc signing, \`~/Applications\` installation, LaunchAgent registration, and scoped removal; it never touches account storage or the official Codex application.

**Tech Stack:** TypeScript/Node 18, Vitest, Swift 5.9+/SwiftUI/AppKit, Swift Package Manager, macOS 13+, launchd.

**Spec:** \`docs/superpowers/specs/2026-09-09-macos-menubar-quota-design.md\`

## Global Constraints

- macOS companion supports macOS 13 and later only; the CLI reports an error without writes on other platforms.
- The app reads only \`codex-multi-auth limits --json\` and \`codex-multi-auth limits --json --refresh\`; it must not read OAuth/account/cache files directly.
- Render only the CLI-provided masked account label. Never log or display credentials, account IDs, raw JSON errors, or command stderr.
- Background reads are cache-only and occur at most once every 60 seconds; only the explicit refresh action can invoke \`--refresh\`.
- \`current\` means the configured routing target, not a guarantee of the next live routed request.
- Installation targets only \`~/Applications/Codex Multi Auth Quota.app\` and \`~/Library/LaunchAgents/com.ndycode.codex-multi-auth-quota.plist\`; uninstall leaves account state and the official Codex app untouched.
- Avoid Electron, Tauri, browser runtimes, and new runtime npm dependencies.

---

## File Structure

- \`apps/macos-menubar/Package.swift\` — Swift package and macOS deployment target.
- \`apps/macos-menubar/Sources/CodexMultiAuthQuota/QuotaSnapshot.swift\` — limits-contract models, validation, ordering, and formatting.
- \`apps/macos-menubar/Sources/CodexMultiAuthQuota/QuotaCommandRunner.swift\` — serialized CLI process execution with timeouts and stale-snapshot retention.
- \`apps/macos-menubar/Sources/CodexMultiAuthQuota/CodexMultiAuthQuotaApp.swift\` — status item, timer, and accessibility metadata.
- \`apps/macos-menubar/Sources/CodexMultiAuthQuota/QuotaPopoverView.swift\` — Korean SwiftUI quota-only interface.
- \`apps/macos-menubar/Tests/CodexMultiAuthQuotaTests/*.swift\` — model and runner tests.
- \`lib/codex-manager/commands/menubar.ts\` — platform-gated install/uninstall/status command with injected effects.
- \`test/menubar-command.test.ts\` — CLI parser, install plan, cleanup, and platform tests.
- \`lib/codex-manager.ts\`, \`scripts/codex-routing.js\`, \`package.json\` — command registration, standalone routing, npm artifact inclusion.
- \`README.md\`, \`docs/reference/commands.md\`, \`docs/reference/storage-paths.md\` — setup, safety, and removal documentation.

## Task 1: Build a tested safe quota snapshot model

**Files:**
- Create: \`apps/macos-menubar/Package.swift\`
- Create: \`apps/macos-menubar/Sources/CodexMultiAuthQuota/QuotaSnapshot.swift\`
- Create: \`apps/macos-menubar/Tests/CodexMultiAuthQuotaTests/QuotaSnapshotTests.swift\`

**Interfaces:**
- Consumes: schema-version-1 JSON emitted by \`codex-multi-auth limits --json\`.
- Produces: \`QuotaSnapshot.decode(data: Data) throws -> QuotaSnapshot\`, \`QuotaSnapshot.displayAccounts(now: Date) -> [QuotaDisplayAccount]\`, and \`QuotaWindowDisplay\`.

- [ ] **Step 1: Write the failing Swift model tests**

\`\`\`swift
@Test("places the configured current account before every other account")
func currentAccountIsFirst() throws {
    let snapshot = try QuotaSnapshot.decode(data: fixture(validLimitsJSON))
    #expect(snapshot.displayAccounts(now: .now).map(\.label) == [
        "Personal (a***@example.com)", "Work (b***@example.com)"
    ])
}

@Test("rejects a limits schema version the companion does not support")
func rejectsUnknownSchemaVersion() {
    #expect(throws: QuotaSnapshotError.unsupportedSchemaVersion(2)) {
        try QuotaSnapshot.decode(data: fixture("{\"schemaVersion\":2,\"accounts\":[]}"))
    }
}

@Test("converts used quota to remaining percentage")
func formatsQuotaWindow() {
    let window = QuotaWindow(usedPercent: 25, windowMinutes: 300, resetAtMs: nil)
    #expect(window.display(now: .now).remainingPercent == 75)
    #expect(window.display(now: .now).resetText == nil)
}
\`\`\`

- [ ] **Step 2: Run test to verify it fails**

Run: \`cd apps/macos-menubar && swift test --filter QuotaSnapshotTests\`

Expected: FAIL because the model does not exist.

- [ ] **Step 3: Write minimal implementation**

\`\`\`swift
enum QuotaSnapshotError: Error, Equatable {
    case unsupportedSchemaVersion(Int)
}

struct QuotaSnapshot: Decodable, Equatable {
    let schemaVersion: Int
    let accounts: [QuotaAccount]

    static func decode(data: Data) throws -> QuotaSnapshot {
        let snapshot = try JSONDecoder().decode(QuotaSnapshot.self, from: data)
        guard snapshot.schemaVersion == 1 else {
            throw QuotaSnapshotError.unsupportedSchemaVersion(snapshot.schemaVersion)
        }
        return snapshot
    }

    func displayAccounts(now: Date) -> [QuotaDisplayAccount] {
        accounts.sorted { $0.current && !$1.current }
            .map { QuotaDisplayAccount(account: $0, now: now) }
    }
}
\`\`\`

Define nullable \`quota\`, \`primary\`, and \`secondary\` models; clamp remaining percentage to 0...100; map 300 minutes to \`5시간\`, 10080 to \`7일\`; omit only the reset text when \`resetAtMs\` is absent.

- [ ] **Step 4: Run test to verify it passes**

Run: \`cd apps/macos-menubar && swift test --filter QuotaSnapshotTests\`

Expected: PASS for current ordering, schema rejection, null quota, disabled state, percentage clamp, and reset countdown.

- [ ] **Step 5: Commit**

\`\`\`bash
git add apps/macos-menubar/Package.swift apps/macos-menubar/Sources/CodexMultiAuthQuota/QuotaSnapshot.swift apps/macos-menubar/Tests/CodexMultiAuthQuotaTests/QuotaSnapshotTests.swift
git commit -m "feat: add macOS quota snapshot model"
\`\`\`

## Task 2: Implement native menu bar UI and command refresh

**Files:**
- Create: \`apps/macos-menubar/Sources/CodexMultiAuthQuota/QuotaCommandRunner.swift\`
- Create: \`apps/macos-menubar/Sources/CodexMultiAuthQuota/CodexMultiAuthQuotaApp.swift\`
- Create: \`apps/macos-menubar/Sources/CodexMultiAuthQuota/QuotaPopoverView.swift\`
- Create: \`apps/macos-menubar/Tests/CodexMultiAuthQuotaTests/QuotaCommandRunnerTests.swift\`

**Interfaces:**
- Consumes: \`QuotaSnapshot.decode(data:)\`.
- Produces: \`QuotaDashboardModel.loadCached() async\`, \`refresh() async\`, \`accounts\`, \`errorMessage\`, and \`CodexMultiAuthQuotaApp\`.

- [ ] **Step 1: Write failing runner tests**

\`\`\`swift
@Test("cached update never adds the provider refresh flag")
func cachedUpdateUsesSafeLimitsCommand() async {
    let executor = RecordingExecutor(result: .success(validSnapshotData))
    let model = QuotaDashboardModel(executor: executor)
    await model.loadCached()
    #expect(await executor.commands == [["limits", "--json"]])
}

@Test("manual refresh retains the last valid snapshot on failure")
func refreshRetainsLastSnapshot() async {
    let executor = RecordingExecutor(results: [.success(validSnapshotData), .failure(.timedOut)])
    let model = QuotaDashboardModel(executor: executor)
    await model.loadCached()
    await model.refresh()
    #expect(await executor.commands.last == ["limits", "--json", "--refresh"])
    #expect(model.accounts.count == 1)
    #expect(model.errorMessage != nil)
}
\`\`\`

- [ ] **Step 2: Run test to verify it fails**

Run: \`cd apps/macos-menubar && swift test --filter QuotaCommandRunnerTests\`

Expected: FAIL because the command executor and dashboard model do not exist.

- [ ] **Step 3: Write minimal implementation**

\`\`\`swift
protocol QuotaCommandExecuting: Sendable {
    func run(arguments: [String], timeout: Duration) async throws -> Data
}

@MainActor
final class QuotaDashboardModel: ObservableObject {
    @Published private(set) var accounts: [QuotaDisplayAccount] = []
    @Published private(set) var errorMessage: String?
    @Published private(set) var isRefreshing = false

    func loadCached() async { await load(arguments: ["limits", "--json"], timeout: .seconds(10)) }
    func refresh() async { await load(arguments: ["limits", "--json", "--refresh"], timeout: .seconds(30)) }
}
\`\`\`

Use one in-flight guard. Decode stdout only; map process, timeout, and decode failures to \`할당량 정보를 불러오지 못했습니다. 다시 시도해 주세요.\` while retaining prior rows. Implement an \`LSUIElement\` status-bar app with a gauge icon and accessibility label \`Codex Multi Auth quota dashboard\`. Render current account, dimmed \`비활성\` rows, bars, \`새로고침\`, \`Codex Multi Auth 열기\`, and \`종료\`; do not render stderr. Execute a cached load on app start and every 60 seconds, and update visible countdowns every minute.

- [ ] **Step 4: Run tests and smoke build**

Run: \`cd apps/macos-menubar && swift test && swift build -c release\`

Expected: PASS. Launch against a fixture executable and confirm with Accessibility Inspector that the status item exposes its required label and no token-like fixture text appears in the popover.

- [ ] **Step 5: Commit**

\`\`\`bash
git add apps/macos-menubar
git commit -m "feat: add macOS quota menu bar app"
\`\`\`

## Task 3: Add platform-scoped installation and removal

**Files:**
- Create: \`lib/codex-manager/commands/menubar.ts\`
- Create: \`test/menubar-command.test.ts\`
- Modify: \`lib/codex-manager.ts\`
- Modify: \`scripts/codex-routing.js\`
- Modify: \`package.json\`

**Interfaces:**
- Consumes: the Task 2 release binary.
- Produces: \`runMenubarCommand(args: string[], deps?: MenubarCommandDeps): Promise<number>\` for \`codex-multi-auth menubar <install|uninstall|status>\`.

- [ ] **Step 1: Write failing TypeScript tests**

\`\`\`ts
it("installs only the companion app and LaunchAgent on macOS", async () => {
  const effects = createMenubarEffects({ platform: "darwin", home: "/Users/test", uid: 501 });
  await runMenubarCommand(["install"], effects.deps);
  expect(effects.createdPaths).toEqual([
    "/Users/test/Applications/Codex Multi Auth Quota.app/Contents/MacOS/CodexMultiAuthQuota",
    "/Users/test/Library/LaunchAgents/com.ndycode.codex-multi-auth-quota.plist",
  ]);
  expect(effects.commands).toContainEqual([
    "launchctl", "bootstrap", "gui/501",
    "/Users/test/Library/LaunchAgents/com.ndycode.codex-multi-auth-quota.plist",
  ]);
});

it("does not write files when run on Linux", async () => {
  const effects = createMenubarEffects({ platform: "linux" });
  await expect(runMenubarCommand(["install"], effects.deps)).resolves.toBe(1);
  expect(effects.createdPaths).toEqual([]);
});
\`\`\`

- [ ] **Step 2: Run test to verify it fails**

Run: \`npx vitest run test/menubar-command.test.ts --maxWorkers=1\`

Expected: FAIL because the command module and registry entry do not exist.

- [ ] **Step 3: Write minimal implementation**

\`\`\`ts
export type MenubarCommandDeps = {
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  packageRoot?: string;
  run?: (file: string, args: string[]) => Promise<void>;
  writeFile?: typeof writeFile;
  copyFile?: typeof copyFile;
  mkdir?: typeof mkdir;
  rm?: typeof rm;
};

export async function runMenubarCommand(
  args: string[],
  deps: MenubarCommandDeps = {},
): Promise<number> {
  // parse install | uninstall | status and gate to darwin
}
\`\`\`

\`install\` runs Swift Package Manager inside the packaged source, creates only the fixed app-bundle path, copies its binary, writes \`Info.plist\`, ad-hoc signs it with \`codesign --force --sign -\`, writes a \`RunAtLoad=true\` plist, bootstraps it with \`launchctl\`, and opens it. \`status\` reads only those app/plist paths. \`uninstall\` bootouts that exact plist and removes only those exact targets with the existing retry helper. Register \`menubar\` in the manager map and \`AUTH_SUBCOMMANDS\`; add \`apps/macos-menubar/\` to npm's \`files\` list.

- [ ] **Step 4: Run tests, typecheck, and build**

Run: \`npx vitest run test/menubar-command.test.ts --maxWorkers=1 && npm run typecheck && npm run build\`

Expected: PASS. Both standalone and namespaced command forms route successfully. Non-macOS install has no effects.

- [ ] **Step 5: Commit**

\`\`\`bash
git add lib/codex-manager.ts lib/codex-manager/commands/menubar.ts scripts/codex-routing.js package.json test/menubar-command.test.ts
git commit -m "feat: install macOS quota menu bar companion"
\`\`\`

## Task 4: Document, verify, and publish a new GitHub repository

**Files:**
- Modify: \`README.md\`
- Modify: \`docs/reference/commands.md\`
- Modify: \`docs/reference/storage-paths.md\`

**Interfaces:**
- Consumes: \`codex-multi-auth menubar install|status|uninstall\`.
- Produces: documented setup/removal and a new GitHub repository with the complete implementation history.

- [ ] **Step 1: Write documentation-parity test**

\`\`\`ts
it("documents every menu bar command and manual quota refresh", async () => {
  const readme = await readFile("README.md", "utf8");
  const commands = await readFile("docs/reference/commands.md", "utf8");
  expect(readme).toContain("codex-multi-auth menubar install");
  expect(commands).toContain("codex-multi-auth menubar uninstall");
  expect(commands).toContain("manual");
});
\`\`\`

- [ ] **Step 2: Run test to verify it fails**

Run: \`npx vitest run test/documentation.test.ts --maxWorkers=1\`

Expected: FAIL until command documentation is present.

- [ ] **Step 3: Add documentation**

Document macOS 13+, Swift/Xcode command-line-tools prerequisite, login launch, app/LaunchAgent paths, masked-label privacy boundary, 60-second cached reads, manual refresh, and scoped uninstall that preserves account data and Codex.

- [ ] **Step 4: Run full verification**

Run: \`npm test && npm run lint && npm run typecheck && npm run build && npm run pack:check && (cd apps/macos-menubar && swift test && swift build -c release)\`

Expected: every command exits 0. Manually smoke-test install, launch, active-account/quota rendering, manual refresh, and uninstall against a fixture CLI; verify only the companion app and its LaunchAgent are removed.

- [ ] **Step 5: Commit and publish**

\`\`\`bash
git add README.md docs/reference/commands.md docs/reference/storage-paths.md
git commit -m "docs: document macOS quota menu bar dashboard"

git remote add menubar-origin "https://github.com/<authenticated-owner>/codex-multi-auth-menubar.git"
git push -u menubar-origin main
git ls-remote menubar-origin HEAD
\`\`\`

Create \`codex-multi-auth-menubar\` under the authenticated GitHub account, describing it as a macOS quota dashboard companion for codex-multi-auth. Do not push credentials, \`.build\` products, generated \`dist/\`, account files, or user-specific app data.

## Plan Self-Review

- **Spec coverage:** Tasks 1–2 cover quota-only UI, masked labels, active account, cached refresh, manual refresh, and stale-state errors. Task 3 covers macOS-only install/login launch/scoped removal. Task 4 covers docs, validation, and GitHub publication.
- **Placeholder scan:** The owner placeholder appears only in the illustrative remote-add command; execution resolves the authenticated GitHub identity before creating the repository.
- **Type consistency:** Task 1 defines every Swift model Task 2 consumes. Task 3 defines \`MenubarCommandDeps\` and \`runMenubarCommand\`, which its tests and CLI registry consume.

