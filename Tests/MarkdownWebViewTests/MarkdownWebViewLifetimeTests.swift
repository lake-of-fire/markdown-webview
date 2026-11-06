import SwiftUI
import WebKit
import XCTest
@testable import MarkdownWebView

@MainActor
final class MarkdownWebViewLifetimeTests: XCTestCase {
    func testDismantleReleasesCoordinatorWhileWebViewIsStillRetained() {
        weak var releasedCoordinator: MarkdownWebView.Coordinator?
        var retainedWebView: MarkdownWebView.CustomWebView?

        autoreleasepool {
            let coordinator = MarkdownWebView.Coordinator(parent: MarkdownWebView("# A note"))
            let webView = coordinator.platformView
            releasedCoordinator = coordinator
            retainedWebView = webView

            #if os(macOS)
            MarkdownWebView.dismantleNSView(webView, coordinator: coordinator)
            #elseif os(iOS)
            MarkdownWebView.dismantleUIView(webView, coordinator: coordinator)
            #endif
        }

        XCTAssertNil(releasedCoordinator, "Script handlers must not retain the dismissed coordinator")
        XCTAssertNotNil(retainedWebView)
        XCTAssertNil(retainedWebView?.navigationDelegate)
        retainedWebView = nil
    }
}
