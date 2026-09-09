import Foundation

public enum QuotaSnapshotError: Error, Equatable {
    case unsupportedSchemaVersion(Int)
}

public struct QuotaSnapshot: Decodable, Equatable {
    public let schemaVersion: Int
    public let accounts: [QuotaAccount]

    public static func decode(data: Data) throws -> QuotaSnapshot {
        let snapshot = try JSONDecoder().decode(QuotaSnapshot.self, from: data)
        guard snapshot.schemaVersion == 1 else {
            throw QuotaSnapshotError.unsupportedSchemaVersion(snapshot.schemaVersion)
        }
        return snapshot
    }

    public func displayAccounts(now: Date) -> [QuotaDisplayAccount] {
        accounts.sorted { $0.current && !$1.current }
            .map { QuotaDisplayAccount(account: $0, now: now) }
    }
}

public struct QuotaAccount: Decodable, Equatable {
    public let index: Int
    public let label: String
    public let enabled: Bool
    public let current: Bool
    public let quota: Quota?
}

public struct Quota: Decodable, Equatable {
    public let updatedAt: Int?
    public let status: Int?
    public let planType: String?
    public let primary: QuotaWindow?
    public let secondary: QuotaWindow?
}

public struct QuotaWindow: Decodable, Equatable {
    public let usedPercent: Double?
    public let windowMinutes: Int?
    public let resetAtMs: Int64?

    public init(usedPercent: Double?, windowMinutes: Int?, resetAtMs: Int64?) {
        self.usedPercent = usedPercent
        self.windowMinutes = windowMinutes
        self.resetAtMs = resetAtMs
    }

    public func display(now: Date) -> QuotaWindowDisplay {
        let remainingPercent = usedPercent.map {
            min(100, max(0, Int((100 - $0).rounded())))
        }
        let resetText = resetAtMs.map { resetAtMs in
            let seconds = max(0, Int((Double(resetAtMs) / 1_000 - now.timeIntervalSince1970).rounded(.down)))
            return String(format: "%02d:%02d 후 재설정", seconds / 3_600, (seconds % 3_600) / 60)
        }
        return QuotaWindowDisplay(
            remainingPercent: remainingPercent,
            windowText: Self.windowText(for: windowMinutes),
            resetText: resetText
        )
    }

    private static func windowText(for minutes: Int?) -> String {
        guard let minutes else { return "할당량" }
        switch minutes {
        case 300:
            return "5시간"
        case 10_080:
            return "7일"
        case let minutes where minutes > 0 && minutes.isMultiple(of: 1_440):
            return "\(minutes / 1_440)일"
        case let minutes where minutes > 0 && minutes.isMultiple(of: 60):
            return "\(minutes / 60)시간"
        default:
            return "\(minutes)분"
        }
    }
}

public struct QuotaDisplayAccount: Equatable {
    public let label: String
    public let enabled: Bool
    public let current: Bool
    public let quota: QuotaDisplay?

    init(account: QuotaAccount, now: Date) {
        label = account.label
        enabled = account.enabled
        current = account.current
        quota = account.quota.map { QuotaDisplay(quota: $0, now: now) }
    }
}

public struct QuotaDisplay: Equatable {
    public let primary: QuotaWindowDisplay?
    public let secondary: QuotaWindowDisplay?

    init(quota: Quota, now: Date) {
        primary = quota.primary?.display(now: now)
        secondary = quota.secondary?.display(now: now)
    }
}

public struct QuotaWindowDisplay: Equatable {
    public let remainingPercent: Int?
    public let windowText: String
    public let resetText: String?
}
