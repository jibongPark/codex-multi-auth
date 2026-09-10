import AppKit
import Combine
import Darwin
import Foundation

protocol QuotaCommandExecuting: Sendable {
    func run(arguments: [String], timeout: Duration) async throws -> Data
}

enum QuotaCommandError: Error {
    case processFailed
    case timedOut
}

@MainActor
func executeTerminalScript(_ script: NSAppleScript?) throws {
    guard let script else { throw QuotaCommandError.processFailed }
    var error: NSDictionary?
    script.executeAndReturnError(&error)
    guard error == nil else { throw QuotaCommandError.processFailed }
}

struct ProcessQuotaCommandExecutor: QuotaCommandExecuting {
    private let executableURL: URL
    private let baseArguments: [String]

    init(
        executableURL: URL = URL(fileURLWithPath: "/usr/bin/env"),
        baseArguments: [String] = ["codex-multi-auth"]
    ) {
        self.executableURL = executableURL
        self.baseArguments = baseArguments
    }

    func run(arguments: [String], timeout: Duration) async throws -> Data {
        let executableURL = executableURL
        let commandArguments = baseArguments + arguments

        let task = Task.detached(priority: .userInitiated) {
            try Task.checkCancellation()
            let process = Process()
            let stdout = Pipe()
            let output = LockedDataBuffer()
            process.executableURL = executableURL
            process.arguments = commandArguments
            var environment = ProcessInfo.processInfo.environment
            environment["CODEX_MULTI_AUTH_QUOTA_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
            process.environment = environment
            process.standardOutput = stdout
            process.standardError = FileHandle.nullDevice

            stdout.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if !chunk.isEmpty {
                    output.append(chunk)
                }
            }

            do {
                try process.run()
            } catch {
                stdout.fileHandleForReading.readabilityHandler = nil
                throw QuotaCommandError.processFailed
            }

            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: timeout)
            var timedOut = false

            while process.isRunning {
                if Task.isCancelled || clock.now >= deadline {
                    timedOut = clock.now >= deadline
                    break
                }
                try? await Task.sleep(for: .milliseconds(50))
            }

            if timedOut || Task.isCancelled {
                if process.isRunning {
                    process.terminate()
                    let forceKillDeadline = clock.now.advanced(by: .milliseconds(250))
                    while process.isRunning && clock.now < forceKillDeadline {
                        try? await Task.sleep(for: .milliseconds(25))
                    }
                    if process.isRunning {
                        kill(process.processIdentifier, SIGKILL)
                    }
                    process.waitUntilExit()
                }
                stdout.fileHandleForReading.readabilityHandler = nil
                try? stdout.fileHandleForReading.close()

                if timedOut {
                    throw QuotaCommandError.timedOut
                }
                throw CancellationError()
            }

            process.waitUntilExit()
            stdout.fileHandleForReading.readabilityHandler = nil
            output.append(stdout.fileHandleForReading.readDataToEndOfFile())

            guard process.terminationStatus == 0 else {
                throw QuotaCommandError.processFailed
            }
            return output.value
        }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }
}

private final class LockedDataBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func append(_ chunk: Data) {
        lock.lock()
        data.append(chunk)
        lock.unlock()
    }

    var value: Data {
        lock.lock()
        defer { lock.unlock() }
        return data
    }
}

@MainActor
final class QuotaDashboardModel: ObservableObject {
    static let loadingError = "할당량 정보를 불러오지 못했습니다. 다시 시도해 주세요."

    @Published private(set) var accounts: [QuotaDisplayAccount] = []
    @Published private(set) var errorMessage: String?
    @Published private(set) var resetTicketsErrorMessage: String?
    @Published private(set) var terminalErrorMessage: String?
    @Published private(set) var isRefreshing = false
    @Published private(set) var isLoadingResetTickets = false
    @Published private(set) var isRedeemingResetTicket = false

    private let executor: any QuotaCommandExecuting
    private let now: @Sendable () -> Date
    private var snapshot: QuotaSnapshot?
    private var resetTicketsByIndex: [Int: ResetTicketDisplay] = [:]

    init(
        executor: any QuotaCommandExecuting = ProcessQuotaCommandExecutor(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.executor = executor
        self.now = now
    }

    func loadCached() async {
        _ = await load(arguments: ["limits", "--json"], timeout: .seconds(10))
    }

    func refresh() async {
        if await load(arguments: ["limits", "--json", "--refresh"], timeout: .seconds(30)) {
            await loadResetTickets()
        }
    }

    func loadResetTickets() async {
        guard !isRefreshing, !isLoadingResetTickets, let snapshot else { return }
        isLoadingResetTickets = true
        defer { isLoadingResetTickets = false }

        var next = resetTicketsByIndex
        var hasFailure = false
        for account in snapshot.accounts where account.enabled {
            do {
                let data = try await executor.run(
                    arguments: ["reset", "account=\(account.index + 1)", "format=json"],
                    timeout: .seconds(10)
                )
                next[account.index] = try ResetTicketSnapshot.decode(data: data).display(now: now())
            } catch {
                hasFailure = true
            }
        }
        resetTicketsByIndex = next
        updateCountdowns()
        resetTicketsErrorMessage = hasFailure
            ? "초기화권 정보를 불러오지 못했습니다. 다시 시도해 주세요."
            : nil
    }

    func redeemResetTicket(for account: QuotaDisplayAccount) async {
        guard !isRedeemingResetTicket, account.enabled, account.resetTickets?.availableCount ?? 0 > 0 else {
            return
        }
        isRedeemingResetTicket = true
        defer { isRedeemingResetTicket = false }

        do {
            _ = try await executor.run(
                arguments: [
                    "reset",
                    "action=consume",
                    "account=\(account.index + 1)",
                    "confirm=true",
                    "format=json",
                ],
                timeout: .seconds(30)
            )
            resetTicketsErrorMessage = nil
            await refresh()
        } catch {
            resetTicketsErrorMessage = "초기화권을 사용하지 못했습니다. 다시 시도해 주세요."
        }
    }

    func openCodexMultiAuth(execute: @MainActor () throws -> Void = {
        try executeTerminalScript(NSAppleScript(source: "tell application \"Terminal\" to do script \"codex-multi-auth\""))
    }) {
        do {
            try execute()
            terminalErrorMessage = nil
        } catch {
            terminalErrorMessage = "Terminal을 열지 못했습니다. 시스템 설정의 자동화 권한을 확인한 뒤 다시 시도해 주세요."
        }
    }

    func updateCountdowns() {
        guard let snapshot else { return }
        accounts = snapshot.displayAccounts(now: now(), resetTicketsByIndex: resetTicketsByIndex)
    }

    func monitorCachedQuota() async {
        await loadCached()
        while !Task.isCancelled {
            do {
                try await Task.sleep(for: .seconds(60))
            } catch {
                return
            }
            updateCountdowns()
            await loadCached()
        }
    }

    private func load(arguments: [String], timeout: Duration) async -> Bool {
        guard !isRefreshing else { return false }
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            let data = try await executor.run(arguments: arguments, timeout: timeout)
            let decoded = try QuotaSnapshot.decode(data: data)
            snapshot = decoded
            updateCountdowns()
            errorMessage = nil
            return true
        } catch {
            errorMessage = Self.loadingError
            return false
        }
    }
}
