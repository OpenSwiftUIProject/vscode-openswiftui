import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { prepareProviderSources } from "../src/providerSources";
import { createProcessRunner } from "../src/process";
import { discoverSourcePreviews } from "../src/sourcePreviews";

test("provider instrumentation does not need Xcode without a selected source", async () => {
    assert.equal(await prepareProviderSources(undefined, "/unused", "/unused", new AbortController().signal, () => {}), undefined);
});

test("provider source overlays preserve original files and mapping", { skip: process.platform !== "darwin", timeout: 120000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "preview-provider-source-"));
    const filePath = path.join(root, 'Views 世界 "quoted".swift');
    const storage = path.join(root, "Storage");
    const developerDirectory = (await createProcessRunner().run({ command: "/usr/bin/xcode-select", args: ["-p"] })).stdout.trim();
    const source = [
        'let title = "你好😀"; struct First: PreviewProvider { static var previews: some View { CardView() } }; #Preview { LaterView() }',
        'enum Scope { struct Second: OpenSwiftUI.PreviewProvider { static var previews: some View { DetailView().padding() } } }',
        '#Preview("Last") { LastView() }',
    ].join("\n");
    const prepare = (signal = new AbortController().signal) => prepareProviderSources(
        { kind: "macro", filePath, line: 3, column: 1 }, developerDirectory, storage, signal, () => {},
    );
    try {
        await fs.writeFile(filePath, source);
        let overlayPath: string;
        let annotatedPath: string;
        await t.test("a selected macro also registers every provider in its saved file", async () => {
            overlayPath = (await prepare())!;
            assert.ok(overlayPath);
            const overlay = JSON.parse(await fs.readFile(overlayPath, "utf8"));
            assert.equal(overlay.version, 0);
            assert.equal(overlay["use-external-names"], false);
            assert.ok(overlay.roots.some((entry: { name: string }) => entry.name === filePath));
            annotatedPath = overlay.roots[0]["external-contents"];
            assert.ok(path.isAbsolute(annotatedPath));
            const annotated = await fs.readFile(annotatedPath, "utf8");
            assert.equal((annotated.match(/#_OpenSwiftUIPreviewProvider\(/g) ?? []).length, 2);
            assert.ok(annotated.includes('#_OpenSwiftUIPreviewProvider(First.self,'));
            assert.ok(annotated.includes('#_OpenSwiftUIPreviewProvider(Scope.Second.self,'));
            assert.ok(annotated.includes('typeName: "CardView", childTypeNames: ["CardView"])'));
            assert.ok(annotated.includes('typeName: "DetailView", childTypeNames: ["DetailView"])'));
            assert.ok(annotated.includes('filePath: ' + JSON.stringify(filePath)));
            for (const [index, originalLine] of source.split("\n").entries()) {
                if (!originalLine.includes("PreviewProvider")) continue;
                const brace = originalLine.lastIndexOf(index === 0 ? '}; #Preview' : '} }');
                const column = Buffer.byteLength(originalLine.slice(0, brace));
                assert.ok(annotated.includes(`#sourceLocation(file: ${JSON.stringify(filePath)}, line: ${index + 1})\n${" ".repeat(column)}${originalLine.slice(brace)}`));
            }
            assert.equal(await fs.readFile(filePath, "utf8"), source);
        });

        await t.test("unchanged source reuses the cache while edits produce another overlay", async () => {
            const before = await fs.stat(annotatedPath);
            assert.equal(await prepare(), overlayPath);
            assert.equal((await fs.stat(annotatedPath)).mtimeMs, before.mtimeMs);
            const edited = source.replace("CardView()", "UpdatedView()");
            await fs.writeFile(filePath, edited);
            assert.notEqual(await prepare(), overlayPath);
            assert.equal(await fs.readFile(filePath, "utf8"), edited);
            assert.ok((await fs.readdir(path.join(storage, "ProviderSources"))).every(name => !name.startsWith("preparing-")));
        });

        await t.test("ordinary macro source does not create a provider overlay", async () => {
            await fs.writeFile(filePath, '#Preview { CardView() }');
            assert.equal(await prepare(), undefined);
        });

        await t.test("an incomplete provider fails before it can modify or publish source", async () => {
            const incomplete = 'struct Broken: PreviewProvider { static var previews: some View { CardView() }';
            await fs.writeFile(filePath, incomplete);
            await assert.rejects(prepare(), /incomplete|closing brace/i);
            assert.equal(await fs.readFile(filePath, "utf8"), incomplete);
        });

        await t.test("existing source-location mappings reject provider injection without changing source", async () => {
            const mapped = '#sourceLocation(file: "GeneratedOriginal.swift", line: 100)\nstruct Mapped: PreviewProvider { static var previews: some View { CardView() } }';
            await fs.writeFile(filePath, mapped);
            const before = await fs.readdir(path.join(storage, "ProviderSources"));
            await assert.rejects(prepare(), /PreviewProvider.*#sourceLocation/i);
            assert.equal(await fs.readFile(filePath, "utf8"), mapped);
            assert.deepEqual(await fs.readdir(path.join(storage, "ProviderSources")), before);
        });

        await t.test("real macro expansion retains source locations through active and inactive provider branches", async () => {
            const conditional = [
                'import OpenSwiftUI',
                'private struct Card: View { let payload = "card" }',
                '#if false',
                'private struct Inactive: PreviewProvider { static var _allPreviews: [_Preview] { [] } }',
                '#endif',
                '#Preview("After inactive") { Card() }',
                '#if ENABLE_PROVIDER',
                'private struct Enabled: PreviewProvider { static var _allPreviews: [_Preview] { [] } }',
                '#else',
                'private struct Disabled: PreviewProvider { static var _allPreviews: [_Preview] { [] } }',
                '#endif',
                '#Preview("After conditional") { Card() }',
                'private let label = "你好😀"; private struct Always: PreviewProvider { static var _allPreviews: [_Preview] { [] } }; #Preview("Same line") { Card() }',
                '#Preview("Final") { Card() }',
            ].join("\n");
            await fs.writeFile(filePath, conditional);
            const overlay = await prepare();
            const expected = (await discoverSourcePreviews(conditional, filePath, developerDirectory, storage,
                new AbortController().signal, () => {})).filter(preview => preview.kind === "macro")
                .map(({ name, line, column }) => ({ name, line, column }));
            const script = `
import importlib.util, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("preview_macro_fixture", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
fixture = module.PreviewMacroTests
fixture.setUpClass()
try:
    results = []
    for defines in [[], ["-D", "ENABLE_PROVIDER"]]:
        output = str(fixture.output / "overlay-fixture")
        fixture.run_command(fixture.base + ["-module-name", "OverlayFixture", "-D", "OPENSWIFTUI_STANDALONE_PREVIEW",
            "-I", str(fixture.output), "-L", str(fixture.output), "-lOpenSwiftUI", "-lOpenSwiftUICore",
            "-Xlinker", "-rpath", "-Xlinker", str(fixture.output), "-load-plugin-library", str(fixture.plugin),
            "-vfsoverlay", sys.argv[3], str(module.ROOT / "templates/NativeHost/PreviewMacro.swift"),
            str(module.ROOT / "templates/NativeHost/PreviewRegistry.swift"), "Main.swift", sys.argv[2], "-o", output] + defines)
        listing = fixture.run_command([output, "--openswiftui-list-previews"]).stdout
        results.append(json.loads(listing.removeprefix("OPENSWIFTUI_PREVIEW_LIST:manual:"))["previews"])
    print(json.dumps(results))
finally:
    fixture.tearDownClass()
`;
            const result = await createProcessRunner().run({ command: "/usr/bin/python3", args: ["-c", script,
                path.resolve(__dirname, "../../tools/PreviewMacros/test.py"), filePath, overlay!], env: { DEVELOPER_DIR: developerDirectory } });
            const runs = JSON.parse(result.stdout) as Array<Array<{ name: string; line: number; column: number; filePath: string }>>;
            for (const previews of runs) {
                assert.deepEqual(previews.map(({ name, line, column }) => ({ name, line, column })), expected);
                assert.ok(previews.every(preview => preview.filePath === filePath));
            }
            assert.equal(await fs.readFile(filePath, "utf8"), conditional);
        });

        await t.test("cancellation keeps source and cache intact", async () => {
            const abort = new AbortController(); abort.abort();
            const before = await fs.readFile(filePath);
            await assert.rejects(prepare(abort.signal), { name: "AbortError" });
            assert.deepEqual(await fs.readFile(filePath), before);
        });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
