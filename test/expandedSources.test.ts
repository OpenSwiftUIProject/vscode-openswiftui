import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { prepareExpandedSources } from "../src/expandedSources";
import { createProcessRunner } from "../src/process";

test("compiled preview adapters retain original source and reject a missing selected expansion", { skip: process.platform !== "darwin", timeout: 120000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "preview-expanded-source-"));
    const filePath = path.join(root, "Fixture.swift");
    const original = '#Preview("Selected") { Card() }';
    const developerDirectory = (await createProcessRunner().run({ command: "/usr/bin/xcode-select", args: ["-p"] })).stdout.trim();
    try {
        await fs.writeFile(filePath, original);
        await assert.rejects(prepareExpandedSources({
            source: { kind: "macro", filePath, line: 1, column: 1 }, expansionOutput: "", moduleName: "Fixture",
            developerDirectory, storagePath: path.join(root, "Storage"), signal: new AbortController().signal, log: () => {},
        }), /selected.*(expansion|compiled)|no.*expansion/i);
        assert.equal(await fs.readFile(filePath, "utf8"), original);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("official compiler expansions run native adapters with private scope, builders, providers, and exact locations", { skip: process.platform !== "darwin", timeout: 120000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "preview-expansion-compiler-"));
    const filePath = path.join(root, "Views 世界.swift");
    const runner = createProcessRunner();
    const developerDirectory = (await runner.run({ command: "/usr/bin/xcode-select", args: ["-p"] })).stdout.trim();
    const harness = path.resolve(__dirname, "../../tools/PreviewExpansion/test_fixture.py");
    const invoke = (operation: string, ...args: string[]) => runner.run({ command: "/usr/bin/python3",
        args: [harness, operation, root, ...args], env: { DEVELOPER_DIR: developerDirectory } });
    const original = [
        'import OpenSwiftUI',
        'private struct Card: View { let payload: String }',
        'private enum Scope {',
        '    private static let title = "Compiler title"',
        '    #Preview(title) { Card(payload: "A"); Card(payload: "B") }',
        '    struct Provider: PreviewProvider { static var _allPreviews: [_Preview] { [_Preview(id: 0, content: Card(payload: "P"), displayName: "Provider child")] } }',
        '}',
        '#if false',
        '#Preview("Inactive") { Card(payload: "X") }',
        '#endif',
        'private let text = "你好😀"; #Preview("Same line") { Card(payload: "C") }',
        'private func factory() -> any View { Card(payload: "D") }',
        '#Preview("Factory", body: factory)',
        '#Preview("Capture") { [value = "E"] in Card(payload: value) }',
        '#Preview { Card(payload: "F").previewDisplayName("Root label") }',
        'private let dynamicLabel = "Dynamic label"',
        '#Preview { Card(payload: "G").previewDisplayName(dynamicLabel) }',
        '#Preview("Delimiter") { Card(payload: """',
        '------------------------------',
        '""") }',
        '#Preview { [label = "Capture label"] in Card(payload: "H").previewDisplayName(label) }',
        '#Preview { Card(payload: "I").previewDisplayName("Ignored").previewDisplayName(nil) }',
    ].join("\n");
    try {
        await fs.writeFile(filePath, original);
        await invoke("setup");
        const expansionOutput = (await invoke("expand", filePath)).stdout;
        const options = { source: { kind: "macro" as const, filePath, line: 5, column: 5 }, expansionOutput,
            moduleName: "ExpansionFixture", developerDirectory, storagePath: path.join(root, "Storage"), signal: new AbortController().signal, log: () => {} };
        const overlay = await prepareExpandedSources(options);
        await t.test("compiled bodies execute without loading any macro plugin in the adapter compile", async () => {
            const entries = JSON.parse((await invoke("run", filePath, overlay)).stdout) as Array<Record<string, string>>;
            assert.deepEqual(entries.map(({ name, payload, kind, line, column }) => ({ name, payload, kind, line, column })), [
                { name: "Compiler title", payload: "AB", kind: "macro", line: "5", column: "5" },
                { name: "Provider child", payload: "P", kind: "provider", line: "6", column: "5" },
                { name: "Same line", payload: "C", kind: "macro", line: "11", column: "34" },
                { name: "Factory", payload: "D", kind: "macro", line: "13", column: "1" },
                { name: "Capture", payload: "E", kind: "macro", line: "14", column: "1" },
                { name: "Root label", payload: "F", kind: "macro", line: "15", column: "1" },
                { name: "Dynamic label", payload: "G", kind: "macro", line: "17", column: "1" },
                { name: "Delimiter", payload: "------------------------------", kind: "macro", line: "18", column: "1" },
                { name: "Card", payload: "H", kind: "macro", line: "21", column: "1" },
                { name: "Card", payload: "I", kind: "macro", line: "22", column: "1" },
            ]);
            assert.ok(entries.every(entry => entry.fileID === "ExpansionFixture/Views 世界.swift" && entry.filePath === filePath));
            assert.equal(await fs.readFile(filePath, "utf8"), original);
        });
        await t.test("duplicate identical compiler dumps are safe and cache reuse preserves source", async () => {
            assert.equal(await prepareExpandedSources({ ...options, expansionOutput: expansionOutput + expansionOutput }), overlay);
            assert.equal(await fs.readFile(filePath, "utf8"), original);
        });
        await t.test("an inactive selection and another module cannot select an unrelated expansion", async () => {
            await assert.rejects(prepareExpandedSources({ ...options, source: { ...options.source, line: 9, column: 1 } }), /selected.*no compiled expansion/i);
            await assert.rejects(prepareExpandedSources({ ...options, moduleName: "OtherModule" }), /selected.*no compiled expansion/i);
        });
        await t.test("conflicting dumps fail instead of selecting the first declaration", async () => {
            await assert.rejects(prepareExpandedSources({ ...options, expansionOutput: expansionOutput + expansionOutput.replace('Card(payload: "A")', 'Card(payload: "Wrong")') }), /ambiguous Preview expansions/i);
        });
        await t.test("actual compiler output with traits fails before publishing an adapter that would ignore them", async () => {
            const traits = 'import OpenSwiftUI\nprivate struct Card: View { let payload = "traits" }\n#Preview("Traits", traits: .init()) { Card() }';
            await fs.writeFile(filePath, traits);
            const dump = (await invoke("expand", filePath)).stdout;
            await assert.rejects(prepareExpandedSources({ ...options, expansionOutput: dump,
                source: { ...options.source, line: 3, column: 1 } }), /traits.*not supported/i);
        });
        await t.test("generic provider scopes fail clearly without changing the user's file", async () => {
            const generic = 'import OpenSwiftUI\nprivate struct Generic<T>: PreviewProvider { static var _allPreviews: [_Preview] { [] } }';
            await fs.writeFile(filePath, generic);
            await assert.rejects(prepareExpandedSources({ ...options, expansionOutput: "", source: {
                kind: "provider", providerType: "Generic", filePath, line: 2, column: 9,
            } }), /generic types.*not supported/i);
            assert.equal(await fs.readFile(filePath, "utf8"), generic);
        });
        await t.test("provider-only files need no macro expansion and retain private access", async () => {
            const provider = 'import OpenSwiftUI\nprivate struct Card: View { let payload = "provider-only" }\nprivate struct Only: PreviewProvider { static var _allPreviews: [_Preview] { [_Preview(id: 0, content: Card(), displayName: "Only")] } }';
            await fs.writeFile(filePath, provider);
            const overlay = await prepareExpandedSources({ ...options, expansionOutput: "", source: { kind: "provider", providerType: "Only", filePath, line: 3, column: 9 } });
            const entries = JSON.parse((await invoke("run", filePath, overlay)).stdout);
            assert.equal(entries.length, 1);
            assert.equal(entries[0].payload, "provider-only");
            assert.equal(entries[0].name, "Only");
            assert.equal(await fs.readFile(filePath, "utf8"), provider);
        });
        await t.test("mapped source and cancellation do not publish an unsafe overlay", async () => {
            await fs.writeFile(filePath, '#sourceLocation(file: "Other.swift", line: 20)\n' + original);
            await assert.rejects(prepareExpandedSources(options), /#sourceLocation/);
            const abort = new AbortController(); abort.abort();
            await assert.rejects(prepareExpandedSources({ ...options, signal: abort.signal }), { name: "AbortError" });
        });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
