import AppKit
import SwiftUI

struct QuotaPopoverView: View {
    @ObservedObject var model: QuotaDashboardModel

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

            Divider()
            footer
        }
        .padding(16)
        .frame(width: 360)
    }

    private var currentAccountSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("현재 활성 계정")
                .font(.caption)
                .foregroundStyle(.secondary)

            if let currentAccount = model.accounts.first(where: \.current) {
                Text(currentAccount.label)
                    .font(.headline)
                    .lineLimit(2)
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
                    LazyVStack(spacing: 10) {
                        ForEach(Array(model.accounts.enumerated()), id: \.offset) { _, account in
                            AccountQuotaRow(account: account)
                        }
                    }
                }
                .frame(maxHeight: 420)
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

private struct AccountQuotaRow: View {
    let account: QuotaDisplayAccount

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(account.label)
                    .fontWeight(account.current ? .semibold : .regular)
                    .lineLimit(2)
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
        .padding(10)
        .background(account.current ? Color.accentColor.opacity(0.08) : Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .opacity(account.enabled ? 1 : 0.55)
    }
}

private struct QuotaWindowRow: View {
    let window: QuotaWindowDisplay

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(window.windowText)
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
            }

            if let resetText = window.resetText {
                Text(resetText)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
    }
}
