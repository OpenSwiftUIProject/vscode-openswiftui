import OpenSwiftUI

#if os(macOS)
import AppKit

@MainActor
enum PreviewApp {
    static func main() {
        if PreviewRegistry.listIfRequested() { return }
        let application = NSApplication.shared
        let delegate = PreviewAppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) {
            application.run()
        }
    }
}

@MainActor
private final class PreviewAppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = OpenSwiftUI.NSHostingController(rootView: PreviewSession.makeContent())
        controller.sizingOptions = []
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 640),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OpenSwiftUI Preview"
        window.contentViewController = controller
        window.setContentSize(NSSize(width: 480, height: 640))
        window.isReleasedWhenClosed = false
        self.window = window
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        DispatchQueue.main.async {
            guard window.isVisible, controller.view.window === window else { return }
            controller.view.layoutSubtreeIfNeeded()
            PreviewSession.reportReady()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}
#elseif os(iOS)
import UIKit

@MainActor
enum PreviewApp {
    static func main() {
        if PreviewRegistry.listIfRequested() { return }
        UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(PreviewAppDelegate.self))
    }
}

@MainActor
final class PreviewAppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        configurationForConnecting session: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Preview", sessionRole: session.role)
        configuration.delegateClass = PreviewSceneDelegate.self
        return configuration
    }
}

@MainActor
final class PreviewSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = PreviewViewController(rootView: PreviewSession.makeContent())
        self.window = window
        window.makeKeyAndVisible()
    }
}

@MainActor
private final class PreviewViewController: OpenSwiftUI.UIHostingController<OpenSwiftUI.AnyView> {
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard let window = view.window, !window.isHidden else { return }
        view.layoutIfNeeded()
        PreviewSession.reportReady()
    }
}
#else
#error("The native preview host currently supports macOS and iOS Simulator.")
#endif

#if OPENSWIFTUI_AUTOMATIC_HOST
@_cdecl("openswiftui_preview_main")
@MainActor
func openswiftuiPreviewMain(
    _ argc: Int32,
    _ argv: UnsafeMutablePointer<UnsafeMutablePointer<Int8>?>?
) -> Int32 {
    PreviewApp.main()
    return 0
}
#else
@main
@MainActor
enum PreviewEntry {
    static func main() {
        PreviewApp.main()
    }
}
#endif
