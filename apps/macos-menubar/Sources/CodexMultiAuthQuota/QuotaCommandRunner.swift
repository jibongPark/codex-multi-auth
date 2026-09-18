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

private let maximumOutputBytesPerDrain = 64 * 1_024
private let maximumFinalDrainPasses = 16

func makeNonBlocking(_ handle: FileHandle) throws {
    let descriptor = handle.fileDescriptor
    let flags = fcntl(descriptor, F_GETFL)
    guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
        throw QuotaCommandError.processFailed
    }
}

@discardableResult
func drainAvailableOutput(from handle: FileHandle, into output: inout Data) throws -> Bool {
    let descriptor = handle.fileDescriptor
    var buffer = [UInt8](repeating: 0, count: 8_192)
    var remaining = maximumOutputBytesPerDrain

    while remaining > 0 {
        let count = buffer.withUnsafeMutableBytes { bytes in
            Darwin.read(descriptor, bytes.baseAddress, min(bytes.count, remaining))
        }
        if count > 0 {
            output.append(contentsOf: buffer.prefix(count))
            remaining -= count
            continue
        }
        if count == 0 || errno == EAGAIN || errno == EWOULDBLOCK {
            return false
        }
        if errno == EINTR {
            continue
        }
        throw QuotaCommandError.processFailed
    }

    return true
}

func hasAdditionalOutput(from handle: FileHandle) throws -> Bool {
    let descriptor = handle.fileDescriptor
    var byte: UInt8 = 0

    while true {
        let count = Darwin.read(descriptor, &byte, 1)
        if count > 0 {
            return true
        }
        if count == 0 || errno == EAGAIN || errno == EWOULDBLOCK {
            return false
        }
        if errno == EINTR {
            continue
        }
        throw QuotaCommandError.processFailed
    }
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
            var output = Data()
            process.executableURL = executableURL
            process.arguments = commandArguments
            var environment = ProcessInfo.processInfo.environment
            environment["CODEX_MULTI_AUTH_QUOTA_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
            process.environment = environment
            process.standardOutput = stdout
            process.standardError = FileHandle.nullDevice

            try makeNonBlocking(stdout.fileHandleForReading)

            do {
                try process.run()
            } catch {
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
                try drainAvailableOutput(from: stdout.fileHandleForReading, into: &output)
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
                }
                try? stdout.fileHandleForReading.close()

                if timedOut {
                    throw QuotaCommandError.timedOut
                }
                throw CancellationError()
            }

            var reachedEndOfOutput = false
            for _ in 0..<maximumFinalDrainPasses {
                if try !drainAvailableOutput(from: stdout.fileHandleForReading, into: &output) {
                    reachedEndOfOutput = true
                    break
                }
            }
            try? stdout.fileHandleForReading.close()

            guard try reachedEndOfOutput || !hasAdditionalOutput(from: stdout.fileHandleForReading) else {
                throw QuotaCommandError.processFailed
            }

            guard process.terminationStatus == 0 else {
                throw QuotaCommandError.processFailed
            }
            return output
        }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
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
    @Published private(set) var resetTicketConfirmationAccount: QuotaDisplayAccount?

    private let executor: any QuotaCommandExecuting
    private let now: @Sendable () -> Date
    private var snapshot: QuotaSnapshot?
    private var resetTicketsByIndex: [Int: ResetTicketDisplay] = [:]
    private var resetTicketLoadPending = false

    init(
        executor: any QuotaCommandExecuting = ProcessQuotaCommandExecutor(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.executor = executor
        self.now = now
    }

    func loadCached() async {
        _ = await load(arguments: ["limits", "--json"], timeout: .seconds(10))
        _ = await loadPendingResetTicketsIfNeeded()
    }

    func refresh() async {
        let refreshed = await load(arguments: ["limits", "--json", "--refresh"], timeout: .seconds(30))
        let loadedPendingTickets = await loadPendingResetTicketsIfNeeded()
        if refreshed && !loadedPendingTickets {
            await loadResetTickets()
        }
    }

    func refreshWhenOpened() async {
        await refresh()
    }

    func loadResetTickets() async {
        guard !isLoadingResetTickets else { return }
        guard !isRefreshing else {
            resetTicketLoadPending = true
            return
        }
        guard let snapshot else { return }
        isLoadingResetTickets = true
        defer { isLoadingResetTickets = false }

        var next = resetTicketsByIndex
        var hasFailure = false
        var wasCancelled = false
        for account in snapshot.accounts where account.enabled {
            do {
                let data = try await executor.run(
                    arguments: ["reset", "account=\(account.index + 1)", "format=json"],
                    timeout: .seconds(10)
                )
                next[account.index] = try ResetTicketSnapshot.decode(data: data).display(now: now())
            } catch is CancellationError {
                wasCancelled = true
                break
            } catch {
                hasFailure = true
            }
        }
        resetTicketsByIndex = next
        updateCountdowns()
        if !wasCancelled || hasFailure {
            resetTicketsErrorMessage = hasFailure
                ? "초기화권 정보를 불러오지 못했습니다. 다시 시도해 주세요."
                : nil
        }
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

    func requestResetTicketRedemption(for account: QuotaDisplayAccount) {
        guard !isRedeemingResetTicket, account.enabled, account.resetTickets?.availableCount ?? 0 > 0 else {
            return
        }
        resetTicketConfirmationAccount = account
    }

    func dismissResetTicketConfirmation() {
        resetTicketConfirmationAccount = nil
    }

    func confirmResetTicketRedemption() async {
        guard let account = resetTicketConfirmationAccount else { return }
        resetTicketConfirmationAccount = nil
        await redeemResetTicket(for: account)
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

    private func loadPendingResetTicketsIfNeeded() async -> Bool {
        guard resetTicketLoadPending, snapshot != nil, !isRefreshing else { return false }
        resetTicketLoadPending = false
        await loadResetTickets()
        return true
    }

    func updateCountdowns() {
        guard let snapshot else { return }
        accounts = snapshot.displayAccounts(now: now(), resetTicketsByIndex: resetTicketsByIndex)
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
        } catch is CancellationError {
            return false
        } catch {
            errorMessage = Self.loadingError
            return false
        }
    }
}
