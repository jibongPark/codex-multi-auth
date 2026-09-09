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
