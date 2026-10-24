# DemoApp

An ordinary Xcode application with the same Hello world view as DemoKit.
`Sources/DemoApp.swift` uses OpenSwiftUI's `App` and `WindowGroup`; the view and
its unnamed `#Preview` are in `Sources/ContentView.swift`.

The app target and shared scheme are both `DemoApp`. The project depends on
OpenSwiftUI-spm at exactly `0.24.3` and declares macOS 15 / iOS 18. It contains
no preview host references, custom macro declarations, or preview JSON.

Open this folder in VS Code and open `Sources/ContentView.swift`. Select
**ContentView** in the Preview sidebar or click **Run Preview**, then choose
**This Mac** or an iOS Simulator. The extension derives a preview build from this
app's graph and bypasses its normal entry point in the derived product.

The project can also be opened in Xcode through `DemoApp.xcodeproj`. Ordinary
app startup and the extension's preview host are separate execution paths;
checking one does not validate the other.

See the [example guide](../README.md) for setup, verification boundaries, and
native acceptance checks.
