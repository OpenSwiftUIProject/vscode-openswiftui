import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { discoverSourcePreviews } from "../src/sourcePreviews";

test("source discovery respects cancellation before accessing Xcode or buffers", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(discoverSourcePreviews(
        '#Preview { Color.red }', "/unsaved/Preview.swift", undefined,
        "/unused-preview-storage", controller.signal, () => {},
    ), error => error instanceof Error && error.name === "AbortError");
});

test("SwiftSyntax discovers previews from unsaved buffers", { skip: process.platform !== "darwin", timeout: 120000 }, async t => {
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), "openswiftui-source-previews-"));
    const filePath = path.join(storage, "Unsaved 世界.swift");
    const logs: string[] = [];
    const discover = (source: string, originalPath = filePath) => discoverSourcePreviews(
        source, originalPath, undefined, storage, new AbortController().signal, text => logs.push(text),
    );
    try {
        await t.test("both Hello world examples expose an unnamed ContentView preview", async () => {
            for (const relative of ["DemoKit/Sources/DemoKit/ContentView.swift", "DemoApp/Sources/ContentView.swift"]) {
                const sample = path.resolve(__dirname, "../../examples", relative);
                const source = await fs.readFile(sample, "utf8");
                const previews = await discover(source, sample);
                assert.deepEqual(previews.map(({ kind, name, typeName, filePath }) => ({ kind, name, typeName, filePath })), [
                    { kind: "macro", name: undefined, typeName: "ContentView", filePath: sample },
                ]);
                const preview = previews[0]!;
                const line = source.split(/\r?\n/)[preview.line - 1];
                assert.ok(line, "Each declaration must refer to an existing source line.");
                assert.ok(Buffer.from(line).subarray(preview.column - 1).toString("utf8").startsWith("#Preview"),
                    "Each source location must point to its macro token.");
            }
        });

        await t.test("comments, ordinary strings, and raw strings do not create declarations", async () => {
            const source = [
                '// #Preview("line comment") { Color.red }',
                '/* outer /* #Preview("nested comment") {} */ still comment */',
                'let text = "#Preview(\\"string\\") { Color.red }"',
                'let raw = #"#Preview("raw string") { Color.red }"#',
                'let multiline = """',
                '#Preview("multiline string") { Color.red }',
                '"""',
                '#OtherPreview("unrelated macro") {}',
                '#Preview("Actual") { Color.red }',
            ].join("\n");
            assert.deepEqual(await discover(source), [{ kind: "macro", name: "Actual", typeName: "Color", filePath, line: 9, column: 1 }]);
        });

        await t.test("nested and multiline declarations retain duplicate names and source positions", async () => {
            const source = [
                '#Preview("Shared") { Color.red }',
                'enum Scope {',
                '    #Preview(',
                '        "Shared"',
                '    ) { Color.blue }',
                '}',
                '#Preview { Color.green }',
            ].join("\n");
            assert.deepEqual(await discover(source), [
                { kind: "macro", name: "Shared", typeName: "Color", filePath, line: 1, column: 1 },
                { kind: "macro", name: "Shared", typeName: "Color", filePath, line: 3, column: 5 },
                { kind: "macro", typeName: "Color", filePath, line: 7, column: 1 },
            ]);
        });

        await t.test("static raw and escaped labels are decoded while dynamic names stay unnamed", async () => {
            const source = [
                '#Preview(#"Raw "label""#) { Color.red }',
                '#Preview("Escaped \\"label\\" \\u{1F600}") { Color.red }',
                '#Preview(title) { Color.red }',
                '#Preview("Value \\(value)") { Color.red }',
                '#Preview("""',
                '    First',
                '    Second',
                '    """) { Color.red }',
            ].join("\n");
            const previews = await discover(source);
            assert.deepEqual(previews.map(preview => preview.name), [
                'Raw "label"', 'Escaped "label" 😀', undefined, undefined, "First\nSecond",
            ]);
        });

        await t.test("columns count UTF-8 bytes, including same-line prefixes and CRLF", async () => {
            const prefix = 'let value = "你好😀"; ';
            const source = `// First line\r\n${prefix}#Preview("Unicode") { Color.red }\r\n\t#Preview { Color.blue }`;
            assert.deepEqual(await discover(source), [
                { kind: "macro", name: "Unicode", typeName: "Color", filePath, line: 2, column: Buffer.byteLength(prefix, "utf8") + 1 },
                { kind: "macro", typeName: "Color", filePath, line: 3, column: 2 },
            ]);
        });

        await t.test("conditional compilation stays unresolved until the app build", async () => {
            assert.deepEqual((await discover([
                '#if UNUSED_FLAG', '#Preview("First") { Color.red }', '#else',
                '#Preview("Second") { Color.blue }', '#endif',
            ].join("\n"))).map(preview => preview.name), ["First", "Second"]);
        });

        await t.test("an incomplete edit still exposes an existing preview without reading disk", async () => {
            assert.deepEqual(await discover('#Preview("Editing") {\n Color.red\n'), [
                { kind: "macro", name: "Editing", typeName: "Color", filePath, line: 1, column: 1 },
            ]);
            await assert.rejects(fs.access(filePath), { code: "ENOENT" });
        });

        await t.test("macro labels use root display names and underlying View types through modifiers", async () => {
            const previews = await discover([
                '#Preview("Explicit") { CardView().previewDisplayName("Modifier").padding() }',
                '#Preview { Feature.CardView().padding().previewDisplayName(#"Named card"#) }',
                '#Preview { GenericCard<String>().padding() }',
                '#Preview { CardView.init().padding() }',
                '#Preview { makeContent().padding() }',
                '#Preview { CardView().previewDisplayName("Old").previewDisplayName(title) }',
            ].join("\n"));
            assert.deepEqual(previews.map(({ kind, name, typeName }) => ({ kind, name, typeName })), [
                { kind: "macro", name: "Explicit", typeName: "CardView" },
                { kind: "macro", name: "Named card", typeName: "Feature.CardView" },
                { kind: "macro", name: undefined, typeName: "GenericCard" },
                { kind: "macro", name: undefined, typeName: "CardView" },
                { kind: "macro", name: undefined, typeName: undefined },
                { kind: "macro", name: undefined, typeName: "CardView" },
            ]);
        });

        await t.test("qualified providers and nested provider names retain declaration positions", async () => {
            const source = [
                'enum Samples {',
                '    struct Card_Previews: OpenSwiftUI.PreviewProvider {',
                '        static var previews: some View {',
                '            CardView().padding().previewDisplayName("Card")',
                '        }',
                '    }',
                '}',
                'struct Unnamed: PreviewProvider { static var previews: some View { DetailView().padding() } }',
            ].join("\n");
            const previews = await discover(source);
            assert.deepEqual(previews.map(({ kind, name, typeName, providerType, filePath, line, column }) =>
                ({ kind, name, typeName, providerType, filePath, line, column })), [
                { kind: "provider", name: "Card", typeName: "CardView", providerType: "Samples.Card_Previews", filePath, line: 2, column: 5 },
                { kind: "provider", name: undefined, typeName: "DetailView", providerType: "Unnamed", filePath, line: 8, column: 1 },
            ]);
        });

        await t.test("extension conformance finds a same-file previews property and preserves escaped type names", async () => {
            const previews = await discover([
                'struct `default` { static var previews: some View { get { return CardView().previewDisplayName("Extension") } } }',
                'extension `default`: OpenSwiftUI.PreviewProvider {}',
                'extension Outer.Nested: PreviewProvider { static var previews: some View = DetailView() }',
            ].join("\n"));
            assert.deepEqual(previews.map(({ kind, name, typeName, providerType, line, column }) =>
                ({ kind, name, typeName, providerType, line, column })), [
                { kind: "provider", name: "Extension", typeName: "CardView", providerType: "`default`", line: 2, column: 1 },
                { kind: "provider", name: undefined, typeName: "DetailView", providerType: "Outer.Nested", line: 3, column: 1 },
            ]);
        });

        await t.test("provider groups stay one source entry and do not borrow descendant display names", async () => {
            const previews = await discover([
                'struct Multiple: PreviewProvider {',
                '    static var previews: some View {',
                '        Group { CardView().previewDisplayName("First"); DetailView().previewDisplayName("Second") }',
                '    }',
                '}',
                '#Preview { CardView().overlay { DetailView().previewDisplayName("Overlay only") } }',
                'struct DirectChildren: PreviewProvider { static var previews: some View { CardView(); DetailView() } }',
            ].join("\n"));
            assert.deepEqual(previews.map(({ kind, name, typeName, providerType }) => ({ kind, name, typeName, providerType })), [
                { kind: "provider", name: undefined, typeName: undefined, providerType: "Multiple" },
                { kind: "macro", name: undefined, typeName: "CardView", providerType: undefined },
                { kind: "provider", name: undefined, typeName: undefined, providerType: "DirectChildren" },
            ]);
        });

        await t.test("comments, strings, unrelated types, and instance properties do not supply provider names", async () => {
            const previews = await discover([
                '// struct Commented: PreviewProvider {}',
                'let text = "struct InString: PreviewProvider {}"',
                'struct Ordinary { static var previews: some View { CardView() } }',
                'struct Actual: PreviewProvider {',
                '    var previews: some View { CardView().previewDisplayName("Instance") }',
                '    struct Child { static var previews: some View { CardView().previewDisplayName("Nested") } }',
                '}',
            ].join("\n"));
            assert.equal(previews.length, 1);
            assert.equal(previews[0].providerType, "Actual");
            assert.equal(previews[0].name, undefined);
            assert.equal(previews[0].typeName, undefined);
        });

        await t.test("provider insertion offsets are UTF-8 bytes and later same-line macros keep their positions", async () => {
            const prefix = 'let title = "你好😀"; ';
            const provider = 'struct Cards: PreviewProvider { static var previews: some View { CardView() } }';
            const source = `${prefix}${provider}; #Preview { DetailView() }\r\n#Preview { Color.red }`;
            const previews = await discover(source);
            assert.equal(previews[0].kind, "provider");
            assert.equal(previews[0].column, Buffer.byteLength(prefix) + 1);
            assert.equal(previews[0].providerBodyEnd, Buffer.byteLength(prefix + provider) - 1);
            assert.equal(Buffer.from(source)[previews[0].providerBodyEnd!], "}".charCodeAt(0));
            assert.deepEqual(previews.slice(1).map(({ line, column, kind }) => ({ line, column, kind })), [
                { line: 1, column: Buffer.byteLength(`${prefix}${provider}; `) + 1, kind: "macro" },
                { line: 2, column: 1, kind: "macro" },
            ]);
            const incomplete = await discover('struct Editing: PreviewProvider { static var previews: some View { CardView() }');
            assert.equal(incomplete[0].providerBodyEnd, undefined, "Incomplete declarations must not expose an insertion point.");
        });

        await t.test("provider child types are inferred only for fully known linear builder bodies", async () => {
            const previews = await discover([
                'struct Direct: PreviewProvider { static var previews: some View { CardView().padding(); DetailView() } }',
                'struct Grouped: PreviewProvider { static var previews: some View { Group { CardView(); Group { DetailView().padding(); Feature.OtherView() } } } }',
                'struct Dynamic: PreviewProvider { static var previews: some View { CardView(); makeContent() } }',
                'struct Conditional: PreviewProvider { static var previews: some View { if flag { CardView() } else { DetailView() } } }',
                'struct Repeated: PreviewProvider { static var previews: some View { ForEach(items) { CardView() } } }',
                'struct Container: PreviewProvider { static var previews: some View { VStack { CardView(); DetailView() } } }',
                'struct SingleGroup: PreviewProvider { static var previews: some View { Group { CardView().padding() } } }',
            ].join("\n"));
            assert.deepEqual(previews.map(preview => preview.childTypeNames), [
                ["CardView", "DetailView"], ["CardView", "DetailView", "Feature.OtherView"],
                undefined, undefined, undefined, ["VStack"], ["CardView"],
            ]);
            assert.deepEqual(previews.map(preview => preview.typeName), [undefined, undefined, undefined, undefined, undefined, "VStack", "CardView"]);
        });

        await t.test("source-location directives are detected by syntax rather than comments or strings", async () => {
            const provider = 'struct Cards: PreviewProvider { static var previews: some View { CardView() } }';
            const ordinary = await discover(`// #sourceLocation(file: "Other.swift", line: 99)\nlet text = "#sourceLocation()"\n${provider}`);
            assert.equal(ordinary[0].hasSourceLocation, undefined);
            const mapped = await discover(`#sourceLocation(file: "Original.swift", line: 99)\n${provider}\n#sourceLocation()`);
            assert.equal(mapped[0].hasSourceLocation, true);
            assert.equal(mapped[0].line, 2, "Source discovery still reports physical editor locations.");
        });

        assert.equal(logs.filter(text => text.startsWith("Compiling the Swift source preview parser")).length, 1);
        const cache = path.join(storage, "PreviewDiscovery");
        const entries = await fs.readdir(cache);
        assert.equal(entries.length, 1, "Temporary source buffers must be removed.");
        assert.deepEqual(await fs.readdir(path.join(cache, entries[0]!)), ["PreviewDiscovery"]);
    } finally {
        await fs.rm(storage, { recursive: true, force: true });
    }
});

test("cancelling parser preparation removes temporary build files", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), "openswiftui-source-cancel-"));
    const controller = new AbortController();
    try {
        await assert.rejects(discoverSourcePreviews(
            '#Preview { Color.red }', "/unsaved/Preview.swift", undefined, storage,
            controller.signal, () => controller.abort(),
        ), error => error instanceof Error && error.name === "AbortError");
        const cache = path.join(storage, "PreviewDiscovery");
        for (const entry of await fs.readdir(cache)) {
            assert.deepEqual(await fs.readdir(path.join(cache, entry)), []);
        }
    } finally {
        await fs.rm(storage, { recursive: true, force: true });
    }
});
