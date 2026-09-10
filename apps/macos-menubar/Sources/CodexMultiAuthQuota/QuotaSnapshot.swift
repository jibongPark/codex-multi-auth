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
            Int(min(100, max(0, (100 - $0).rounded())))
        }
        let resetText = resetAtMs.map { resetAtMs in
            let seconds = max(0, Int((Double(resetAtMs) / 1_000 - now.timeIntervalSince1970).rounded(.down)))
            return Self.resetCountdownText(seconds: seconds, windowMinutes: windowMinutes)
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

    private static func resetCountdownText(seconds: Int, windowMinutes: Int?) -> String {
        let minutes = (seconds % 3_600) / 60
        guard windowMinutes.map({ $0 >= 1_440 }) == true else {
            return String(format: "%02d:%02d", seconds / 3_600, minutes)
        }

        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3_600
        return String(format: "%d일 %02d:%02d", days, hours, minutes)
    }
}

public struct QuotaDisplayAccount: Equatable {
    public let label: String
    public let enabled: Bool
    public let current: Bool
    public let quota: QuotaDisplay?

    init(account: QuotaAccount, now: Date) {
        label = Self.emailLabel(from: account.label)
        enabled = account.enabled
        current = account.current
        quota = account.quota.map { QuotaDisplay(quota: $0, now: now) }
    }

    private static func emailLabel(from label: String) -> String {
        let pattern = #"[A-Za-z0-9._%+*-]+@[A-Za-z0-9*.-]+\.[A-Za-z]{2,}"#
        guard let range = label.range(of: pattern, options: .regularExpression) else {
            return "이메일 정보 없음"
        }
        return String(label[range])
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
