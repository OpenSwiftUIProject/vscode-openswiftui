import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as configuration from "../src/config";
import type { ControllerOptions, PreviewCase, PreviewDefinition, PreviewRequest, PreviewStatus, SourcePreview } from "../src/types";

function fixture(scheme: string, developerDirectory?: string): Buffer {
    return Buffer.from(JSON.stringify({
        version: 1,
        previews: [{ id: "sample", project: "Host.xcodeproj", scheme, platforms: ["macos"], ...(developerDirectory ? { developerDirectory } : {}) }],
    }));
}

async function harness(source?: string, folders = ["/fixture"], configured = true) {
    let sourceText = source ?? "";
    const sourcePreviews: SourcePreview[] = [
        { name: "First", filePath: "/fixture/View.swift", line: 2, column: 1 },
        { name: "Second", filePath: "/fixture/View.swift", line: 4, column: 1 },
    ];
    const document = {
        uri: { scheme: "file", fsPath: "/fixture/View.swift" }, languageId: "swift", version: 1, isDirty: false,
        getText: () => sourceText,
        lineAt: (line: number) => ({ text: sourceText.split("\n")[line] ?? "" }),
        save: async () => { document.isDirty = false; saves++; return true; },
    };
    let saves = 0;
    let stops = 0;
    let changeDocument!: (event: { document: typeof document }) => void;
    let changeEditor!: () => void;
    let changeFolders!: (event: { removed: Array<{ uri: { scheme: string; fsPath: string } }> }) => Promise<void>;
    let codeLensProvider: { provideCodeLenses(document: unknown): Promise<unknown[]> };
    let treeProvider: { getChildren(): unknown[]; getTreeItem(entry: unknown): { label: string; command: { arguments: unknown[] } } };
    let controllerOptions: ControllerOptions;
    const pickerLabels: string[] = [];
    const scanCalls: Array<{ source: string; signal: AbortSignal; developerDirectory?: string }> = [];
    let parseSource = async (_text: string, signal: AbortSignal): Promise<SourcePreview[]> => sourcePreviews;

    const reads: Array<{ resolve(value: Buffer): void; reject(error: Error): void }> = [];
    const writes: Array<{ filePath: string; text: string }> = [];
    const resolutions: Array<{ source: SourcePreview; folders: readonly string[]; signal: AbortSignal }> = [];
    const automatic: PreviewDefinition = {
        id: "auto-app", name: "App", folder: "/fixture", project: "/fixture/App.xcodeproj", scheme: "App",
        target: "App", configuration: "Debug", platforms: ["macos"], arguments: [], environment: {}, buildArguments: [],
        origin: { kind: "automatic", projectPath: "/fixture/App.xcodeproj", targetID: "APP" },
    };
    let resolveTargets = async (_source: SourcePreview, _signal: AbortSignal): Promise<PreviewDefinition[]> => [automatic];
    let pick = async (items: any[], _options: { placeHolder?: string }): Promise<any> => items[0];
    class FileSystemError extends Error { constructor(readonly code: string) { super(code); } }
    const commands = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const starts: PreviewRequest[] = [];
    const errors: string[] = [];
    let onChange!: () => Promise<void>;
    const noop = () => {};
    const disposable = { dispose: noop };
    const output = { appendLine: noop, error: noop, show: noop, dispose: noop };
    const vscode = {
        EventEmitter: class { event = noop; fire() {} dispose() {} },
        StatusBarAlignment: { Left: 1 },
        FileSystemError,
        CancellationTokenSource: class { token = {}; cancel() {} dispose() {} },
        Uri: { file: (fsPath: string) => ({ scheme: "file", fsPath }), joinPath: (root: { fsPath: string }, part: string) => ({ scheme: "file", fsPath: path.join(root.fsPath, part) }) },
        Range: class { constructor(..._args: unknown[]) {} },
        CodeLens: class { constructor(readonly range: unknown, readonly command: unknown) {} },
        TreeItem: class { constructor(readonly label: string) {} },
        ThemeIcon: class { constructor(readonly id: string) {} },
        env: {},
        languages: { registerCodeLensProvider: (_selector: unknown, provider: typeof codeLensProvider) => { codeLensProvider = provider; return disposable; } },
        window: {
            activeTextEditor: source === undefined ? undefined : { document },
            onDidChangeActiveTextEditor: (callback: () => void) => { changeEditor = callback; return disposable; },
            createOutputChannel: () => output,
            createStatusBarItem: () => ({ hide: noop, show: noop, dispose: noop }),
            registerTreeDataProvider: (_id: string, provider: typeof treeProvider) => { treeProvider = provider; return disposable; },
            showQuickPick: async (items: unknown[], options: { placeHolder?: string }) => { pickerLabels.push(options.placeHolder ?? ""); return pick(items, options); },
            showTextDocument: async () => {},
            showErrorMessage: async (message: string) => { errors.push(message); },
        },
        workspace: {
            isTrusted: true,
            workspaceFolders: folders.map(fsPath => ({ uri: { scheme: "file", fsPath } })),
            fs: {
                readFile: () => new Promise<Buffer>((resolve, reject) => reads.push({ resolve, reject })),
                stat: async () => { throw new FileSystemError("FileNotFound"); },
                createDirectory: async () => {},
                writeFile: async (uri: { fsPath: string }, contents: Uint8Array) => { writes.push({ filePath: uri.fsPath, text: Buffer.from(contents).toString("utf8") }); },
            },
            createFileSystemWatcher: () => ({
                dispose: noop,
                onDidChange: (callback: () => Promise<void>) => { onChange = callback; return disposable; },
                onDidCreate: () => disposable,
                onDidDelete: () => disposable,
            }),
            onDidChangeWorkspaceFolders: (callback: typeof changeFolders) => { changeFolders = callback; return disposable; },
            onDidChangeTextDocument: (callback: typeof changeDocument) => { changeDocument = callback; return disposable; },
            onDidSaveTextDocument: () => disposable,
            openTextDocument: async () => document,
        },
        commands: {
            registerCommand: (id: string, action: (...args: unknown[]) => Promise<unknown>) => {
                commands.set(id, action);
                return disposable;
            },
        },
    };
    const controller = {
        status: { state: "idle", message: "Stopped" } as PreviewStatus,
        run: async (request: PreviewRequest) => {
            starts.push(request);
            controller.status = { state: "running", message: "Running", request: { ...request, previewID: request.previewID ?? "compiled:1" } };
        },
        stop: async () => { stops++; controller.status = { state: "idle", message: "Stopped" }; },
        dispose: async () => {},
    };
    const exports = {} as {
        activate(context: unknown): Promise<{ getPreviews(): PreviewDefinition[]; getSourcePreviews(): SourcePreview[] }>;
        deactivate(): Promise<void>;
    };
    runInNewContext(readFileSync(path.join(__dirname, "../src/extension.js"), "utf8"), {
        exports, Buffer, structuredClone, AbortController, setTimeout, clearTimeout, process: { platform: "darwin" },
        require(name: string): unknown {
            switch (name) {
                case "vscode": return vscode;
                case "node:path": return path;
                case "node:fs/promises": return { realpath: async (file: string) => file };
                case "./config": return configuration;
                case "./backend": return { listSimulators: async () => [] };
                case "./sourcePreviews": return { discoverSourcePreviews: async (text: string, _file: string, developerDirectory: string | undefined, _storage: string, signal: AbortSignal) => { scanCalls.push({ source: text, signal, developerDirectory }); return parseSource(text, signal); } };
                case "./projects": return { resolvePreviewTargets: async (source: SourcePreview, folders: readonly string[], options: { signal: AbortSignal }) => {
                    resolutions.push({ source, folders, signal: options.signal });
                    return resolveTargets(source, options.signal);
                } };
                case "./controller": return { createPreviewController: (options: ControllerOptions) => { controllerOptions = options; return controller; } };
                default: throw new Error(`Unexpected extension dependency: ${name}`);
            }
        },
    });
    const completeRead = (scheme: string, developerDirectory?: string) => {
        const read = reads.shift();
        assert.ok(read, "Expected a pending configuration read.");
        read.resolve(fixture(scheme, developerDirectory));
    };
    const missingRead = () => {
        const read = reads.shift();
        assert.ok(read, "Expected a pending configuration read.");
        read.reject(new FileSystemError("FileNotFound"));
    };
    const finishRefresh = async (profiles: Record<string, string> = {}) => {
        for (const { uri: { fsPath: folder } } of vscode.workspace.workspaceFolders) {
            if (profiles[folder]) completeRead(profiles[folder]); else missingRead();
            await new Promise<void>(resolve => setImmediate(resolve));
        }
    };
    const activation = exports.activate({ extension: { packageJSON: { version: "0.3.0" } }, subscriptions: [], storageUri: { fsPath: "/storage" } });
    for (const folder of folders) {
        if (configured) completeRead("OldScheme", folders.length > 1 ? `${folder}/Xcode.app/Contents/Developer` : undefined);
        else missingRead();
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    const api = await activation;
    return {
        api, starts, errors, completeRead, missingRead, finishRefresh, pickerLabels, scanCalls, document, writes, resolutions, automatic,
        setResolver: (resolver: typeof resolveTargets) => { resolveTargets = resolver; },
        setPicker: (picker: typeof pick) => { pick = picker; },
        dispose: () => exports.deactivate(),
        get saves() { return saves; },
        get stops() { return stops; },
        setParser: (parser: typeof parseSource) => { parseSource = parser; },
        codeLenses: () => codeLensProvider.provideCodeLenses(document),
        treeEntries: () => treeProvider.getChildren(),
        treeItems: () => treeProvider.getChildren().map(entry => treeProvider.getTreeItem(entry)),
        publishPreviews: async (previews: PreviewCase[], request = starts.at(-1)!) => {
            controllerOptions.onPreviews?.(previews, request);
            await new Promise<void>(resolve => setImmediate(resolve));
        },
        edit: (text: string) => { sourceText = text; document.version++; document.isDirty = true; changeDocument({ document }); },
        switchAway: () => { vscode.window.activeTextEditor = undefined; changeEditor(); },
        change: () => onChange(),
        removeFolders: (...removed: string[]) => {
            const removedFolders = vscode.workspace.workspaceFolders.filter(folder => removed.includes(folder.uri.fsPath));
            vscode.workspace.workspaceFolders = vscode.workspace.workspaceFolders.filter(folder => !removed.includes(folder.uri.fsPath));
            return changeFolders({ removed: removedFolders });
        },
        command: (name: string, selection: unknown = JSON.stringify(["/fixture", "sample"])) => commands.get(`openswiftui.preview.${name}`)!(selection),
    };
}

for (const command of ["run", "rebuild"]) {
    test(`${command} waits for a newer configuration refresh before selecting the scheme`, async () => {
        const h = await harness();
        if (command === "rebuild") {
            const initial = h.command("run");
            h.completeRead("OldScheme");
            await initial;
            h.starts.length = 0;
        }

        const running = h.command(command);
        const changed = h.change();
        h.completeRead("NewScheme");
        await new Promise<void>(resolve => setImmediate(resolve));
        const startedBeforeLatestRead = h.starts.length;
        h.completeRead("NewScheme");
        await Promise.all([running, changed]);

        assert.equal(startedBeforeLatestRead, 0, "A superseded refresh must not launch stale configuration.");
        assert.deepEqual(h.starts.map(request => request.preview.scheme), ["NewScheme"]);
        assert.equal(h.api.getPreviews()[0].scheme, "NewScheme");
        assert.deepEqual(h.errors, []);
    });
}

test("Stop cancels Run while it waits for the latest configuration refresh", async () => {
    const h = await harness();
    const running = h.command("run");
    const changed = h.change();
    h.completeRead("NewScheme");
    await new Promise<void>(resolve => setImmediate(resolve));
    await h.command("stop");
    h.completeRead("NewScheme");
    await Promise.all([running, changed]);
    assert.equal(h.starts.length, 0);
    assert.deepEqual(h.errors, []);
});

test("Rebuild retains the compiled selection while a new Run asks for a new selection", async () => {
    const h = await harness();
    const first = h.command("run");
    h.completeRead("Host");
    await first;
    const rebuild = h.command("rebuild");
    h.completeRead("Host");
    await rebuild;
    assert.equal(h.starts[1].previewID, "compiled:1");
    const next = h.command("run");
    h.completeRead("Host");
    await next;
    assert.equal(h.starts[2].previewID, undefined);
    assert.deepEqual(h.errors, []);
});


test("current Swift file lists both declarations and CodeLens before any app build", async () => {
    const h = await harness('import OpenSwiftUI\n#Preview("First") { Text("A") }\n\n#Preview("Second") { Text("B") }');
    assert.deepEqual(h.api.getSourcePreviews().map(value => value.name), ["First", "Second"]);
    assert.equal((await h.codeLenses()).length, 2);
    assert.equal(h.treeEntries().length, 2, "The source list must not include an extra app-target row.");
    assert.equal(h.starts.length, 0);
    assert.equal(h.scanCalls.length, 1);
});

test("Run selects a source declaration before destination and skips a single host picker", async () => {
    const h = await harness('import OpenSwiftUI\n#Preview("First") { Text("A") }\n\n#Preview("Second") { Text("B") }');
    h.document.isDirty = true;
    const running = h.command("run", null);
    h.completeRead("Host");
    await running;
    assert.deepEqual(h.pickerLabels, ["Select a Preview in View.swift", "Select the native Preview destination"]);
    assert.equal(h.starts[0].sourcePreview?.name, "First");
    assert.equal(h.starts[0].previewID, undefined);
    assert.equal(h.saves, 1);
    assert.deepEqual(h.errors, []);
});

test("stale CodeLens selection does not build or silently select a moved declaration", async () => {
    const h = await harness('import OpenSwiftUI\n#Preview("First") { Text("A") }');
    const lens = (await h.codeLenses())[0] as { command: { arguments: unknown[] } };
    h.edit('\nimport OpenSwiftUI\n#Preview("First") { Text("A") }');
    const running = h.command("run", lens.command.arguments[0]);
    h.completeRead("Host");
    await running;
    assert.equal(h.starts.length, 0);
    assert.match(h.errors[0], /changed.*select|select.*again/i);
    h.switchAway();
});

test("switching away cancels a source scan and ignores its late result", async () => {
    const h = await harness('import OpenSwiftUI\n#Preview("First") { Text("A") }');
    let finish!: (value: SourcePreview[]) => void;
    h.setParser(() => new Promise(resolve => { finish = resolve; }));
    h.edit('import OpenSwiftUI\n#Preview("Changed") { Text("A") }');
    const lenses = h.codeLenses();
    await new Promise<void>(resolve => setImmediate(resolve));
    h.switchAway();
    assert.equal(h.scanCalls.at(-1)!.signal.aborted, true);
    finish([{ name: "Stale", filePath: "/fixture/View.swift", line: 2, column: 1 }]);
    await lenses;
    assert.deepEqual(h.api.getSourcePreviews(), []);
    assert.equal(h.starts.length, 0);
});


test("Stop prevents a late source scan from opening a picker or building", async () => {
    const h = await harness('import OpenSwiftUI\n#Preview("First") { Text("A") }');
    let finish!: (value: SourcePreview[]) => void;
    h.setParser(() => new Promise(resolve => { finish = resolve; }));
    h.edit('import OpenSwiftUI\n#Preview("First") { Text("Edited") }');
    const running = h.command("run", null);
    h.completeRead("Host");
    await new Promise<void>(resolve => setImmediate(resolve));
    await h.command("stop");
    finish([{ name: "First", filePath: "/fixture/View.swift", line: 2, column: 1 }]);
    await running;
    assert.equal(h.starts.length, 0);
    assert.deepEqual(h.pickerLabels, []);
    assert.deepEqual(h.errors, []);
});

test("formatting on save invalidates a selected source instead of building another location", async () => {
    const h = await harness('import OpenSwiftUI\n#Preview("First") { Text("A") }');
    h.document.isDirty = true;
    h.document.save = async () => { h.edit('\nimport OpenSwiftUI\n#Preview("First") { Text("A") }'); return true; };
    const running = h.command("run", null);
    h.completeRead("Host");
    await running;
    assert.equal(h.starts.length, 0);
    assert.match(h.errors[0], /source changed/i);
    h.switchAway();
});


test("an explicit app target skips current-file source selection", async () => {
    const h = await harness('import OpenSwiftUI\nstruct OrdinaryView {}');
    h.setParser(async () => []);
    h.edit('import OpenSwiftUI\nstruct OrdinaryView {}\n');
    const running = h.command("run");
    h.completeRead("Host");
    await running;
    assert.equal(h.starts.length, 1);
    assert.equal(h.starts[0].sourcePreview, undefined);
    assert.deepEqual(h.pickerLabels, ["Select the native Preview destination"]);
    assert.deepEqual(h.errors, []);
    h.switchAway();
});


test("source scans use the current file's owning folder toolchain in a multi-root workspace", async () => {
    const h = await harness('import OpenSwiftUI\n#Preview("First") { Text("A") }', ["/unrelated", "/fixture"]);
    assert.equal(h.scanCalls.length, 1);
    assert.equal(h.scanCalls[0].developerDirectory, "/fixture/Xcode.app/Contents/Developer");
    assert.equal(h.starts.length, 0);
    assert.deepEqual(h.errors, []);
});

const sourceFixture = 'import OpenSwiftUI\n#Preview("First") { Text("A") }\n\n#Preview("Second") { Text("B") }';

test("Preview has its own Activity Bar container and does not add an Explorer view", () => {
    const manifest = JSON.parse(readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
    const container = manifest.contributes.viewsContainers.activitybar.find((item: { id: string }) => item.id === "openswiftui-preview");
    assert.equal(container.title, "Preview");
    assert.match(readFileSync(path.join(__dirname, "../..", container.icon), "utf8"), /<svg\b/);
    assert.ok(manifest.contributes.views[container.id].some((view: { id: string }) => view.id === "openswiftui.previews"));
    assert.ok(!manifest.contributes.views.explorer?.some((view: { id: string }) => view.id === "openswiftui.previews"));
});

test("the Preview panel lists both declaration kinds with explicit names or view type fallbacks", async () => {
    const h = await harness(sourceFixture);
    h.setParser(async () => [
        { kind: "macro", name: "Named example", typeName: "CardView", filePath: h.document.uri.fsPath, line: 2, column: 1 },
        { kind: "macro", typeName: "DetailView", filePath: h.document.uri.fsPath, line: 3, column: 1 },
        { kind: "provider", typeName: "ProfileView", providerType: "ProfilePreviews", filePath: h.document.uri.fsPath, line: 4, column: 1 },
        { kind: "macro", filePath: h.document.uri.fsPath, line: 5, column: 1 },
    ]);
    h.edit(sourceFixture);
    assert.equal((await h.codeLenses()).length, 4);
    assert.deepEqual(h.treeItems().map(item => item.label), ["Named example", "DetailView", "ProfileView", "View.swift:5"]);
    assert.equal(h.scanCalls.length, 2, "Panel and CodeLens must share one scan per source version.");
    h.switchAway();
    assert.equal(h.treeItems().length, 0, "App-target configuration is not a current-file preview.");
});

test("compiled provider cases update the panel and run with the exact selected case ID", async () => {
    const h = await harness(sourceFixture);
    const provider: SourcePreview = { kind: "provider", typeName: "CardView", providerType: "CardPreviews", filePath: h.document.uri.fsPath, line: 4, column: 1 };
    h.setParser(async () => [provider]);
    h.edit(sourceFixture);
    await h.codeLenses();
    const running = h.command("run", h.treeItems()[0].command.arguments[0]);
    h.completeRead("Host");
    await running;
    const cases: PreviewCase[] = ["Light", "Dark"].map((name, index) => ({ ...provider, name, id: `provider:${index}`, fileID: "Host/View.swift" }));
    await h.publishPreviews(cases);
    assert.deepEqual(h.treeItems().map(item => item.label), ["Light", "Dark"]);
    const selected = h.command("run", h.treeItems()[1].command.arguments[0]);
    h.completeRead("Host");
    await selected;
    assert.equal(h.starts.at(-1)?.previewID, "provider:1");
    assert.equal(h.starts.at(-1)?.sourcePreview?.providerType, "CardPreviews");
    const rebuild = h.command("rebuild");
    h.completeRead("Host");
    await rebuild;
    assert.equal(h.starts.at(-1)?.previewID, "provider:1", "Rebuild must retain the selected provider case.");
    assert.deepEqual(h.errors, []);
});

test("Rebuild rejects changed declaration identity at the same source position", async t => {
    const macro = { kind: "macro" as const };
    const provider = { kind: "provider" as const, providerType: "CardPreviews" };
    for (const [name, before, after] of [
        ["renamed provider", provider, { ...provider, providerType: "OtherPreviews" }],
        ["macro replaced by provider", macro, provider],
        ["provider replaced by macro", provider, macro],
    ] as const) {
        await t.test(name, async () => {
            const h = await harness(sourceFixture);
            try {
                const source = { filePath: h.document.uri.fsPath, line: 4, column: 1, typeName: "CardView" };
                h.setParser(async () => [{ ...source, ...before }]);
                h.edit(sourceFixture);
                await h.codeLenses();
                const running = h.command("run", h.treeItems()[0].command.arguments[0]);
                h.completeRead("Host");
                await running;
                assert.equal(h.starts.length, 1);

                h.setParser(async () => [{ ...source, ...after }]);
                h.edit(`${sourceFixture}\n`);
                const rebuild = h.command("rebuild");
                h.completeRead("Host");
                await rebuild;
                assert.equal(h.starts.length, 1, "A different declaration must require a new selection.");
                assert.match(h.errors[0], /source changed.*select.*again/i);
            } finally { await h.dispose(); }
        });
    }
});

test("an edit discards compiled names and ignores late preview publication", async () => {
    const h = await harness(sourceFixture);
    const provider: SourcePreview = { kind: "provider", typeName: "CardView", providerType: "CardPreviews", filePath: h.document.uri.fsPath, line: 4, column: 1 };
    h.setParser(async () => [provider]);
    h.edit(sourceFixture);
    await h.codeLenses();
    const running = h.command("run", h.treeItems()[0].command.arguments[0]);
    h.completeRead("Host");
    await running;
    const cases: PreviewCase[] = [{ ...provider, name: "Old runtime name", id: "provider:0", fileID: "Host/View.swift" }];
    await h.publishPreviews(cases);
    assert.equal(h.treeItems()[0].label, "Old runtime name");
    h.edit(`${sourceFixture}\n`);
    await h.codeLenses();
    await h.publishPreviews(cases);
    assert.equal(h.treeItems()[0].label, "CardView");
    assert.deepEqual(h.errors, []);
});

for (const scenario of [
    { name: "removing the owning root stops its nested automatic project", roots: ["/fixture", "/other"], removed: "/fixture", stops: 1 },
    { name: "removing an unrelated root keeps an automatic preview running", roots: ["/fixture", "/other"], removed: "/other", stops: 0 },
    { name: "removing a same-prefix root keeps an automatic preview running", roots: ["/fixt", "/fixture"], removed: "/fixt", stops: 0 },
    { name: "removing a parent root keeps a preview owned by a retained nested root", roots: ["/", "/fixture"], removed: "/", stops: 0 },
]) {
    test(scenario.name, async () => {
        const h = await harness(sourceFixture, scenario.roots, false);
        h.automatic.folder = "/fixture/Example";
        h.automatic.project = "/fixture/Example/App.xcodeproj";
        assert.equal(h.automatic.origin?.kind, "automatic");
        if (h.automatic.origin?.kind === "automatic") h.automatic.origin.projectPath = h.automatic.project;
        const running = h.command("run", null);
        await h.finishRefresh();
        await running;
        assert.equal(h.starts.length, 1);

        const changed = h.removeFolders(scenario.removed);
        await new Promise<void>(resolve => setImmediate(resolve));
        await h.finishRefresh();
        await changed;
        assert.equal(h.stops, scenario.stops);
        assert.deepEqual(h.errors, []);
    });
}

test("Run without configuration resolves the selected source automatically and writes no files", async () => {
    const h = await harness(sourceFixture, ["/fixture"], false);
    const running = h.command("run", null);
    await h.finishRefresh();
    await running;
    assert.equal(h.resolutions.length, 1);
    assert.equal(h.starts[0]?.preview.origin?.kind, "automatic");
    assert.equal(h.starts[0]?.sourcePreview?.line, 2);
    assert.deepEqual(h.pickerLabels, ["Select a Preview in View.swift", "Select the native Preview destination"]);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.errors, []);
});

test("Run with no Swift source and no configuration asks to open a source file without writing JSON", async () => {
    const h = await harness(undefined, ["/fixture"], false);
    const running = h.command("run", null);
    await h.finishRefresh();
    await running;
    assert.equal(h.starts.length, 0);
    assert.match(h.errors[0], /open.*Swift.*file/i);
    assert.deepEqual(h.writes, []);
});

test("source selection ignores explicit targets in unrelated workspace folders", async () => {
    const h = await harness(sourceFixture, ["/unrelated", "/fixture"], false);
    const running = h.command("run", null);
    await h.finishRefresh({ "/unrelated": "Unrelated" });
    await running;
    assert.equal(h.resolutions.length, 1);
    assert.equal(h.starts[0]?.preview.scheme, "App");
    assert.deepEqual(h.resolutions[0].folders, ["/unrelated", "/fixture"]);
    assert.deepEqual(h.errors, []);
});

test("source selection prefers overrides only in the owning workspace folder", async () => {
    const h = await harness(sourceFixture, ["/unrelated", "/fixture"], false);
    const running = h.command("run", null);
    await h.finishRefresh({ "/unrelated": "Unrelated", "/fixture": "Owner" });
    await running;
    assert.equal(h.resolutions.length, 0);
    assert.equal(h.starts[0]?.preview.scheme, "Owner");
    assert.deepEqual(h.errors, []);
});

test("a nested workspace does not inherit its parent folder's explicit target", async () => {
    const h = await harness(sourceFixture, ["/", "/fixture"], false);
    const running = h.command("run", null);
    await h.finishRefresh({ "/": "Parent" });
    await running;
    assert.equal(h.resolutions.length, 1);
    assert.equal(h.starts[0]?.preview.scheme, "App");
    assert.ok(h.scanCalls.every(scan => scan.developerDirectory === undefined));
    assert.deepEqual(h.errors, []);
});

test("ambiguous automatically resolved targets require a target selection", async () => {
    const h = await harness(sourceFixture, ["/fixture"], false);
    h.setResolver(async () => [h.automatic, { ...h.automatic, id: "second", name: "Other", scheme: "Other", origin: { ...h.automatic.origin!, targetID: "OTHER" } }]);
    h.setPicker(async (items, options) => options.placeHolder === "Select the Preview target" ? items[1] : items[0]);
    const running = h.command("run", null);
    await h.finishRefresh();
    await running;
    assert.equal(h.starts[0]?.preview.scheme, "Other");
    assert.ok(h.pickerLabels.includes("Select the Preview target"));
});

test("dismissing ambiguous automatic targets does not select a fallback or write configuration", async () => {
    const h = await harness(sourceFixture, ["/fixture"], false);
    h.setResolver(async () => [h.automatic, { ...h.automatic, id: "second", name: "Other" }]);
    h.setPicker(async (items, options) => options.placeHolder === "Select the Preview target" ? undefined : items[0]);
    const running = h.command("run", null);
    await h.finishRefresh();
    await running;
    assert.equal(h.starts.length, 0);
    assert.equal(h.pickerLabels.length, 2);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.errors, []);
});

