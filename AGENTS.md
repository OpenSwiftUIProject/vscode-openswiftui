# Development guidance

This file covers implementation and maintenance of the extension. Keep installation,
usage, configuration, and current runtime limitations in [README.md](README.md).
Use [templates/README.md](templates/README.md) for dedicated host integration and
the [example guide](examples/README.md) for dependency verification and native
acceptance.

## Architecture and source map

VS Code controls discovery, builds, and sessions. Rendering and input run in an
external native macOS window or iOS Simulator app through the linked OpenSwiftUI
runtime. Rebuild replaces the process and resets state; it is not source hot reload.

| Component | Responsibility |
| --- | --- |
| `src/extension.ts` | Current File tree, CodeLens, configuration refresh, selection, document versions, workspace trust, and commands. |
| `src/config.ts`, `schemas/previews.schema.json`, `src/types.ts` | Configuration validation, reserved arguments/settings, and shared contracts. |
| `src/sourcePreviews.ts`, `tools/PreviewDiscovery/PreviewDiscovery.swift` | Compile/cache the SwiftSyntax helper and parse editor buffers without building the app. |
| `src/projects.ts` | Resolve source membership, owning targets, workspace context, schemes, and supported destinations. |
| `src/packageHost.ts` | Resolve Swift package library membership/products and prepare an app host that references the original local package. |
| `src/automaticHost.ts` | Derive a project with host sources, an isolated entry point and identity, then adjust the built app's startup plist. |
| `src/expandedSources.ts`, `tools/PreviewExpansion/PreviewExpansion.swift` | Adapt real compiler-expanded preview registries into a cached VFS overlay for automatic builds. |
| `src/macros.ts`, `tools/PreviewMacros/PreviewMacro.swift` | Compile/cache the standalone macro plugin for explicitly configured legacy hosts. |
| `src/providerSources.ts` | Register providers from the selected saved file for explicitly configured legacy hosts. |
| `src/controller.ts` | Serialize build/discover/select/start/stop operations and maintain session ownership. |
| `src/backend.ts`, `src/process.ts` | Xcode builds, native launch, protocol validation, cancellation, and owned process cleanup. |
| `templates/NativeHost/` | Runtime registry, native app lifecycle, selected content, readiness, and a legacy macro shim. |
| `test/` | Unit, compiler, editor, and opt-in native integration checks. |

The execution sequence is:

```text
source candidate → owning target/destination
→ original macro expansion build → registry adapter overlay → native host build
→ stop previous host → compiled discovery → exact case selection → native launch → ready
```

Explicit host configuration in the source's owning workspace folder takes priority
over automatic resolution. It selects a build target, not a manual view catalog.
Automatic mode supports Xcode application targets and Swift package library
targets with a linkable library product. Xcode library/test targets, Swift package
executables, Linux, remote hosts, and Apple SwiftUI are not implemented. Explicit
legacy hosts use their own standalone macro path.

The Swift extension supplies language tooling. This extension queries Xcode and
builds the host itself; it does not call `SwiftExtensionApi`. `PreviewBackend`
separates build, discovery, and launch from the controller, but its requests and
artifacts still use Xcode projects, `.app` bundles, and Apple destinations, including
the generated host for a Swift package. A new runtime needs changes to these
contracts and the Swift host.

## Invariants to preserve

- Source scanning is provisional. It does not evaluate `#if` or establish target
  membership. Save and validate the selected document before building; reject stale
  editor results and ambiguous or missing compiled matches.
- Match canonical file path, line, column, declaration kind, and provider type.
  Macro IDs use `fileID:line:column`; provider children add `:provider:<childID>`.
  A reused child ID must belong to the selected declaration. Source columns are
  UTF-8 positions; VS Code ranges use UTF-16 positions.
- Preserve original source/project files and the dependency/resource graph.
  Automatic Xcode mode retains the app entry in source, selects a generated linker
  entry, and scopes compiler changes to the selected target. Package mode references
  the original package; do not rewrite its manifest or copy its dependency graph.
  Preserve same-module access to internal/private declarations. Preserve workspace
  context, package references, lockfiles, conditional settings, and plist value
  types. Keep generated products inside extension storage with a separate bundle
  identifier. This build isolation is not a sandbox for project scripts or code.
  The original app entry/lifecycle is bypassed, but its code and dependencies
  remain linked and provider enumeration executes Swift code. Do not promise
  that all startup side effects are suppressed.
