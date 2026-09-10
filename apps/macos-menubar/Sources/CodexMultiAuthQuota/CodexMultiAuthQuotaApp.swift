import AppKit
import SwiftUI

private final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
    }
}

@main
struct CodexMultiAuthQuotaApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = QuotaDashboardModel()

    var body: some Scene {
        MenuBarExtra {
            QuotaPopoverView(model: model)
                .task {
                    model.updateCountdowns()
                    await model.loadCached()
                    await model.loadResetTickets()
                }
        } label: {
            Image(systemName: "gauge.with.dots.needle.67percent")
                .accessibilityLabel("Codex Multi Auth quota dashboard")
                .task {
                    await model.monitorCachedQuota()
                }
        }
        .menuBarExtraStyle(.window)
    }
}
