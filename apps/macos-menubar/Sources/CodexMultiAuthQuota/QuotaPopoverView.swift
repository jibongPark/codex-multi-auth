import AppKit
import SwiftUI

enum QuotaPopoverLayout {
    static let accountListMinimumHeight: CGFloat = 260
    static let accountListMaximumHeight: CGFloat = 320
}

struct QuotaPopoverView: View {
    @ObservedObject var model: QuotaDashboardModel
    @State private var resetCandidate: QuotaDisplayAccount?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            currentAccountSection
            Divider()
            accountList

            if let errorMessage = model.errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let terminalErrorMessage = model.terminalErrorMessage {
                Label(terminalErrorMessage, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let resetTicketsErrorMessage = model.resetTicketsErrorMessage {
                Label(resetTicketsErrorMessage, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()
            footer
        }
        .padding(16)
        .frame(width: 360)
        .confirmationDialog(
            "초기화권을 사용하시겠습니까?",
            isPresented: Binding(
                get: { resetCandidate != nil },
                set: { if !$0 { resetCandidate = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("초기화권 사용", role: .destructive) {
                guard let account = resetCandidate else { return }
                resetCandidate = nil
                Task { await model.redeemResetTicket(for: account) }
            }
            Button("취소", role: .cancel) {
                resetCandidate = nil
            }
        } message: {
            if let account = resetCandidate {
                Text(resetConfirmationMessage(for: account))
            }
        }
    }

    private var currentAccountSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("현재 활성 계정")
                .font(.caption)
                .foregroundStyle(.secondary)

            if let currentAccount = model.accounts.first(where: \.current) {
                Text(currentAccount.label)
                    .font(.headline)
                    .lineLimit(1)
            } else if model.accounts.isEmpty {
                Text("연결된 계정이 없습니다")
                    .foregroundStyle(.secondary)
            } else {
                Text("현재 활성 계정이 없습니다")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var accountList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("계정별 할당량")
                .font(.headline)

            if model.accounts.isEmpty {
                if model.isRefreshing {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                }
            } else {
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(Array(model.accounts.enumerated()), id: \.offset) { _, account in
                            AccountQuotaRow(account: account) {
                                resetCandidate = account
                            }
                        }
                    }
                }
                .frame(
                    minHeight: QuotaPopoverLayout.accountListMinimumHeight,
                    maxHeight: QuotaPopoverLayout.accountListMaximumHeight,
                    alignment: .top
                )
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Button {
                Task { await model.refresh() }
            } label: {
                Label(
                    model.isRefreshing ? "새로고침 중…" : "새로고침",
                    systemImage: "arrow.clockwise"
                )
            }
            .disabled(model.isRefreshing)

            Spacer()

            Button("Codex Multi Auth 열기") {
                model.openCodexMultiAuth()
            }
            Button("종료") {
                NSApplication.shared.terminate(nil)
            }
        }
        .controlSize(.small)
    }
}

private func resetConfirmationMessage(for account: QuotaDisplayAccount) -> String {
    guard let expiry = account.resetTickets?.earliestExpiry else {
        return "\(account.label) 계정의 초기화권 1개를 사용합니다."
    }
    return "\(account.label) 계정의 초기화권 1개를 사용합니다. 만료일: \(expiry.formatted(date: .abbreviated, time: .omitted))"
}

private struct AccountQuotaRow: View {
    let account: QuotaDisplayAccount
    let redeemResetTicket: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(account.label)
                    .fontWeight(account.current ? .semibold : .regular)
                    .lineLimit(1)
                    .layoutPriority(1)
                Spacer(minLength: 8)
                if account.current {
                    Text("현재")
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.tint.opacity(0.15), in: Capsule())
                }
                if !account.enabled {
                    Text("비활성")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                if let resetTickets = account.resetTickets {
                    Text(resetTicketSummary(resetTickets))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Button("초기화") {
                        redeemResetTicket()
                    }
                    .controlSize(.mini)
                    .disabled(!account.enabled || resetTickets.availableCount == 0)
                }
            }

            if let quota = account.quota {
                if let primary = quota.primary {
                    QuotaWindowRow(window: primary)
                }
                if let secondary = quota.secondary {
                    QuotaWindowRow(window: secondary)
                }
                if quota.primary == nil && quota.secondary == nil {
                    Text("할당량 정보 없음")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("할당량 정보 없음")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

        }
        .padding(6)
        .background(account.current ? Color.accentColor.opacity(0.08) : Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .opacity(account.enabled ? 1 : 0.55)
    }
}

func resetTicketSummary(_ tickets: ResetTicketDisplay) -> String {
    guard tickets.availableCount > 0 else { return "초기화권 없음" }
    guard let expiry = tickets.earliestExpiry else { return "초기화권 \(tickets.availableCount)개" }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = .current
    formatter.dateFormat = "MM-dd"
    return "초기화권 \(tickets.availableCount)개 · \(formatter.string(from: expiry)) 만료"
}

private struct QuotaWindowRow: View {
    let window: QuotaWindowDisplay

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text("\(window.windowText) (\(window.resetText ?? "시간 미정"))")
                    .font(.caption)
                Spacer()
                if let remainingPercent = window.remainingPercent {
                    Text("\(remainingPercent)% 남음")
                        .font(.caption.monospacedDigit())
                } else {
                    Text("사용량 정보 없음")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let remainingPercent = window.remainingPercent {
                ProgressView(value: Double(remainingPercent), total: 100)
                    .controlSize(.mini)
            }
        }
    }
}
