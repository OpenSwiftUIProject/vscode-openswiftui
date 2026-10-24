#!/usr/bin/env python3
"""Compile real macros and verify their registries without building OpenSwiftUI."""
import json
from pathlib import Path
import platform
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class PreviewMacroTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="openswiftui-preview-macros-")
        cls.output = Path(cls.temporary.name)
        cls.swift = subprocess.check_output(["xcrun", "--find", "swiftc"], text=True).strip()
        sdk = subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True).strip()
        host = Path(cls.swift).resolve().parents[1] / "lib/swift/host"
        cls.base = [cls.swift, "-sdk", sdk, "-target", f"{platform.machine()}-apple-macos14.0",
                    "-module-cache-path", str(cls.output / "ModuleCache")]
        cls.plugin = cls.output / "libOpenSwiftUIPreviewMacros.dylib"
        cls.run_command(cls.base + ["-emit-library", "-module-name", "OpenSwiftUIPreviewMacros",
                        "-I", str(host), "-L", str(host), "-Xlinker", "-rpath", "-Xlinker", str(host),
                        str(ROOT / "tools/PreviewMacros/PreviewMacro.swift"), "-o", str(cls.plugin)])
        cls.write("Core.swift", '''
public protocol View { var payload: String { get } }
public extension View {
    func styled() -> Self { self }
    func previewDisplayName(_ name: String?) -> Self { self }
}
public struct Pair<A: View, B: View>: View {
    public let first: A; public let second: B
    public var payload: String { first.payload + second.payload }
}
@resultBuilder public enum ViewBuilder {
    public static func buildBlock<V: View>(_ value: V) -> V { value }
    public static func buildBlock<A: View, B: View>(_ a: A, _ b: B) -> Pair<A, B> {
        Pair(first: a, second: b)
    }
}
''')
        cls.module("OpenSwiftUICore", "Core.swift")
        cls.write("UI.swift", '''
@_exported import OpenSwiftUICore
import AppKit
public struct AnyView: View {
    public let payload: String
    public init(_ value: any View) { payload = value.payload }
}
public struct Group<Content: View>: View {
    public let content: Content
    public var payload: String { content.payload }
    public init(@ViewBuilder content: () -> Content) { self.content = content() }
}
@MainActor public protocol PreviewProvider {
    static var _allPreviews: [_Preview] { get }
}
public struct _Preview {
    public let id: Int
    public let content: AnyView
    public let displayName: String?
    public let contentType: String
    public init(id: Int, content: any View, displayName: String? = nil, contentType: String = "Element") {
        self.id = id; self.content = AnyView(content)
        self.displayName = displayName; self.contentType = contentType
    }
}
public extension View {
    @MainActor func _previewVC() -> NSViewController { NSViewController() }
}
''')
        cls.module("OpenSwiftUI", "UI.swift", ["-lOpenSwiftUICore"])
        cls.write("Main.swift", '''
import Foundation
import OpenSwiftUI
@main enum Main {
    @MainActor static func main() {
        if PreviewRegistry.listIfRequested() { return }
        for item in PreviewRegistry.cases() {
            print("\\(item.name ?? "<unnamed>")|\\(item.makeView().payload)|\\(item.fileID)|\\(item.line):\\(item.column)")
        }
    }
}
''')

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    @classmethod
    def write(cls, name, content):
        path = cls.output / name
        path.write_text(content)
        return str(path)

    @classmethod
    def run_command(cls, command, expected=0):
        result = subprocess.run(command, cwd=cls.output, text=True, capture_output=True)
        if result.returncode != expected:
            raise AssertionError(f"Command returned {result.returncode}: {result.stdout}{result.stderr}")
        return result

    @classmethod
    def module(cls, name, source, extra=()):
        cls.run_command(cls.base + ["-emit-module", "-emit-library", "-module-name", name,
                        "-I", str(cls.output), "-L", str(cls.output), *extra,
                        source, "-o", str(cls.output / f"lib{name}.dylib")])

    def compile_fixture(self, source, success=True):
        fixture = self.write("Fixture.swift", source)
        command = self.base + ["-module-name", "MacroFixture", "-D", "OPENSWIFTUI_STANDALONE_PREVIEW",
            "-I", str(self.output), "-L", str(self.output), "-lOpenSwiftUI", "-lOpenSwiftUICore",
            "-Xlinker", "-rpath", "-Xlinker", str(self.output), "-load-plugin-library", str(self.plugin),
            str(ROOT / "templates/NativeHost/PreviewMacro.swift"),
            str(ROOT / "templates/NativeHost/PreviewRegistry.swift"), "Main.swift", fixture,
            "-o", str(self.output / "fixture")]
        return self.run_command(command, 0 if success else 1)

    def test_registry_preserves_private_context_and_distinct_declarations(self):
        self.compile_fixture('''
import OpenSwiftUI
private struct Secret: View { let payload: String }
private let label = "Shared"
#Preview(label) { Secret(payload: "one") }
#Preview(label) { Secret(payload: "two") }
#Preview { [text = "capture"] in Secret(payload: text) }
#Preview("Builder") { Secret(payload: "A"); Secret(payload: "B") }
@MainActor private func factory() -> any View { Secret(payload: "reference") }
#Preview("Reference", body: factory)
private enum Scope {
    static let text = "nested"
    #Preview("Nested") { Secret(payload: text) }
}
#if OMITTED_PREVIEW
#Preview("Excluded") { Secret(payload: "wrong") }
#endif
''')
        lines = self.run_command([str(self.output / "fixture")]).stdout.splitlines()
        self.assertEqual([line.split("|")[:2] for line in lines], [
            ["Shared", "one"], ["Shared", "two"], ["Secret", "capture"],
            ["Builder", "AB"], ["Reference", "reference"], ["Nested", "nested"]])
        self.assertEqual(len(set(line.rsplit("|", 1)[1] for line in lines)), 6)
        self.assertTrue(all("MacroFixture/Fixture.swift" in line for line in lines))
        self.assertEqual([line.rsplit("|", 1)[1] for line in lines], ["5:1", "6:1", "7:1", "8:1", "10:1", "13:5"])
        listing = self.run_command([str(self.output / "fixture"), "--openswiftui-list-previews"]).stdout
        prefix = "OPENSWIFTUI_PREVIEW_LIST:manual:"
        self.assertTrue(listing.startswith(prefix))
        metadata = json.loads(listing[len(prefix):])
        self.assertEqual(metadata["version"], 1)
        self.assertEqual(len({item["id"] for item in metadata["previews"]}), 6)
        self.assertTrue(all(Path(item["filePath"]).resolve() == (self.output / "Fixture.swift").resolve()
                            for item in metadata["previews"]))
        self.assertEqual([item.get("name") for item in metadata["previews"]],
                         ["Shared", "Shared", "Secret", "Builder", "Reference", "Nested"])

    def test_provider_registries_preserve_private_scopes_and_expand_runtime_children(self):
        self.compile_fixture('''
import OpenSwiftUI
private struct Secret: View { let payload: String }
private struct Provider: PreviewProvider {
    static var _allPreviews: [_Preview] { [
        _Preview(id: 7, content: Secret(payload: "first"), displayName: "Named"),
        _Preview(id: 9, content: Secret(payload: "second"))
    ] }
    #_OpenSwiftUIPreviewProvider(Provider.self, filePath: "/Original/Views.swift", line: 4, column: 1, typeName: "Secret", childTypeNames: ["Secret", "Secret"])
}
private enum Scope {
    private struct Nested: PreviewProvider {
        static var _allPreviews: [_Preview] { [_Preview(id: 0, content: Secret(payload: "nested"), contentType: "RuntimeCard")] }
        #_OpenSwiftUIPreviewProvider(Scope.Nested.self, filePath: "/Original/Views.swift", line: 12, column: 5, typeName: nil)
    }
}
private final class ClassProvider: PreviewProvider {
    static var _allPreviews: [_Preview] { [_Preview(id: 0, content: Secret(payload: "class"))] }
    #_OpenSwiftUIPreviewProvider(ClassProvider.self, filePath: "/Original/Views.swift", line: 17, column: 1, typeName: "Secret")
}
private enum EnumProvider: PreviewProvider {
    static var _allPreviews: [_Preview] { [_Preview(id: 0, content: Secret(payload: "enum"))] }
    #_OpenSwiftUIPreviewProvider(EnumProvider.self, filePath: "/Original/Views.swift", line: 21, column: 1, typeName: "Secret")
}
private struct ExtendedProvider {}
extension ExtendedProvider: PreviewProvider {
    static var _allPreviews: [_Preview] { [_Preview(id: 0, content: Secret(payload: "extension"))] }
    #_OpenSwiftUIPreviewProvider(ExtendedProvider.self, filePath: "/Original/Views.swift", line: 26, column: 1, typeName: "Secret")
}
''')
        lines = self.run_command([str(self.output / "fixture")]).stdout.splitlines()
        self.assertEqual([line.split("|")[:2] for line in lines], [
            ["Named", "first"], ["Secret", "second"], ["RuntimeCard", "nested"],
            ["Secret", "class"], ["Secret", "enum"], ["Secret", "extension"]])
        listing = self.run_command([str(self.output / "fixture"), "--openswiftui-list-previews"]).stdout
        metadata = json.loads(listing.removeprefix("OPENSWIFTUI_PREVIEW_LIST:manual:"))["previews"]
        self.assertEqual(len({item["id"] for item in metadata}), 6)
        self.assertEqual([item["kind"] for item in metadata], ["provider"] * 6)
        self.assertEqual([item["providerType"] for item in metadata], ["Provider", "Provider", "Scope.Nested", "ClassProvider", "EnumProvider", "ExtendedProvider"])
        self.assertTrue(all(item["filePath"] == "/Original/Views.swift" for item in metadata))
        self.assertTrue(metadata[0]["id"].endswith(":4:1:provider:7"))
        self.assertTrue(metadata[1]["id"].endswith(":4:1:provider:9"))

    def test_unnamed_macros_use_root_view_syntax_without_erasure_or_modifier_names(self):
        self.compile_fixture('''
import OpenSwiftUI
private struct Secret: View { let payload = "view" }
#Preview { Secret().styled() }
#Preview { Group { Secret() } }
@MainActor private func factory() -> any View { Secret() }
#Preview(body: factory)
''')
        listing = self.run_command([str(self.output / "fixture"), "--openswiftui-list-previews"]).stdout
        metadata = json.loads(listing.removeprefix("OPENSWIFTUI_PREVIEW_LIST:manual:"))["previews"]
        self.assertEqual([item.get("name") for item in metadata], ["Secret", "Secret", None])
        self.assertEqual([item.get("typeName") for item in metadata], ["Secret", "Secret", None])
        self.assertEqual([item["kind"] for item in metadata], ["macro"] * 3)

    def test_root_display_names_survive_compiled_metadata(self):
        self.compile_fixture('''
import OpenSwiftUI
private struct Secret: View { let payload = "view" }
private let label = "Dynamic root name"
#Preview { Secret().previewDisplayName("Trait label").styled() }
#Preview("Explicit") { Secret().previewDisplayName("Trait") }
#Preview { Secret().previewDisplayName(label) }
#Preview { [text = "captured"] in Secret().previewDisplayName("Literal capture name") }
#Preview { [text = "captured"] in Secret().previewDisplayName(text) }
#Preview { Secret().previewDisplayName("Inner").previewDisplayName(nil) }
''')
        listing = self.run_command([str(self.output / "fixture"), "--openswiftui-list-previews"]).stdout
        metadata = json.loads(listing.removeprefix("OPENSWIFTUI_PREVIEW_LIST:manual:"))["previews"]
        self.assertEqual([item.get("name") for item in metadata],
                         ["Trait label", "Explicit", "Dynamic root name", "Literal capture name", "Secret", "Secret"])
        self.assertTrue(all(item.get("typeName") == "Secret" for item in metadata))

    def test_provider_child_type_names_require_an_exact_runtime_count(self):
        self.compile_fixture('''
import OpenSwiftUI
private struct Card: View { let payload: String }
private struct Provider: PreviewProvider {
    static var _allPreviews: [_Preview] { [_Preview(id: 0, content: Card(payload: "a")), _Preview(id: 1, content: Card(payload: "b"))] }
    #_OpenSwiftUIPreviewProvider(Provider.self, filePath: "/Original.swift", line: 4, column: 1, typeName: "WrongSingle", childTypeNames: ["FirstCard", "SecondCard"])
}
private struct Mismatch: PreviewProvider {
    static var _allPreviews: [_Preview] { [_Preview(id: 0, content: Card(payload: "a")), _Preview(id: 1, content: Card(payload: "b"))] }
    #_OpenSwiftUIPreviewProvider(Mismatch.self, filePath: "/Original.swift", line: 8, column: 1, typeName: "WrongSingle", childTypeNames: ["WrongCount"])
}
''')
        listing = self.run_command([str(self.output / "fixture"), "--openswiftui-list-previews"]).stdout
        metadata = json.loads(listing.removeprefix("OPENSWIFTUI_PREVIEW_LIST:manual:"))["previews"]
        self.assertEqual([item.get("typeName") for item in metadata], ["FirstCard", "SecondCard", None, None])
        self.assertEqual([item.get("name") for item in metadata], ["FirstCard", "SecondCard", None, None])

    def test_provider_generic_scopes_produce_an_explicit_error(self):
        result = self.compile_fixture('''
import OpenSwiftUI
struct Generic<T> {
    struct Provider: PreviewProvider {
        static var _allPreviews: [_Preview] { [] }
        #_OpenSwiftUIPreviewProvider(Provider.self, filePath: "/Original.swift", line: 4, column: 5, typeName: nil)
    }
}
''', success=False)
        self.assertIn("Standalone PreviewProvider declarations cannot be inside a generic type", result.stderr)

    def test_normal_expansion_keeps_developer_tools_registry(self):
        declaration = (ROOT / "templates/NativeHost/PreviewMacro.swift").read_text()
        self.write("NormalMacro.swift", declaration.removeprefix("#if OPENSWIFTUI_STANDALONE_PREVIEW\n").removesuffix("#endif\n"))
        self.write("Normal.swift", '''
import OpenSwiftUI
private struct Secret: View { let payload = "view" }
#Preview("Normal", traits: .sizeThatFitsLayout) { Secret() }
''')
        result = self.run_command(self.base + ["-typecheck", "-I", str(self.output),
            "-load-plugin-library", str(self.plugin), "-Xfrontend", "-dump-macro-expansions",
            "NormalMacro.swift", "Normal.swift"])
        self.assertIn("DeveloperToolsSupport::PreviewRegistry", result.stderr)
        self.assertIn("traits: .sizeThatFitsLayout", result.stderr)
        self.assertIn("._previewVC()", result.stderr)

    def test_traits_produce_an_explicit_error(self):
        result = self.compile_fixture('''
import OpenSwiftUI
private struct Secret: View { let payload = "view" }
#Preview("Layout", traits: .sizeThatFitsLayout) { Secret() }
''', success=False)
        self.assertIn("Standalone OpenSwiftUI previews do not support preview traits yet", result.stderr)

    def test_generic_scopes_produce_an_explicit_error(self):
        result = self.compile_fixture('''
import OpenSwiftUI
private struct Secret: View { let payload = "view" }
struct Generic<T> { #Preview { Secret() } }
''', success=False)
        self.assertIn("Standalone OpenSwiftUI previews cannot be declared inside a generic type", result.stderr)


if __name__ == "__main__":
    unittest.main()