for (const action of ["stop", "dispose"] as const) {
    test(`${action} aborts automatic target resolution and prevents late build or errors`, async () => {
        const h = await harness(sourceFixture, ["/fixture"], false);
        let finish!: (value: PreviewDefinition[]) => void;
        h.setResolver(() => new Promise(resolve => { finish = resolve; }));
        const running = h.command("run", null);
        await h.finishRefresh();
        assert.equal(h.resolutions.length, 1);
        if (action === "stop") await h.command("stop"); else await h.dispose();
        assert.equal(h.resolutions[0].signal.aborted, true);
        finish([h.automatic]);
        await running;
        assert.equal(h.starts.length, 0);
        assert.deepEqual(h.errors, []);
    });
}

test("a newer Run aborts the previous automatic resolution and ignores its late failure", async () => {
    const h = await harness(sourceFixture, ["/fixture"], false);
    let fail!: (error: Error) => void;
    h.setResolver(() => new Promise((_resolve, reject) => { fail = reject; }));
    const first = h.command("run", null);
    await h.finishRefresh();
    h.setResolver(async () => [h.automatic]);
    const second = h.command("run", null);
    assert.equal(h.resolutions[0].signal.aborted, true);
    await h.finishRefresh();
    fail(new Error("Superseded metadata failure"));
    await Promise.all([first, second]);
    assert.equal(h.starts.length, 1);
    assert.deepEqual(h.errors, []);
});

