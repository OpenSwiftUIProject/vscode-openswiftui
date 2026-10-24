#!/usr/bin/env python3
"""Exercise compiler expansions with the unchanged official 0.24.3 macro source."""
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
output = Path(sys.argv[2])


def run(command):
    result = subprocess.run(command, cwd=output, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"Command failed: {command}\n{result.stdout}{result.stderr}")
    return result


def write(name, content):
    file = output / name
    file.write_text(content)
    return str(file)


if sys.argv[1] == "setup":
    swift = subprocess.check_output(["xcrun", "--find", "swiftc"], text=True).strip()
    sdk = subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True).strip()
    host = Path(swift).resolve().parents[1] / "lib/swift/host"
    base = [swift, "-sdk", sdk, "-target", f"{platform.machine()}-apple-macos15.0",
            "-module-cache-path", str(output / "ModuleCache")]
    plugin = str(output / "libOpenSwiftUIMacros.dylib")
    run(base + ["-emit-library", "-module-name", "OpenSwiftUIMacros", "-package-name", "OpenSwiftUI",
        "-I", str(host), "-L", str(host), "-Xlinker", "-rpath", "-Xlinker", str(host),
        str(ROOT / "tools/PreviewExpansion/fixtures/OfficialPreviewMacro.swift"), "-o", plugin])
    core = write("Core.swift", '''
public protocol View { var payload: String { get } }
public extension View { func previewDisplayName(_ name: String?) -> Self { self } }
public struct Pair<A: View, B: View>: View {
    public let first: A; public let second: B
    public var payload: String { first.payload + second.payload }
}
@resultBuilder public enum ViewBuilder {
    public static func buildBlock<V: View>(_ value: V) -> V { value }
    public static func buildBlock<A: View, B: View>(_ a: A, _ b: B) -> Pair<A, B> { Pair(first: a, second: b) }
}
''')
    run(base + ["-emit-library", "-emit-module", "-module-name", "OpenSwiftUICore", core,
                "-o", str(output / "libOpenSwiftUICore.dylib")])
    ui = write("UI.swift", '''
@_exported import OpenSwiftUICore
import DeveloperToolsSupport
import SwiftUI
public struct AnyView: OpenSwiftUICore.View {
    public let payload: String
    public init(_ content: any OpenSwiftUICore.View) { payload = content.payload }
}
@MainActor public protocol PreviewProvider { static var _allPreviews: [_Preview] { get } }
public struct _Preview {
    public let id: Int; public let content: AnyView; public let displayName: String?; public let contentType: String
    public init(id: Int, content: any OpenSwiftUICore.View, displayName: String? = nil, contentType: String = "Element") {
        self.id = id; self.content = AnyView(content); self.displayName = displayName; self.contentType = contentType
    }
}
extension DeveloperToolsSupport.Preview {
    public init(_ name: String? = nil, traits: DeveloperToolsSupport.PreviewTrait<DeveloperToolsSupport.Preview.ViewTraits>..., body: @escaping @MainActor () -> any OpenSwiftUICore.View) {
        fatalError("The native adapter must replace the opaque Preview constructor")
    }
}
@freestanding(declaration)
public macro Preview(_ name: String? = nil, @OpenSwiftUICore.ViewBuilder body: @escaping @MainActor () -> any OpenSwiftUICore.View) = #externalMacro(module: "OpenSwiftUIMacros", type: "PreviewMacro")
@freestanding(declaration)
public macro Preview(_ name: String? = nil, traits: DeveloperToolsSupport.PreviewTrait<DeveloperToolsSupport.Preview.ViewTraits>, @OpenSwiftUICore.ViewBuilder body: @escaping @MainActor () -> any OpenSwiftUICore.View) = #externalMacro(module: "OpenSwiftUIMacros", type: "PreviewMacro")
''')
    run(base + ["-emit-library", "-emit-module", "-module-name", "OpenSwiftUI", "-I", str(output),
                "-L", str(output), "-lOpenSwiftUICore", "-load-plugin-library", plugin, ui,
                "-o", str(output / "libOpenSwiftUI.dylib")])
    write("Main.swift", '''
import Foundation
import OpenSwiftUI
@main enum Main {
    @MainActor static func main() throws {
        let entries = PreviewRegistry.cases()
        let results = entries.map { entry in
            ["name": entry.name ?? "<unnamed>", "payload": entry.makeView().payload,
             "kind": entry.kind, "line": String(entry.line), "column": String(entry.column),
             "fileID": entry.fileID, "filePath": entry.filePath, "id": entry.id]
        }
        print(String(decoding: try JSONSerialization.data(withJSONObject: results), as: UTF8.self))
    }
}
''')
    (output / "fixture-context.json").write_text(json.dumps({"base": base, "plugin": plugin}))
    print("ready")
else:
    context = json.loads((output / "fixture-context.json").read_text())
    base = context["base"] + ["-module-name", "ExpansionFixture", "-I", str(output), "-L", str(output)]
    source = sys.argv[3]
    if sys.argv[1] == "expand":
        result = run(base + ["-typecheck", "-load-plugin-library", context["plugin"],
                            "-Xfrontend", "-dump-macro-expansions", source])
        print(result.stdout + result.stderr)
    elif sys.argv[1] == "run":
        executable = str(output / "adapter-fixture")
        run(base + ["-lOpenSwiftUI", "-lOpenSwiftUICore", "-Xlinker", "-rpath", "-Xlinker", str(output),
                    "-vfsoverlay", sys.argv[4], str(ROOT / "templates/NativeHost/PreviewRegistry.swift"),
                    str(output / "Main.swift"), source, "-o", executable])
        print(run([executable]).stdout)
    else:
        raise RuntimeError("Unknown fixture operation")
