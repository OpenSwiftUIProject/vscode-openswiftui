import AppKit
import OpenSwiftUI

@MainActor
enum PreviewRegistry {
    static func listIfRequested() -> Bool { false }
}

@MainActor
enum PreviewSession {
    private static let scenario = CommandLine.arguments[1]

    static func makeContent() -> AnyView {
        switch scenario {
        case "intrinsic":
            AnyView(VStack {
                Image(systemName: "globe").imageScale(.large).foregroundStyle(.tint)
                Text("Hello, world!")
            }.padding())
        case "fixed":
            AnyView(Color.red.frame(width: 240, height: 160))
        case "flexible":
            AnyView(Text("Flexible").padding().frame(maxWidth: .infinity, maxHeight: .infinity))
        case "empty":
            AnyView(EmptyView())
        default:
            fatalError("Unknown sizing scenario")
        }
    }

    static func reportReady() {
        guard let window = NSApplication.shared.windows.first(where: { $0.isVisible }),
              let controller = window.contentViewController as? OpenSwiftUI.NSHostingController<AnyView>
        else { fatalError("The host did not present its content window") }

        let reference = OpenSwiftUI.NSHostingController(rootView: makeContent())
        reference.sizingOptions = .preferredContentSize
        check(window, expected: reference.preferredContentSize, stage: "initial")

        if scenario == "flexible" {
            window.setContentSize(NSSize(width: 320, height: 240))
            controller.view.layoutSubtreeIfNeeded()
            check(window, expected: NSSize(width: 320, height: 240), stage: "user resize")
        } else if scenario == "fixed" {
            controller.rootView = AnyView(Color.blue.frame(width: 300, height: 200))
            DispatchQueue.main.async {
                controller.view.layoutSubtreeIfNeeded()
                check(window, expected: NSSize(width: 300, height: 200), stage: "content resize")
                exit(EXIT_SUCCESS)
            }
            return
        }
        exit(EXIT_SUCCESS)
    }

    private static func check(_ window: NSWindow, expected: NSSize, stage: String) {
        let actual = window.contentRect(forFrameRect: window.frame).size
        let matches = actual.width.isFinite && actual.height.isFinite &&
            abs(actual.width - expected.width) <= 1 && abs(actual.height - expected.height) <= 1
        let record: [String: Any] = [
            "case": scenario, "stage": stage,
            "expected": [expected.width, expected.height],
            "actual": [actual.width, actual.height], "passed": matches,
        ]
        let data = try! JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        print("PREVIEW_SIZE_RESULT:" + String(decoding: data, as: UTF8.self))
        if !matches { exit(EXIT_FAILURE) }
    }
}