test("an edit during automatic target resolution invalidates the selected declaration", async () => {
    const h = await harness(sourceFixture, ["/fixture"], false);
    let finish!: (value: PreviewDefinition[]) => void;
    h.setResolver(() => new Promise(resolve => { finish = resolve; }));
    const running = h.command("run", null);
    await h.finishRefresh();
    h.edit(`\n${sourceFixture}`);
    finish([h.automatic]);
    await running;
    assert.equal(h.starts.length, 0);
    assert.match(h.errors[0], /source changed/i);
    h.switchAway();
});

test("Rebuild resolves an automatic target again using the retained source", async () => {
    const h = await harness(sourceFixture, ["/fixture"], false);
    const first = h.command("run", null);
    await h.finishRefresh();
    await first;
    h.setResolver(async () => [{ ...h.automatic, scheme: "RenamedScheme" }]);
    const rebuild = h.command("rebuild");
    await h.finishRefresh();
    await rebuild;
    assert.equal(h.resolutions.length, 2);
    assert.equal(h.starts[1]?.preview.scheme, "RenamedScheme");
    assert.equal(h.starts[1]?.sourcePreview?.line, 2);
    assert.equal(h.starts[1]?.previewID, undefined);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.errors, []);
});

test("Rebuild resolves a Swift package again without requiring manual configuration", async () => {
    const h = await harness(sourceFixture, ["/fixture"], false);
    h.automatic.origin = { kind: "package", packagePath: "/fixture", targetName: "DemoKit",
        productName: "DemoKit", moduleName: "DemoKit" };
    const first = h.command("run", null);
    await h.finishRefresh();
    await first;
    const rebuild = h.command("rebuild");
    await h.finishRefresh();
    await rebuild;
    assert.equal(h.resolutions.length, 2);
    assert.equal(h.starts[1]?.preview.origin?.kind, "package");
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.errors, []);
});

test("Rebuild applies a newly configured owning-folder override to an automatic selection", async () => {
    const h = await harness(sourceFixture, ["/fixture"], false);
    const first = h.command("run", null);
    await h.finishRefresh();
    await first;
    const rebuild = h.command("rebuild");
    await h.finishRefresh({ "/fixture": "Override" });
    await rebuild;
    assert.equal(h.resolutions.length, 1);
    assert.equal(h.starts[1]?.preview.scheme, "Override");
    assert.equal(h.starts[1]?.sourcePreview?.line, 2);
    assert.deepEqual(h.errors, []);
});

test("Configure creates only an empty optional overrides file", async () => {
    const h = await harness(undefined, ["/fixture"], false);
    await h.command("configure");
    assert.equal(h.writes.length, 1);
    assert.deepEqual(JSON.parse(h.writes[0].text), { version: 1, previews: [] });
});
