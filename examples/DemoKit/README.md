# DemoKit

A pure Swift library package with one `ContentView` and its unnamed `#Preview`.
The view stays internal to its module. There is no executable target, Xcode
project, preview host, or preview configuration in this package.

`Package.swift` uses the official OpenSwiftUI-spm package at exactly `0.24.3` and
declares macOS 15 / iOS 18. Resolve dependencies with the selected Xcode:

```sh
swift package resolve
```

Open this folder in VS Code and open `Sources/DemoKit/ContentView.swift`.
Select **ContentView** in the Preview sidebar or click **Run Preview**, then
choose a native destination. The extension prepares its application host in
extension storage and preserves this package's module, dependencies, and resources.
It does not add an executable target to `Package.swift`.

See the [example guide](../README.md) for setup, verification boundaries, and
native acceptance checks.
