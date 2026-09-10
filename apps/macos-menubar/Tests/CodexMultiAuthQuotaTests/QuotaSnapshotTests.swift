import Foundation
import Testing
@testable import CodexMultiAuthQuota

private let validLimitsJSON = #"""
{
  "schemaVersion": 1,
  "generatedAt": 1735689600000,
  "mode": "cached",
  "selection": { "pinnedIndex": null, "activeIndexByFamily": {}, "routedIndex": 0 },
  "accounts": [
    {
      "index": 1,
      "label": "Work (b***@example.com)",
      "enabled": false,
      "current": false,
      "quota": {
        "updatedAt": 1735689600000,
        "status": 200,
        "planType": "team",
        "primary": { "usedPercent": 25, "windowMinutes": 300, "resetAtMs": 1735693200000 },
        "secondary": { "usedPercent": 10, "windowMinutes": 10080, "resetAtMs": null }
      }
    },
    {
      "index": 0,
      "label": "Personal (a***@example.com)",
      "enabled": true,
      "current": true,
      "quota": null
    }
  ]
}
"""#

private func fixture(_ string: String) -> Data {
    Data(string.utf8)
}

@Test("orders display accounts by their configured number")
func displayAccountsUseConfiguredNumberOrder() throws {
    let snapshot = try QuotaSnapshot.decode(data: fixture(validLimitsJSON))

    #expect(snapshot.displayAccounts(now: .now).map(\.label) == [
        "a***@example.com", "b***@example.com"
    ])
}

@Test("keeps numerical account order when a later account is active")
func displayAccountsKeepNumericalOrder() throws {
    let snapshot = try QuotaSnapshot.decode(data: fixture(#"""
    {
      "schemaVersion": 1,
      "accounts": [
        { "index": 2, "label": "third@example.com", "enabled": true, "current": false, "quota": null },
        { "index": 0, "label": "first@example.com", "enabled": true, "current": false, "quota": null },
        { "index": 1, "label": "second@example.com", "enabled": true, "current": true, "quota": null }
      ]
    }
    """#))

    #expect(snapshot.displayAccounts(now: .now).map(\.label) == [
        "first@example.com", "second@example.com", "third@example.com"
    ])
}

@Test("shows only the email portion of an account label")
func displayAccountHidesRoleAndIdentifierMetadata() throws {
    let snapshot = try QuotaSnapshot.decode(data: fixture(#"""
    {
      "schemaVersion": 1,
      "accounts": [{
        "index": 0,
        "label": "Account 3 (Personal (role:owner) [id:opaque-id], user***@example.com, id:another-opaque-id)",
        "enabled": true,
        "current": true,
        "quota": null
      }]
    }
    """#))

    let account = try #require(snapshot.displayAccounts(now: .now).first)

    #expect(account.label == "user***@example.com")
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

@Test("keeps missing quota visible without inventing quota windows")
func displaysMissingQuota() throws {
    let snapshot = try QuotaSnapshot.decode(data: fixture(validLimitsJSON))
    let account = try #require(snapshot.displayAccounts(now: .now).first)

    #expect(account.enabled)
    #expect(account.quota == nil)
}

@Test("accepts explicit null provider values without fabricating a quota")
func acceptsUnavailableProviderValues() throws {
    let snapshot = try QuotaSnapshot.decode(data: fixture(#"""
    {
      "schemaVersion": 1,
      "accounts": [{
        "index": 0,
        "label": "Personal (a***@example.com)",
        "enabled": true,
        "current": true,
        "quota": {
          "updatedAt": 1,
          "status": 429,
          "planType": null,
          "primary": { "usedPercent": null, "windowMinutes": null, "resetAtMs": null },
          "secondary": null
        }
      }]
    }
    """#))
    let account = try #require(snapshot.displayAccounts(now: .now).first)
    let primary = try #require(account.quota?.primary)

    #expect(primary.remainingPercent == nil)
    #expect(primary.windowText == "할당량")
    #expect(primary.resetText == nil)
    #expect(account.quota?.secondary == nil)
}

@Test("preserves disabled account state and maps documented window labels")
func displaysDisabledAccountAndWindowLabels() throws {
    let snapshot = try QuotaSnapshot.decode(data: fixture(validLimitsJSON))
    let account = try #require(snapshot.displayAccounts(now: .now).last)
    let quota = try #require(account.quota)

    #expect(!account.enabled)
    #expect(quota.primary?.windowText == "5시간")
    #expect(quota.secondary?.windowText == "7일")
}

@Test("clamps remaining quota to a displayable percentage")
func clampsRemainingPercentage() {
    #expect(QuotaWindow(usedPercent: -10, windowMinutes: 300, resetAtMs: nil)
        .display(now: .now).remainingPercent == 100)
    #expect(QuotaWindow(usedPercent: 125, windowMinutes: 300, resetAtMs: nil)
        .display(now: .now).remainingPercent == 0)
}

@Test("clamps extreme finite usage without overflowing integer conversion")
func clampsExtremeFiniteUsage() {
    let display = QuotaWindow(usedPercent: 1e300, windowMinutes: 300, resetAtMs: nil)
        .display(now: .now)

    #expect(display.remainingPercent == 0)
}

@Test("formats the reset countdown from the supplied millisecond timestamp")
func formatsResetCountdown() {
    let now = Date(timeIntervalSince1970: 1_000)
    let window = QuotaWindow(usedPercent: 25, windowMinutes: 300, resetAtMs: 1_000_000 + 3_661_000)

    #expect(window.display(now: now).resetText == "01:01")
}

@Test("formats a multi-day reset countdown for a weekly quota")
func formatsWeeklyResetCountdown() {
    let now = Date(timeIntervalSince1970: 1_000)
    let window = QuotaWindow(usedPercent: 25, windowMinutes: 10_080, resetAtMs: 1_000_000 + 90_061_000)

    #expect(window.display(now: now).resetText == "1일 01:01")
}

@Test("reserves visible space for the loaded account quota list")
func quotaAccountListReservesVisibleHeight() {
    #expect(QuotaPopoverLayout.accountListMinimumHeight == 260)
    #expect(QuotaPopoverLayout.accountListMaximumHeight == 320)
}

@Test("keeps the nearest valid reset-ticket expiry for compact display")
func displaysAvailableResetTickets() throws {
    let snapshot = try ResetTicketSnapshot.decode(data: fixture(#"""
    {
      "availableCount": 3,
      "credits": [
        { "id": "expired", "status": "available", "isAvailable": true, "expiresAt": "2025-01-01T00:00:00Z" },
        { "id": "later", "status": "available", "isAvailable": true, "expiresAt": "2027-02-01T00:00:00Z" },
        { "id": "earlier", "status": "available", "isAvailable": true, "expiresAt": "2027-01-01T00:00:00Z" }
      ]
    }
    """#))

    let display = snapshot.display(now: Date(timeIntervalSince1970: 1_735_689_600))

    #expect(display.availableCount == 2)
    #expect(display.earliestExpiry == Date(timeIntervalSince1970: 1_798_761_600))
}

@Test("accepts reset-ticket expiries with fractional seconds")
func displaysFractionalSecondResetTicketExpiry() throws {
    let snapshot = try ResetTicketSnapshot.decode(data: fixture(#"""
    {
      "availableCount": 1,
      "credits": [
        { "id": "fractional", "status": "available", "isAvailable": true, "expiresAt": "2027-01-01T00:00:00.123456Z" }
      ]
    }
    """#))

    let display = snapshot.display(now: Date(timeIntervalSince1970: 1_735_689_600))

    #expect(display.availableCount == 1)
    let expiry = try #require(display.earliestExpiry)
    #expect(abs(expiry.timeIntervalSince1970 - 1_798_761_600.123456) < 0.001)
}
