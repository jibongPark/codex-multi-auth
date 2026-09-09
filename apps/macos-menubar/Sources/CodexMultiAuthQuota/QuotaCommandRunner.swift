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

        return try await Task.detached(priority: .userInitiated) {
            let process = Process()
            let stdout = Pipe()
            let output = LockedDataBuffer()
            process.executableURL = executableURL
            process.arguments = commandArguments
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
        }.value
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
    @Published private(set) var isRefreshing = false

    private let executor: any QuotaCommandExecuting
    private let now: @Sendable () -> Date
    private var snapshot: QuotaSnapshot?

    init(
        executor: any QuotaCommandExecuting = ProcessQuotaCommandExecutor(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.executor = executor
        self.now = now
    }

    func loadCached() async {
        await load(arguments: ["limits", "--json"], timeout: .seconds(10))
    }

    func refresh() async {
        await load(arguments: ["limits", "--json", "--refresh"], timeout: .seconds(30))
    }

    func updateCountdowns() {
        guard let snapshot else { return }
        accounts = snapshot.displayAccounts(now: now())
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

    private func load(arguments: [String], timeout: Duration) async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            let data = try await executor.run(arguments: arguments, timeout: timeout)
            let decoded = try QuotaSnapshot.decode(data: data)
            snapshot = decoded
            accounts = decoded.displayAccounts(now: now())
            errorMessage = nil
        } catch {
            errorMessage = Self.loadingError
        }
    }
}