- Automatic mode uses the project's original macro expansion. Do not shadow its
  `#Preview` declaration or infer a registry by parsing view bodies. Unsupported
  expansion shapes and traits need explicit diagnostics. The first build and the
  adapter are part of the replacement build and must share its cancellation path.
- Registration covers the selected source file. Inject only into cached copies
  and retain source mapping. Files with explicit `#sourceLocation`, generic
  declaration scopes, and preview traits are unsupported. Static child type
  fallbacks require a known linear builder and matching runtime child count.
  The host consumes content and names; it does not apply provider device, layout,
  or orientation configuration.
- Preserve the controller queue, generation checks, and abort signals across
  asynchronous work and pickers. A failed replacement build keeps the previous
  host running. After build success, the old host stops before discovery; later
  failure or selection cancellation does not restore it.
- Retain ownership when cleanup fails so Stop can retry. Do not terminate an
  unrelated app or shut down a shared Simulator. Simulator bundle termination
  requires the session's readiness handshake.
- Keep local trusted-workspace checks and argument-array process execution.
  `shell: false` does not make building or running workspace code safe in an
  untrusted workspace.

The host protocol reserves `OPENSWIFTUI_PREVIEW_ID`,
`OPENSWIFTUI_PREVIEW_SESSION`, and `--openswiftui-list-previews`. Discovery emits
`OPENSWIFTUI_PREVIEW_LIST:<session>:<JSON>` with version `1`, then exits before
the native window loop. Execution emits `OPENSWIFTUI_PREVIEW_READY:<session>`
after view attachment, visibility, and layout. Update the backend, all four host
templates, and protocol tests together when changing this contract.

## Development

Run commands from the repository root. Install the locked development dependencies:

```sh
npm ci --ignore-scripts
```

Use `npm run compile` for TypeScript compilation or `npm run watch` while editing.
F5 starts the configured Extension Development Host after compilation. The current
Swift helpers use Xcode 26.6 / Swift 6.3 and its host SwiftSyntax libraries.

Choose verification for the change; documentation-only edits do not need app
builds. Do not report one verification layer as proof of another.

### Unit and compiler checks

```sh
npm test
python3 tools/PreviewMacros/test.py
```

`npm test` compiles TypeScript and runs `dist/test/*.test.js`. It covers configuration,
UI boundaries, target resolution, package/derived hosts, expansion adaptation,
protocol handling, and session
cancellation/cleanup. On macOS it also runs real SwiftSyntax and source-mapping
compiler probes, so it requires a suitable selected Xcode. It does not build or
launch an OpenSwiftUI app.

The Python suite uses `xcrun` to compile the legacy standalone macro plugin and
small fixture modules. It checks registration, scope, metadata, names, and
diagnostics without building OpenSwiftUI. It is separate from the npm test command
and does not prove automatic mode uses the project's original macro correctly.

For a focused TypeScript regression, compile first, then run the relevant emitted
test file, for example `node --test dist/test/controller.test.js`.

### Isolated editor smoke test

```sh
VSCODE_EXECUTABLE_PATH='/path/to/Code' npm run test:extension
```

The executable path must be absolute. Supplying it uses the installed VS Code
instead of downloading a test copy. The runner creates temporary user-data and
extensions directories, links the installed Swift extension and its declared
dependencies, and removes the temporary directories afterward. Set
`VSCODE_EXTENSIONS_PATH` when those extensions are outside the default extensions
directory. Keep this test independent of the user's extension profile.

The smoke test checks trusted local activation, commands, Activity Bar, source
discovery, labels, CodeLens, optional configuration refresh, and idle Stop. It
does not build or start a native host and does not prove gesture behavior.

### Native integration and interaction

```sh
npm run test:automatic -- /path/to/project Sources/ContentView.swift
npm run test:automatic -- /path/to/project Sources/ContentView.swift --simulator <UDID>
```

This opt-in test builds and launches a preview host. Use a supported fixture with
one owning target and no `.vscode/openswiftui-previews.json`. It exercises each
declaration and compiled child in the selected file, checks readiness and Stop,
and verifies preservation of the selected source, project file, and configuration.
`DEVELOPER_DIR` selects Xcode; `--storage <directory>` overrides the default
`.test-output/Automatic Integration` location.

The two Hello world examples verify package/app integration and rendering; they
contain no gestures or mutable state. Native interaction acceptance needs a separate
fixture for input, state changes, visible redraw, and cleanup on macOS and iOS
Simulator. A ready token,
successful import, typecheck, or compiler fixture is not gesture proof. Record
the exact runtime, toolchain, platform, and observed behavior with results.

For macOS window sizing, resolve the DemoKit dependencies, then run:

