import AppKit
import Foundation
import Testing
@testable import CodexMultiAuthQuota

private let validSnapshotData = Data(#"""
{
  "schemaVersion": 1,
  "accounts": [{
    "index": 0,
    "label": "Personal (a***@example.com)",
    "enabled": true,
    "current": true,
    "quota": null
  }]
}
"""#.utf8)

private let validResetTicketData = Data(#"""
{
  "command": "reset",
  "action": "status",
  "availableCount": 1,
  "credits": [{
    "id": "ticket-1",
    "status": "available",
    "isAvailable": true,
    "expiresAt": "2027-01-01T00:00:00Z"
  }]
}
"""#.utf8)

private let validTwoAccountSnapshotData = Data(#"""
{
  "schemaVersion": 1,
  "accounts": [
    {
      "index": 0,
      "label": "Personal (a***@example.com)",
      "enabled": true,
      "current": true,
      "quota": null
    },
    {
      "index": 1,
      "label": "Personal (b***@example.com)",
      "enabled": true,
      "current": false,
      "quota": null
    }
  ]
}
"""#.utf8)

private let belowLimitSnapshotData = Data(#"""
{
  "schemaVersion": 1,
  "accounts": [{
    "index": 0,
    "label": "Personal (a***@example.com)",
    "enabled": true,
    "current": true,
    "quota": {
      "updatedAt": 1735689600000,
      "status": 200,
      "planType": "plus",
      "primary": { "usedPercent": 47, "windowMinutes": 300, "resetAtMs": null },
      "secondary": { "usedPercent": 72, "windowMinutes": 10080, "resetAtMs": null }
    }
  }]
}
"""#.utf8)

private enum TestCommandError: Error {
    case timedOut
}

private actor RecordingExecutor: QuotaCommandExecuting {
    private(set) var commands: [[String]] = []
    private(set) var timeouts: [Duration] = []
    private var results: [Result<Data, TestCommandError>]

    init(result: Result<Data, TestCommandError>) {
        results = [result]
    }

    init(results: [Result<Data, TestCommandError>]) {
        self.results = results
    }

    func run(arguments: [String], timeout: Duration) async throws -> Data {
        commands.append(arguments)
        timeouts.append(timeout)
        return try results.removeFirst().get()
    }
}

private actor SuspendedExecutor: QuotaCommandExecuting {
    private(set) var commands: [[String]] = []
    private var continuation: CheckedContinuation<Data, Never>?

    func run(arguments: [String], timeout: Duration) async throws -> Data {
        commands.append(arguments)
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func waitUntilInvoked() async {
        while commands.isEmpty {
            await Task.yield()
        }
    }

    func succeed() {
        continuation?.resume(returning: validSnapshotData)
        continuation = nil
    }
}

private actor DelayedQuotaThenResetExecutor: QuotaCommandExecuting {
    private(set) var commands: [[String]] = []
    private var quotaContinuation: CheckedContinuation<Data, Never>?

    func run(arguments: [String], timeout: Duration) async throws -> Data {
        commands.append(arguments)
        if commands.count == 1 {
            return await withCheckedContinuation { continuation in
                quotaContinuation = continuation
            }
        }
        return validResetTicketData
    }

    func waitUntilQuotaRequested() async {
        while commands.isEmpty {
            await Task.yield()
        }
    }

    func completeQuotaLoad() {
        quotaContinuation?.resume(returning: validSnapshotData)
        quotaContinuation = nil
    }
}

private actor CancellationOnResetExecutor: QuotaCommandExecuting {
    private var resetRequested = false

    func run(arguments: [String], timeout: Duration) async throws -> Data {
        if arguments.first == "limits" {
            return validSnapshotData
        }

        resetRequested = true
        while !Task.isCancelled {
            await Task.yield()
        }
        throw CancellationError()
    }

    func waitUntilResetRequested() async {
        while !resetRequested {
            await Task.yield()
        }
    }
}

private actor CancellationOnQuotaExecutor: QuotaCommandExecuting {
    private var quotaRequested = false

    func run(arguments: [String], timeout: Duration) async throws -> Data {
        quotaRequested = true
        while !Task.isCancelled {
            await Task.yield()
        }
        throw CancellationError()
    }

    func waitUntilQuotaRequested() async {
        while !quotaRequested {
            await Task.yield()
        }
    }
}

private actor ResetFailureThenCancellationExecutor: QuotaCommandExecuting {
    private var resetRequestCount = 0

    func run(arguments: [String], timeout: Duration) async throws -> Data {
        if arguments.first == "limits" {
            return validTwoAccountSnapshotData
        }

        resetRequestCount += 1
        if resetRequestCount == 1 {
            throw TestCommandError.timedOut
        }
        while !Task.isCancelled {
            await Task.yield()
        }
        throw CancellationError()
    }

    func waitUntilSecondResetRequested() async {
        while resetRequestCount < 2 {
            await Task.yield()
        }
    }
}

@MainActor
@Test("Terminal AppleScript failure is sanitized and a successful retry clears it")
func terminalFailureIsSanitized() {
    let model = QuotaDashboardModel()
    model.openCodexMultiAuth {
        try executeTerminalScript(NSAppleScript(source: "error \"token-like-secret\" number -1743"))
    }
    #expect(model.terminalErrorMessage == "Terminal을 열지 못했습니다. 시스템 설정의 자동화 권한을 확인한 뒤 다시 시도해 주세요.")
    #expect(model.terminalErrorMessage?.contains("token-like-secret") == false)
    model.openCodexMultiAuth {
        try executeTerminalScript(NSAppleScript(source: "return 1"))
    }
    #expect(model.terminalErrorMessage == nil)
}

@MainActor
@Test("cached update never adds the provider refresh flag")
func cachedUpdateUsesSafeLimitsCommand() async {
    let executor = RecordingExecutor(result: .success(validSnapshotData))
    let model = QuotaDashboardModel(executor: executor)

    await model.loadCached()

    #expect(await executor.commands == [["limits", "--json"]])
    #expect(await executor.timeouts == [.seconds(10)])
}

@MainActor
@Test("opening the dashboard refreshes quota without starting a polling loop")
func openingDashboardUsesTheManualRefreshCommand() async {
    let executor = RecordingExecutor(results: [
        .success(validSnapshotData),
        .success(validResetTicketData),
    ])
    let model = QuotaDashboardModel(executor: executor)

    await model.refreshWhenOpened()

    #expect(await executor.commands == [
        ["limits", "--json", "--refresh"],
        ["reset", "account=1", "format=json"],
    ])
}

@MainActor
@Test("cancelling an open-dashboard refresh does not show a reset ticket error")
func cancellingOpenDashboardRefreshDoesNotShowResetTicketError() async {
    let executor = CancellationOnResetExecutor()
    let model = QuotaDashboardModel(executor: executor)
    let refreshTask = Task { @MainActor in
        await model.refreshWhenOpened()
    }
    await executor.waitUntilResetRequested()

    refreshTask.cancel()
    await refreshTask.value

    #expect(model.resetTicketsErrorMessage == nil)
}

@MainActor
@Test("cancelling an open-dashboard quota refresh does not show a quota error")
func cancellingOpenDashboardRefreshDoesNotShowQuotaError() async {
    let executor = CancellationOnQuotaExecutor()
    let model = QuotaDashboardModel(executor: executor)
    let refreshTask = Task { @MainActor in
        await model.refreshWhenOpened()
    }
    await executor.waitUntilQuotaRequested()

    refreshTask.cancel()
    await refreshTask.value

    #expect(model.errorMessage == nil)
}

@MainActor
@Test("a reset ticket failure remains visible when a later request is cancelled")
func resetTicketFailureRemainsVisibleAfterLaterCancellation() async {
    let executor = ResetFailureThenCancellationExecutor()
    let model = QuotaDashboardModel(executor: executor)
    let refreshTask = Task { @MainActor in
        await model.refreshWhenOpened()
    }
    await executor.waitUntilSecondResetRequested()

    refreshTask.cancel()
    await refreshTask.value

    #expect(model.resetTicketsErrorMessage == "초기화권 정보를 불러오지 못했습니다. 다시 시도해 주세요.")
}

@MainActor
@Test("reset tickets load only through an explicit per-account request")
func resetTicketsUseAccountScopedCommand() async {
    let executor = RecordingExecutor(results: [
        .success(validSnapshotData),
        .success(validResetTicketData),
    ])
    let model = QuotaDashboardModel(executor: executor)

    await model.loadCached()
    await model.loadResetTickets()

    #expect(await executor.commands == [
        ["limits", "--json"],
        ["reset", "account=1", "format=json"],
    ])
    #expect(model.accounts.first?.resetTickets?.availableCount == 1)
}

@MainActor
@Test("reset ticket loading continues after an in-flight quota load")
func resetTicketsWaitForInFlightQuotaLoad() async {
    let executor = DelayedQuotaThenResetExecutor()
    let model = QuotaDashboardModel(executor: executor)
    let cachedLoad = Task { @MainActor in
        await model.loadCached()
    }
    await executor.waitUntilQuotaRequested()

    let ticketLoad = Task { @MainActor in
        await model.loadResetTickets()
    }
    await Task.yield()
    await executor.completeQuotaLoad()
    await cachedLoad.value
    await ticketLoad.value

    #expect(await executor.commands == [
        ["limits", "--json"],
        ["reset", "account=1", "format=json"],
    ])
    #expect(model.accounts.first?.resetTickets?.availableCount == 1)
}

@MainActor
@Test("redeeming a reset ticket targets only the selected account")
func redeemResetTicketUsesSelectedAccount() async throws {
    let executor = RecordingExecutor(results: [
        .success(validSnapshotData),
        .success(validResetTicketData),
        .success(Data(#"{"redeemed":true}"#.utf8)),
        .success(validSnapshotData),
        .success(validResetTicketData),
    ])
    let model = QuotaDashboardModel(executor: executor)
    await model.loadCached()
    await model.loadResetTickets()
    let account = try #require(model.accounts.first)

    await model.redeemResetTicket(for: account)

    #expect(await executor.commands == [
        ["limits", "--json"],
        ["reset", "account=1", "format=json"],
        ["reset", "action=consume", "account=1", "confirm=true", "format=json"],
        ["limits", "--json", "--refresh"],
        ["reset", "account=1", "format=json"],
    ])
}

@MainActor
@Test("a redeemed ticket keeps a runtime restart warning visible")
func redeemResetTicketShowsRuntimeRestartFailure() async throws {
    let executor = RecordingExecutor(results: [
        .success(validSnapshotData),
        .success(validResetTicketData),
        .success(Data(#"{"redeemed":true,"runtimeReset":"failed"}"#.utf8)),
        .success(validSnapshotData),
        .success(validResetTicketData),
    ])
    let model = QuotaDashboardModel(executor: executor)
    await model.loadCached()
    await model.loadResetTickets()
    let account = try #require(model.accounts.first)

    await model.redeemResetTicket(for: account)

    #expect(model.resetTicketsErrorMessage == "초기화권은 사용됐지만 런타임을 재시작하지 못했습니다. Codex를 다시 열어 주세요.")
}

@MainActor
@Test("a reset ticket can be confirmed before an account reaches its quota limit")
func resetTicketConfirmationAllowsBelowLimitAccount() async throws {
    let executor = RecordingExecutor(results: [
        .success(belowLimitSnapshotData),
        .success(validResetTicketData),
    ])
    let model = QuotaDashboardModel(executor: executor)
    await model.loadCached()
    await model.loadResetTickets()
    let account = try #require(model.accounts.first)

    model.requestResetTicketRedemption(for: account)

    #expect(model.resetTicketConfirmationAccount?.index == account.index)
}

@MainActor
@Test("manual refresh retains the last valid snapshot on failure")
func refreshRetainsLastSnapshot() async {
    let executor = RecordingExecutor(results: [
        .success(validSnapshotData),
        .failure(.timedOut),
    ])
    let model = QuotaDashboardModel(executor: executor)

    await model.loadCached()
    await model.refresh()

    #expect(await executor.commands.last == ["limits", "--json", "--refresh"])
    #expect(await executor.timeouts.last == .seconds(30))
    #expect(model.accounts.count == 1)
    #expect(model.errorMessage == "할당량 정보를 불러오지 못했습니다. 다시 시도해 주세요.")
}

@MainActor
@Test("malformed JSON and unsupported schema retain the last successful snapshot", arguments: [
    "token-like-secret is not JSON",
    #"{"schemaVersion":2,"accounts":[]}"#,
])
func invalidSnapshotRetainsLastSnapshot(invalidJSON: String) async {
    let executor = RecordingExecutor(results: [.success(validSnapshotData), .success(Data(invalidJSON.utf8))])
    let model = QuotaDashboardModel(executor: executor)
    await model.loadCached()
    let previousAccounts = model.accounts
    await model.loadCached()
    #expect(model.accounts == previousAccounts)
    #expect(model.errorMessage == "할당량 정보를 불러오지 못했습니다. 다시 시도해 주세요.")
}

@Test("nonzero subprocess exit rejects even apparently valid stdout")
func processExecutorRejectsNonzeroExit() async {
    let executor = ProcessQuotaCommandExecutor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        baseArguments: ["-c", "printf '{\"schemaVersion\":1,\"accounts\":[]}'; exit 7"]
    )
    do {
        _ = try await executor.run(arguments: [], timeout: .seconds(1))
        Issue.record("Expected nonzero exit to fail")
    } catch QuotaCommandError.processFailed {
        // Expected; stdout is unusable when the command fails.
    } catch {
        Issue.record("Expected a sanitized process failure")
    }
}

@Test("cancelling the caller promptly terminates its subprocess")
func processExecutorPropagatesCancellation() async throws {
    let executor = ProcessQuotaCommandExecutor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        baseArguments: ["-c", "trap '' TERM; exec sleep 5"]
    )
    let clock = ContinuousClock()
    let start = clock.now
    let task = Task { try await executor.run(arguments: [], timeout: .seconds(3)) }
    try await Task.sleep(for: .milliseconds(100))
    task.cancel()
    do {
        _ = try await task.value
        Issue.record("Expected cancellation")
    } catch is CancellationError {
        #expect(start.duration(to: clock.now) < .seconds(1))
    } catch {
        Issue.record("Expected cancellation rather than waiting for timeout")
    }
}

@MainActor
@Test("a second update cannot start while another command is in flight")
func updatesAreSerialized() async {
    let executor = SuspendedExecutor()
    let model = QuotaDashboardModel(executor: executor)
    let cachedLoad = Task { @MainActor in
        await model.loadCached()
    }
    await executor.waitUntilInvoked()

    await model.refresh()

    #expect(await executor.commands == [["limits", "--json"]])
    await executor.succeed()
    await cachedLoad.value
}

@Test("process executor returns stdout without command stderr")
func processExecutorIgnoresStderr() async throws {
    let executor = ProcessQuotaCommandExecutor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        baseArguments: ["-c", "printf visible; printf token-like-secret >&2"]
    )

    let output = try await executor.run(arguments: [], timeout: .seconds(1))

    #expect(String(decoding: output, as: UTF8.self) == "visible")
}

@Test("process executor does not wait for a descendant that keeps stdout open")
func processExecutorDoesNotWaitForDescendantStdout() async throws {
    let executor = ProcessQuotaCommandExecutor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        baseArguments: ["-c", "printf visible; (sleep 2) & exit 0"]
    )
    let clock = ContinuousClock()
    let start = clock.now

    let output = try await executor.run(arguments: [], timeout: .seconds(1))

    #expect(String(decoding: output, as: UTF8.self) == "visible")
    #expect(start.duration(to: clock.now) < .seconds(1))
}

@Test("process executor preserves a completed command's buffered stdout")
func processExecutorPreservesCompletedBufferedStdout() async throws {
    let executor = ProcessQuotaCommandExecutor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        baseArguments: ["-c", "dd if=/dev/zero bs=131072 count=1 2>/dev/null | tr '\\0' x"]
    )

    let output = try await executor.run(arguments: [], timeout: .seconds(1))

    #expect(output.count == 131_072)
    #expect(output.allSatisfy { $0 == Character("x").asciiValue })
}

@Test("process executor accepts output that exactly fills its final drain limit")
func processExecutorAcceptsExactFinalDrainLimit() async throws {
    let executor = ProcessQuotaCommandExecutor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        baseArguments: ["-c", "dd if=/dev/zero bs=1048576 count=1 2>/dev/null | tr '\\0' x"]
    )

    let output = try await executor.run(arguments: [], timeout: .seconds(2))

    #expect(output.count == 1_048_576)
}

@Test("process executor enforces its timeout when stdout never stops")
func processExecutorTimesOutWithContinuousStdout() async {
    let executor = ProcessQuotaCommandExecutor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        baseArguments: ["-c", "while :; do printf x; done"]
    )
    let clock = ContinuousClock()
    let start = clock.now

    do {
        _ = try await executor.run(arguments: [], timeout: .milliseconds(100))
        Issue.record("Expected continuous stdout to time out")
    } catch QuotaCommandError.timedOut {
        #expect(start.duration(to: clock.now) < .seconds(1))
    } catch {
        Issue.record("Expected a timeout error")
    }
}

@Test("companion supplies a parent-bound setup bypass only to its quota subprocess")
func processExecutorSuppliesCompanionSignal() async throws {
    let executor = ProcessQuotaCommandExecutor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        baseArguments: ["-c", "printf '%s' \"$CODEX_MULTI_AUTH_QUOTA_PARENT_PID\""]
    )
    let output = try await executor.run(arguments: ["limits", "--json"], timeout: .seconds(1))
    #expect(String(decoding: output, as: UTF8.self) == String(ProcessInfo.processInfo.processIdentifier))
    #expect(ProcessInfo.processInfo.environment["CODEX_MULTI_AUTH_QUOTA_PARENT_PID"] == nil)
}

@Test("process executor terminates a command at its deadline")
func processExecutorTimesOut() async {
    let executor = ProcessQuotaCommandExecutor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        baseArguments: ["-c", "sleep 5"]
    )

    do {
        _ = try await executor.run(arguments: [], timeout: .milliseconds(100))
        Issue.record("Expected the command to time out")
    } catch QuotaCommandError.timedOut {
        // Expected.
    } catch {
        Issue.record("Expected a timeout error")
    }
}

@Test("timeout remains bounded when a command ignores graceful termination")
func processExecutorForceTerminatesAfterTimeout() async {
    let executor = ProcessQuotaCommandExecutor(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        baseArguments: ["-c", "trap '' TERM; sleep 5"]
    )
    let clock = ContinuousClock()
    let start = clock.now

    do {
        _ = try await executor.run(arguments: [], timeout: .milliseconds(100))
        Issue.record("Expected the command to time out")
    } catch QuotaCommandError.timedOut {
        #expect(start.duration(to: clock.now) < .seconds(1))
    } catch {
        Issue.record("Expected a timeout error")
    }
}
