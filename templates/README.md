# Native preview host

Automatic mode uses the native host runtime in extension storage. For an Xcode
app, it retains the original app entry point and selects a separate preview entry
when linking. For a Swift package library, it generates an app host that references
the original local package. You do not need to copy these files or edit the project
or package manifest.

Automatic builds use the project's original `#Preview` macro expansion, then adapt
the compiled registry through a cached source overlay. They do not compile the
`PreviewMacro.swift` declaration shim. The ordinary [Hello world examples](../examples/README.md)
contain no host source references or preview configuration.

The instructions below are for an optional, manually maintained legacy preview
host. This path uses the standalone macro shim and bundled compiler plugin.

Add all four Swift files in `NativeHost/` to a dedicated macOS or iOS app target:

| File | Purpose |
| --- | --- |
| `PreviewMacro.swift` | Select standalone preview macros during extension builds. |
| `PreviewRegistry.swift` | Discover compiled declarations and list their source metadata. |
| `PreviewApp.swift` | Own the native app entry point, event loop, and window. |
| `PreviewSession.swift` | Create the selected view and report readiness. |

Link OpenSwiftUI and compile your view sources and preview declarations in the
same target. Remove the target membership of your normal `@main` source: the
preview target must have exactly one app entry point. A declaration can import
and use public views from another module; internal views must be compiled in the
preview target's module.

```swift
import OpenSwiftUI

private struct CounterView: View {
    var body: some View {
        Text("Counter")
    }
}

#Preview("Counter") {
    CounterView()
}
```

The extension compiles the bundled plugin with the selected Xcode, then passes
the plugin and `OPENSWIFTUI_STANDALONE_PREVIEW` flag to the app build. Use Xcode
26.6 / Swift 6.3: the plugin uses module selector syntax. No manual catalog is
needed. Each macro expansion creates a registry entry at the original declaration
scope, which preserves access to private file and nongeneric type members.
Inactive conditional-compilation branches do not produce entries.

This standalone path supports named and unnamed OpenSwiftUI view previews.
`PreviewProvider` requires an OpenSwiftUI build that exposes
`_PreviewProvider._allPreviews` and `_Preview` metadata. The extension registers
providers in the selected Swift file through a virtual file overlay, including
private and nested providers. No source edit or manual provider catalog is needed.
The runtime expands a provider into its child previews and reads each child's
`previewDisplayName`. A root View type name is used when no display name is set.
Preview traits and declarations inside generic types produce explicit compiler
errors. The host does not supply the full Xcode Preview API or discover declarations
that were not compiled into its target.

## Target settings

For iOS, enable generated Info.plist and scene manifest settings:

```text
GENERATE_INFOPLIST_FILE = YES
INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES
INFOPLIST_KEY_UILaunchScreen_Generation = YES
```

Use a macOS 15 / iOS 18 deployment target with the examples' OpenSwiftUI `0.24.3`
binaries. Set these values in a dedicated host's own project. The ordinary examples
do not provide a dedicated host target. Use the matching release dependencies;
a complete directory layout alone
does not establish that a local framework cache implements current gestures.

## Discovery and execution

Before building, the extension parses the active Swift buffer to list its
`#Preview` and `PreviewProvider` declarations in **Preview > Current File** and
CodeLens. This source list does not
evaluate `#if` or target membership. After building, the extension starts the
host with `--openswiftui-list-previews`.
The host writes `OPENSWIFTUI_PREVIEW_LIST:<session>:<JSON>` and exits before
creating a window. The listing contains names, source file paths, and
`fileID:line:column` IDs for macros. Provider children append `:provider:<childID>`
to the provider's source ID. The extension validates
the selected source path and position against that list, then launches the case
in a new process. With no source selection, it presents the compiled list.
Keep all four host templates in sync with the extension so provider metadata and
source selection use the same host protocol.

The extension supplies `OPENSWIFTUI_PREVIEW_ID` and
`OPENSWIFTUI_PREVIEW_SESSION`. The host opens the selected view and emits
`OPENSWIFTUI_PREVIEW_READY:<session>` after the hosting view is attached, visible,
and has completed a layout pass. An unknown ID exits with a nonzero status.
Readiness confirms the host lifecycle, not gesture support in the linked runtime.

Keep the host process alive for interaction. AppKit and UIKit deliver input to
OpenSwiftUI and schedule redraws in the external macOS or Simulator window.
Closing the last macOS preview window exits the host. The extension stops the
iOS app when the user stops the session.

Rebuild retains the selected source-location ID and starts a new process, which
resets state. Moving the declaration or adding lines above it can require a new
selection through **OpenSwiftUI: Run Preview**. State-preserving source reload and
embedded native windows are not implemented. Keyboard, focus, hover, and gesture
support depend on the linked OpenSwiftUI version.