```sh
python3 test/nativeHostSizing.py examples/DemoKit/.build/artifacts/openswiftui-spm
```

This check compiles the actual host template against the existing binary artifacts
and opens its own windows. It checks ideal content size, explicit frames, content
size changes, empty content, and manual resizing of flexible content. It requires
access to the macOS window server and does not test gestures or build OpenSwiftUI.

## Packaging and maintenance

```sh
npm run package
```

The package script invokes VSCE; `vscode:prepublish` compiles TypeScript. The
extension loads `dist/src/extension.js`. Swift helper sources and native host
templates are runtime inputs, not development-only files.

- Inspect the VSIX when package contents change. It must contain current
  `dist/src` output, both SwiftSyntax helpers, the legacy macro source and its
  license, all four native host templates, the schema, media, DemoKit with its
  generated lockfile, and DemoApp with its shared scheme.
- Keep machine-specific configuration, local frameworks/projects, test output,
  user data, and generated build artifacts out of the VSIX. Maintain
  `.vscodeignore` when adding files.
- Keep the manifest, lockfile, schema, templates, and documentation consistent
  with the change. Preserve third-party license notices for the macro source.
- Verify release binaries against their matching manifest checksums when updating
  the sample. A version label or local directory layout alone does not establish
  binary identity or runtime capability. Do not replace user-local configuration
  or framework overrides as a side effect of packaging.
- After an installed update, confirm the active version in the Preview log and
  reload the VS Code window when needed. Installation in another VS Code profile
  does not update the profile used by the active window.
- Keep current compatibility limits in README and the sample/host guides. Separate
  historical results from new checks; do not reuse an earlier runtime's gesture
  result as acceptance of a new release.

## Marketplace releases

The [publish workflow](.github/workflows/publish.yml) packages one universal VSIX.
It runs on a published stable GitHub Release. The tag must match `package.json`
exactly, without a `v` prefix. The workflow runs `npm test` on Linux, then builds
the VSIX once. The publish job verifies its checksum and uploads that artifact.
Linux skips the macOS compiler probes; this workflow does not verify native
rendering or input. Complete relevant native checks before a release.

Authentication uses GitHub OIDC, `Azure/login`, and `vsce --azure-credential`.
It requires a Microsoft Entra tenant and a dedicated application/service principal
with Marketplace access. A personal Microsoft account login alone does not set up
this identity. No PAT or client secret is needed.

### One-time setup

1. Create the GitHub environment `marketplace`. Limit deployment refs to release
   tags and the maintained branch used for manual runs. Protect those refs from
   unauthorized changes.
2. Create an Entra application/service principal and add a federated credential:

   | Field | Value |
   | --- | --- |
   | Issuer | `https://token.actions.githubusercontent.com` |
   | Audience | `api://AzureADTokenExchange` |
   | Subject | `repo:OpenSwiftUIProject@154427668/vscode-openswiftui@1431765306:environment:marketplace` |

   This repository uses GitHub's immutable subject format. Confirm the current
   configuration if the repository is renamed, transferred, or recreated:

   ```sh
   gh api repos/OpenSwiftUIProject/vscode-openswiftui/actions/oidc/customization/sub
   ```

3. Add `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` as environment secrets. Use the
   application's client ID and the tenant ID. `Azure/login` permits login without
   an Azure subscription for this workflow.
4. Run the workflow manually with the `identity` operation and an existing release
   tag. This builds the package, logs in as the publishing identity, and prints its
   Marketplace profile ID without uploading the extension.
5. Add that profile ID to the `OpenSwiftUIProject` Marketplace publisher with the
   **Contributor** role. Use the returned profile ID, not the Entra client or object
   ID. Azure role assignments alone do not grant Marketplace access.

See [Marketplace publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace),
[Azure login](https://github.com/Azure/login#login-with-openid-connect-oidc-recommended),
and [GitHub OIDC subjects](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims).

### Release procedure

Update the manifest and lockfile version, commit the release, and push a matching
tag. Publish its GitHub Release after required checks pass. The tagged commit must
contain the workflow and the complete Marketplace metadata. Publishing an older
tag does not include later source changes.

For a package-only run, use **Actions > Publish extension > Run workflow** with an
existing tag and the default `package` operation. Download `marketplace-vsix`
from that run to inspect the package. The `publish` operation can publish
an existing tag after identity setup. It does not rebuild an existing GitHub Release
asset or replace it. Marketplace versions are immutable; use a new version for an
update and do not treat a duplicate-version error as a successful upload.
