# OpenSwiftUI Preview for VS Code

Find `#Preview` and `PreviewProvider` declarations in the current Swift file and
run a selected view in a native macOS window or iOS Simulator app. VS Code manages
the build and session. The linked OpenSwiftUI runtime handles input, gestures,
state changes, and redraws in the external window.

## Requirements

- Local macOS with Xcode 26.6 / Swift 6.3 and the required Simulator runtime.
- VS Code 1.88 or later and the Swift extension (`swiftlang.swift-vscode`).
- A trusted workspace with an Xcode application target or Swift package library
  target that depends on OpenSwiftUI.

## Install and run

1. Run **Extensions: Install from VSIX** and select the packaged extension.
   To create a VSIX from source, see [development instructions](AGENTS.md#development).
2. Run **Developer: Reload Window** after installation or an update.
3. Open the project or package folder and a Swift file with `#Preview` or
   `PreviewProvider`. Generated Xcode projects, such as Tuist projects, must
   already have a project or workspace. A Swift package needs its manifest.
4. Open **Preview** in the left Activity Bar and select a row under **Current File**,
   or click **Run Preview** above a declaration.
5. Choose the owning target if more than one target contains the file, then
   select **This Mac** or an iOS Simulator.

Automatic mode does not require a preview target, host source files, or JSON
configuration. It saves the selected file before building. Edits made during
save, including format-on-save changes, can require selection again.

Both declaration styles can appear in the same file:

```swift
#Preview("Macro Preview") {
    ContentView()
}

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
            .previewDisplayName("Legacy Preview")
    }
}
```

The sidebar uses explicit names first, then the root View type name. Before a
build, the list uses source information. After a build, each provider expands
into its runtime previews, including names computed by Swift code. Each child
can be selected and rebuilt separately. If no usable View type can be determined,
the label falls back to the source location. The list refreshes when the active
file or its contents change.

## How it works

The extension scans the editor buffer and resolves the owning target. For an
Xcode app, it prepares a derived project in extension storage and retains the
target's source paths, dependencies, resource phases, and package resource bundles.
For a Swift library package, it creates an application host that references the
original local package and its dependency graph. It does not add a target to the
package manifest or copy the package's dependency graph.

Automatic mode first builds with the project's original `#Preview` macro and
reads its compiler expansion. A SwiftSyntax helper adapts the generated registry
into a cached source overlay for a second native host build. It does not replace
the project's macro with a custom declaration. Access stays in the original
module, including internal and private view types. Unsupported expansion shapes
and preview traits fail with a diagnostic. Original source and project files
stay unchanged.

A compiled registry supplies the previews that actually exist in the selected
build. The extension matches the source selection to that registry, then starts
a separate native host. The source list can include inactive `#if` declarations;
these cannot run unless the selected build compiles them.

Resources come from the target's build graph. The extension does not infer which
assets a closure uses. The normal application entry point is bypassed; preview
code must supply any models, services, or environment values that app startup
would normally provide. See [architecture and maintenance guidance](AGENTS.md)
for implementation details.

## Commands and session behavior

| Command | Behavior |
| --- | --- |
| Run Preview | Select a declaration, choose a destination, build, validate, and run it. |
| Rebuild Preview | Resolve the target or host configuration again, build, and restart the selected preview. |
| Stop Preview | Cancel pending work and stop this extension's active host. |
| Configure Previews | Open optional host overrides, or create an empty configuration without replacing an existing file. |
| Show Preview Log | Show the active extension version, build output, host logs, and failures. |

One preview session runs at a time. A failed build leaves the previous preview
running. After a successful build, the old host stops before compiled discovery;
a later discovery or launch failure does not restore it. Stop does not shut down
a shared Simulator.

Rebuild starts a new process and resets state. It retains the selected
source-location ID, so moving a declaration or adding lines above it can require
**Run Preview** to select it again. Rebuild does not inject changed code into a
running process. If the configuration pins `previewID`, update or remove that
value before selecting again.

## Optional dedicated host configuration

Use this path for a manually maintained preview host. Explicit configuration
takes priority over automatic target resolution and describes the build target,
not a catalog of source declarations. This compatibility path uses the bundled
standalone macro shim; automatic mode uses the project's original macro.

Add the four [native host templates](templates/NativeHost) and the view sources
to a dedicated macOS/iOS app target that links OpenSwiftUI. This target must not
include another `@main` app. See [host integration](templates/README.md) for build
settings and protocol details.

Create `.vscode/openswiftui-previews.json` in the project folder:

```json
{
  "version": 1,
  "previews": [
    {
      "id": "custom-host",
      "name": "Custom Preview Host",
      "project": "MyApp.xcodeproj",
      "scheme": "MyPreviewHost",
      "target": "MyPreviewHost",
      "configuration": "Debug",
      "platforms": ["macos", "ios-simulator"]
    }
  ]
}
```

- Use either `project` or `workspace`. Paths are relative to the folder that
  contains the configuration. `${workspaceFolder}` expands to that folder.
- `id` identifies the build profile and must be unique in that folder. `name` is
  its display label. Neither field limits the source preview list.
- Omit `previewID` to choose a declaration. To pin one, use its exact compiled ID:
  `fileID:line:column` for a macro, with `:provider:<childID>` appended for a
  provider child. An explicit source selection takes priority over this default.
- `arguments` and `environment` apply to the host process. Variables beginning
  with `OPENSWIFTUI_PREVIEW_` and `--openswiftui-list-previews` are reserved.
- `buildArguments` accepts Xcode build settings such as `CODE_SIGNING_ALLOWED=NO`,
  not shell commands or destination/output overrides. `developerDirectory`
  selects a specific Xcode `Contents/Developer` directory.

Open a provider's Swift file before running it: provider registration covers the
selected file. Without an active Swift file, Run uses the configured target and
its compiled declaration picker.

## Try the examples

| Folder to open | Source to open | Structure |
| --- | --- | --- |
| `examples/DemoKit` | `Sources/DemoKit/ContentView.swift` | Pure Swift library package. |
| `examples/DemoApp` | `Sources/ContentView.swift` | Ordinary Xcode app with an `App` / `WindowGroup` entry. |

Both examples contain the same globe image, `Hello, world!` text, and unnamed
`#Preview { ContentView() }`. Select **ContentView** in **Preview > Current File**,
then choose the destination. Neither example has preview host sources, a custom
macro declaration, or preview JSON.

The first dependency resolution can download the pinned `0.24.3` package and its
frameworks. See the [example guide](examples/README.md) for recorded verification
and the native acceptance checklist. These minimal views do not test gestures.

## Limits and troubleshooting

- Automatic mode supports Xcode application targets and Swift package library
  targets with a linkable library product. Xcode library, test, and Swift package
  executable targets need additional host support.
- Automatic iOS Simulator previews reject apps with embedded extensions such as
  Widgets. Use a dedicated host without embedded extensions for these projects.
- Preview traits, generic declaration scopes, and automatic preview files with explicit
  `#sourceLocation` directives are unsupported. Provider device, layout, and
  orientation settings are not applied; the host has a fixed initial window size.
- Apple SwiftUI, visionOS, Linux native rendering, and remote hosts are not
  implemented in this extension.
- Gesture, keyboard, and focus behavior depends on the linked OpenSwiftUI runtime.
  A visible window or a ready signal does not prove interaction works. Complete
  macOS and iOS Simulator gesture acceptance remains pending.
- If an update still reports `no macro named 'Preview'`, run **Developer: Reload
  Window**. Check **Show Preview Log** for the active extension version and the
  first compiler error.

Development commands, source responsibilities, test scopes, and maintenance
constraints are in [AGENTS.md](AGENTS.md).
