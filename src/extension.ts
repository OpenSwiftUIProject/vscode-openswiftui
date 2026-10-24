import * as vscode from "vscode";
import * as path from "node:path";
import { realpath } from "node:fs/promises";
import { configurationPath, parseConfiguration, starterConfiguration } from "./config";
import { listSimulators } from "./backend";
import { createPreviewController } from "./controller";
import { discoverSourcePreviews } from "./sourcePreviews";
import { resolvePreviewTargets } from "./projects";
import { Destination, PreviewCase, PreviewController, PreviewDefinition, PreviewRequest, PreviewStatus, SourcePreview } from "./types";

let controller: PreviewController | undefined;
let cancelPendingSelection: (() => void) | undefined;

function key(preview: PreviewDefinition): string {
    return JSON.stringify([preview.folder, preview.id]);
}

interface SourceSelection {
    kind: "source";
    preview: SourcePreview;
    documentVersion: number;
    compiled?: PreviewCase;
}

function sourceKey(source: SourcePreview): string {
    return JSON.stringify([source.filePath, source.line, source.column, source.kind ?? "macro", source.providerType]);
}

function previewName(preview: SourcePreview | PreviewCase): string {
    return preview.name ?? preview.typeName ?? `${path.basename(preview.filePath ?? ("fileID" in preview ? preview.fileID : "Preview"))}:${preview.line}`;
}

class PreviewTree implements vscode.TreeDataProvider<SourceSelection> {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;
    previews: PreviewDefinition[] = [];
    sources: SourceSelection[] = [];
    private compiled = new Map<string, PreviewCase[]>();

    getTreeItem(selection: SourceSelection): vscode.TreeItem {
        const source = selection.preview;
        const item = new vscode.TreeItem(previewName(selection.compiled ? { ...source, ...selection.compiled } : source));
        item.id = JSON.stringify([sourceKey(source), selection.compiled?.id]);
        item.description = `${path.basename(source.filePath)}:${source.line}`;
        item.tooltip = `${source.kind === "provider" ? "PreviewProvider" : "#Preview"} · ${source.filePath}:${source.line}:${source.column}`;
        item.iconPath = new vscode.ThemeIcon("play-circle");
        item.command = { command: "openswiftui.preview.run", title: "Run Preview", arguments: [selection] };
        return item;
    }

    getChildren(): SourceSelection[] {
        return this.sources.flatMap(source => this.compiled.get(sourceKey(source.preview))?.map(compiled => ({ ...source, compiled })) ?? [source]);
    }
    update(previews: PreviewDefinition[]): void { this.previews = previews; this.emitter.fire(); }
    updateSources(sources: SourceSelection[]): void { this.sources = sources; this.compiled.clear(); this.emitter.fire(); }
    updateCompiled(compiled: Map<string, PreviewCase[]>): void { this.compiled = compiled; this.emitter.fire(); }
    dispose(): void { this.emitter.dispose(); }
}

function isSourceSelection(value: unknown): value is SourceSelection {
    if (!value || typeof value !== "object" || !("kind" in value) || value.kind !== "source" ||
        !("documentVersion" in value) || !Number.isSafeInteger(value.documentVersion) || !("preview" in value)) return false;
    const preview = value.preview;
    return !!preview && typeof preview === "object" && "filePath" in preview && typeof preview.filePath === "string" &&
        path.isAbsolute(preview.filePath) && "line" in preview && Number.isSafeInteger(preview.line) && (preview.line as number) > 0 &&
        "column" in preview && Number.isSafeInteger(preview.column) && (preview.column as number) > 0;
}

export async function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel("OpenSwiftUI Preview", { log: true });
    output.appendLine(`OpenSwiftUI Preview ${context.extension.packageJSON.version} activated.`);
    const tree = new PreviewTree();
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    status.command = "openswiftui.preview.logs";
    context.subscriptions.push(output, tree, status, vscode.window.registerTreeDataProvider("openswiftui.previews", tree));
    function displayStatus(update: PreviewStatus): void {
        const icon = ["building", "discovering", "starting", "stopping"].includes(update.state) ? "$(sync~spin)" : update.state === "running" ? "$(play)" : "$(preview)";
        status.text = `${icon} OpenSwiftUI: ${update.state}`;
        status.tooltip = update.message;
        if (update.state === "idle") status.hide(); else status.show();
    }
    controller = createPreviewController({
        log: message => output.appendLine(message),
        onStatus: displayStatus,
        onPreviews(previews, request) { void publishCompiledPreviews(previews, request).catch(error => output.error(String(error))); },
        async selectPreview(previews, _request, signal) {
            const generation = selectionVersion;
            const cancellation = new vscode.CancellationTokenSource();
            const abort = () => cancellation.cancel();
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
            try {
                const selected = await vscode.window.showQuickPick(previews.map(preview => ({
                    label: previewName(preview),
                    description: `${preview.fileID}:${preview.line}:${preview.column}`,
                    preview,
                })), { title: "OpenSwiftUI Preview", placeHolder: "Select a compiled preview" }, cancellation.token);
                return generation === selectionVersion ? selected?.preview : undefined;
            } finally {
                signal.removeEventListener("abort", abort);
                cancellation.dispose();
            }
        },
    });
    let lastRequest: PreviewRequest | undefined;
    let refreshVersion = 0;
    let latestRefresh: Promise<void> = Promise.resolve();
    let selectionVersion = 0;
    let selectionAbort: AbortController | undefined;
    let configErrors = new Map<string, string>();
    const storagePath = (context.storageUri ?? context.globalStorageUri).fsPath;
    const lensesChanged = new vscode.EventEmitter<void>();
    let sourceScan: { filePath: string; version: number; developerDirectory?: string; abort: AbortController; promise: Promise<SourcePreview[]> } | undefined;
    let sourceTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let publication: { request: PreviewRequest; selectionVersion: number; filePath: string; documentVersion: number } | undefined;

    function trackDiscovery(request: PreviewRequest): void {
        const document = sourceDocument();
        publication = document ? { request, selectionVersion, filePath: document.uri.fsPath, documentVersion: document.version } : undefined;
    }

    async function publishCompiledPreviews(previews: PreviewCase[], request: PreviewRequest): Promise<void> {
        const pending = publication;
        const current = () => !!pending && publication === pending && !disposed && pending.request === request &&
            pending.selectionVersion === selectionVersion && sourceDocument()?.uri.fsPath === pending.filePath &&
            sourceDocument()?.version === pending.documentVersion;
        if (!current()) return;
        const canonical = (file: string) => realpath(file).catch(() => path.resolve(file));
        const filePath = await canonical(pending!.filePath);
        const paths = new Map(await Promise.all([...new Set(previews.flatMap(preview => preview.filePath ? [preview.filePath] : []))]
            .map(async file => [file, await canonical(file)] as const)));
        if (!current()) return;
        const compiled = new Map<string, PreviewCase[]>();
        for (const source of tree.sources) {
            const matches = previews.filter(preview => preview.filePath && paths.get(preview.filePath) === filePath &&
                preview.line === source.preview.line && preview.column === source.preview.column &&
                (preview.kind ?? "macro") === (source.preview.kind ?? "macro") &&
                (source.preview.kind !== "provider" || preview.providerType === source.preview.providerType));
            if (matches.length) compiled.set(sourceKey(source.preview), matches);
        }
        tree.updateCompiled(compiled);
    }

    function cancelSelection(): void {
        publication = undefined;
        ++selectionVersion;
        selectionAbort?.abort();
        selectionAbort = undefined;
    }

    function beginSelection() {
        cancelSelection();
        const abort = new AbortController();
        selectionAbort = abort;
        const version = selectionVersion;
        return { signal: abort.signal, current: () => !disposed && !abort.signal.aborted && version === selectionVersion };
    }

    function owningFolder(filePath: string, folders = vscode.workspace.workspaceFolders ?? []): string | undefined {
        return folders.filter(folder => {
            if (folder.uri.scheme !== "file") return false;
            const relative = path.relative(folder.uri.fsPath, filePath);
            return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        }).sort((left, right) => right.uri.fsPath.length - left.uri.fsPath.length)[0]?.uri.fsPath;
    }

    function sourceDocument(document = vscode.window.activeTextEditor?.document): vscode.TextDocument | undefined {
        return vscode.workspace.isTrusted && !vscode.env.remoteName && process.platform === "darwin" &&
            document?.uri.scheme === "file" && document.languageId === "swift" ? document : undefined;
    }

    function selectedDeveloperDirectory(document = sourceDocument()): string | undefined {
        const folder = document ? owningFolder(document.uri.fsPath) : undefined;
        const profiles = document ? tree.previews.filter(preview => preview.folder === folder) : tree.previews;
        const selected = lastRequest && profiles.find(preview => key(preview) === key(lastRequest!.preview));
        return (selected ?? profiles[0])?.developerDirectory;
    }

    function clearSourceScan(): void {
        publication = undefined;
        if (sourceTimer) clearTimeout(sourceTimer);
        sourceTimer = undefined;
        sourceScan?.abort.abort();
        sourceScan = undefined;
        tree.updateSources([]);
        lensesChanged.fire();
    }

    async function scanSources(document = sourceDocument(), profile?: PreviewDefinition): Promise<SourcePreview[]> {
        const developerDirectory = profile ? profile.developerDirectory : selectedDeveloperDirectory(document);
        if (!document || !sourceDocument(document) || disposed) return [];
        if (sourceTimer) clearTimeout(sourceTimer);
        sourceTimer = undefined;
        if (sourceScan?.filePath === document.uri.fsPath && sourceScan.version === document.version &&
            sourceScan.developerDirectory === developerDirectory) return sourceScan.promise;
        sourceScan?.abort.abort();
        const scan = {
            filePath: document.uri.fsPath, version: document.version, developerDirectory,
            abort: new AbortController(), promise: Promise.resolve([] as SourcePreview[]),
        };
        sourceScan = scan;
        scan.promise = discoverSourcePreviews(document.getText(), scan.filePath, developerDirectory, storagePath,
            scan.abort.signal, message => output.appendLine(message)).then(previews => {
                if (sourceScan !== scan || disposed || scan.abort.signal.aborted || document.version !== scan.version) return [];
                if (vscode.window.activeTextEditor?.document.uri.fsPath === scan.filePath) {
                    tree.updateSources(previews.map(preview => ({ kind: "source", preview, documentVersion: scan.version })));
                    lensesChanged.fire();
                }
                return previews;
            }).catch(error => {
                if (sourceScan !== scan || scan.abort.signal.aborted || disposed) return [];
                sourceScan = undefined;
                tree.updateSources([]);
                throw error;
            });
        return scan.promise;
    }

    function refreshSources(debounce = false): void {
        clearSourceScan();
        const scan = () => { sourceTimer = undefined; void scanSources().catch(error => output.error(String(error))); };
        if (debounce) sourceTimer = setTimeout(scan, 250); else scan();
    }

    cancelPendingSelection = () => { disposed = true; cancelSelection(); clearSourceScan(); };
    context.subscriptions.push(lensesChanged, { dispose() { disposed = true; cancelSelection(); clearSourceScan(); } });
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: "swift", scheme: "file" }, {
        onDidChangeCodeLenses: lensesChanged.event,
        async provideCodeLenses(document) {
            if (document.uri.fsPath !== vscode.window.activeTextEditor?.document.uri.fsPath || !sourceDocument(document)) return [];
            const version = document.version;
            let previews: SourcePreview[];
            try { previews = await scanSources(document); }
            catch (error) { output.error(String(error)); return []; }
            if (document.version !== version || document.uri.fsPath !== vscode.window.activeTextEditor?.document.uri.fsPath) return [];
            return previews.map(preview => {
                // SwiftSyntax reports UTF-8 columns; VS Code ranges use UTF-16 characters.
                const character = Buffer.from(document.lineAt(preview.line - 1).text).subarray(0, preview.column - 1).toString("utf8").length;
                return new vscode.CodeLens(new vscode.Range(preview.line - 1, character, preview.line - 1, character), {
                    title: "Run Preview", command: "openswiftui.preview.run",
                    arguments: [{ kind: "source", preview, documentVersion: version } satisfies SourceSelection],
                });
            });
        },
    }));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => refreshSources()));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.fsPath === vscode.window.activeTextEditor?.document.uri.fsPath) refreshSources(true);
    }));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
        if (document.uri.fsPath === vscode.window.activeTextEditor?.document.uri.fsPath) refreshSources(true);
    }));

    async function loadConfiguration(version: number): Promise<void> {
        const previews: PreviewDefinition[] = [];
        const errors = new Map<string, string>();
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (folder.uri.scheme !== "file") continue;
            const uri = vscode.Uri.joinPath(folder.uri, configurationPath);
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                previews.push(...parseConfiguration(Buffer.from(bytes).toString("utf8"), folder.uri.fsPath));
            } catch (error) {
                if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") continue;
                const message = `${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`;
                errors.set(folder.uri.fsPath, message);
                output.error(message);
            }
        }
        if (version !== refreshVersion) return;
        configErrors = errors;
        tree.update(previews);
    }

    async function refresh(): Promise<void> {
        latestRefresh = loadConfiguration(++refreshVersion);
        let pending: Promise<void>;
        do {
            pending = latestRefresh;
            await pending;
            // Commands must wait for any watcher read that supersedes their own read.
        } while (pending !== latestRefresh);
    }

    function requireLocalTrustedWorkspace(): void {
        if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before running a Preview.");
        if (vscode.env.remoteName || process.platform !== "darwin") {
            throw new Error("Native Preview currently requires a local macOS workspace with Xcode. Remote and Linux hosts are not yet supported.");
        }
    }

    async function configure(): Promise<void> {
        const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === "file");
        const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: "Select the folder that owns your Preview app" });
        if (!folder || folder.uri.scheme !== "file") {
            if (!folders.length) throw new Error("Open a local project folder before configuring Previews.");
            return;
        }
        const uri = vscode.Uri.joinPath(folder.uri, configurationPath);
        try { await vscode.workspace.fs.stat(uri); }
        catch (error) {
            if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") throw error;
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ".vscode"));
            await vscode.workspace.fs.writeFile(uri, Buffer.from(`${JSON.stringify(starterConfiguration, null, 2)}\n`));
        }
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    }

    async function pickItem<T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions, signal: AbortSignal): Promise<T | undefined> {
        if (signal.aborted) return undefined;
        const cancellation = new vscode.CancellationTokenSource();
        const abort = () => cancellation.cancel();
        signal.addEventListener("abort", abort, { once: true });
        try {
            const selected = await vscode.window.showQuickPick(items, options, cancellation.token);
            return signal.aborted ? undefined : selected;
        } finally {
            signal.removeEventListener("abort", abort);
            cancellation.dispose();
        }
    }

    async function selectTarget(source: SourcePreview | undefined, signal: AbortSignal, previous?: PreviewDefinition): Promise<PreviewDefinition | undefined> {
        const folder = source ? owningFolder(source.filePath) : undefined;
        let previews = source ? tree.previews.filter(preview => preview.folder === folder) : tree.previews;
        const error = source ? (folder ? configErrors.get(folder) : undefined) : !previews.length ? configErrors.values().next().value : undefined;
        if (error) throw new Error(`Fix the Preview configuration first. ${error}`);
        if (source && !previews.length) {
            status.text = "$(sync~spin) OpenSwiftUI: resolving";
            status.tooltip = "Finding the owning app or Swift package target…";
            status.show();
            try {
                previews = await resolvePreviewTargets(source,
                    (vscode.workspace.workspaceFolders ?? []).filter(item => item.uri.scheme === "file").map(item => item.uri.fsPath), {
                        developerDirectory: previous?.developerDirectory, storagePath, signal,
                        log: message => output.appendLine(message),
                    });
            } finally {
                if (selectionAbort?.signal === signal && !signal.aborted) displayStatus(controller!.status);
            }
        }
        if (signal.aborted) return undefined;
        if (!previews.length) throw new Error("Open a Swift file containing #Preview or PreviewProvider, then run Preview.");
        const retained = previous && previews.find(preview => key(preview) === key(previous));
        if (retained) return retained;
        if (previews.length === 1) return previews[0];
        return (await pickItem(previews.map(preview => ({
            label: preview.name, description: path.basename(preview.folder), detail: preview.scheme, preview,
        })), { placeHolder: "Select the Preview target" }, signal))?.preview;
    }

    async function selectDestination(preview: PreviewDefinition, signal: AbortSignal): Promise<Destination | undefined> {
        const destinations: Destination[] = preview.platforms.includes("macos") ? [{ platform: "macos", name: "This Mac" }] : [];
        if (preview.platforms.includes("ios-simulator")) {
            try { destinations.push(...await listSimulators(preview.developerDirectory)); }
            catch (error) {
                if (signal.aborted) return undefined;
                output.error(String(error));
                if (!destinations.length) throw error;
                void vscode.window.showWarningMessage("Could not list iOS Simulators. This Mac is still available. See the Preview log.");
            }
        }
        if (signal.aborted) return undefined;
        if (!destinations.length) throw new Error("No compatible destination is available. Install an iOS Simulator runtime in Xcode.");
        const picked = await pickItem(destinations.map(destination => ({
            label: destination.name,
            description: destination.platform === "macos" ? "macOS" : destination.udid,
            destination,
        })), { title: "OpenSwiftUI Preview", placeHolder: "Select the native Preview destination" }, signal);
        return picked?.destination;
    }

    async function validateSource(selection: SourceSelection, profile?: PreviewDefinition, save = false): Promise<SourcePreview> {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(selection.preview.filePath));
        const changed = () => new Error("The selected Preview source changed. Select the declaration again from the current file.");
        if (!sourceDocument(document) || document.version !== selection.documentVersion) throw changed();
        if (save && document.isDirty && !await document.save()) throw new Error("Save the selected Swift file before running Preview.");
        if (document.version !== selection.documentVersion) throw changed();
        const previews = await scanSources(document, profile);
        if (document.version !== selection.documentVersion) throw changed();
        const selected = previews.find(preview => preview.filePath === selection.preview.filePath &&
            preview.line === selection.preview.line && preview.column === selection.preview.column);
        if (!selected) throw changed();
        return selected;
    }

    async function run(selectedKey?: unknown): Promise<void> {
        requireLocalTrustedWorkspace();
        const selection = beginSelection();
        try {
            await refresh();
            if (!selection.current()) return;
            let sourceSelection = isSourceSelection(selectedKey) ? selectedKey : undefined;
            const document = sourceDocument();
            if (sourceSelection) {
                await validateSource(sourceSelection);
            } else if (document && typeof selectedKey !== "string") {
                const version = document.version;
                const previews = await scanSources(document);
                if (!selection.current()) return;
                if (!previews.length) throw new Error(`No preview declarations were found in ${path.basename(document.uri.fsPath)}.`);
                const choices = tree.getChildren().filter(item => item.preview.filePath === document.uri.fsPath && item.documentVersion === version);
                const selected = await pickItem(choices.map(choice => ({
                    label: previewName(choice.compiled ? { ...choice.preview, ...choice.compiled } : choice.preview),
                    description: `${path.basename(choice.preview.filePath)}:${choice.preview.line}`, choice,
                })), { title: "OpenSwiftUI Preview", placeHolder: `Select a Preview in ${path.basename(document.uri.fsPath)}` }, selection.signal);
                if (!selected || !selection.current()) return;
                sourceSelection = selected.choice;
            }
            if (!selection.current()) return;
            const preview = typeof selectedKey === "string" ? tree.previews.find(item => key(item) === selectedKey) :
                await selectTarget(sourceSelection?.preview, selection.signal);
            if (typeof selectedKey === "string" && !preview) {
                throw new Error("The selected Preview target was removed or its configuration is invalid. Run Preview to select another.");
            }
            if (!preview || !selection.current()) return;
            const destination = await selectDestination(preview, selection.signal);
            if (!destination || !selection.current()) return;
            const sourcePreview = sourceSelection ? await validateSource(sourceSelection, preview, true) : undefined;
            if (!selection.current()) return;
            lastRequest = { preview, destination, storagePath, previewID: sourcePreview ? sourceSelection?.compiled?.id : preview.previewID, sourcePreview };
            trackDiscovery(lastRequest);
            output.show(true);
            await controller!.run(lastRequest);
            if (selection.current() && controller!.status.state === "running") lastRequest = controller!.status.request;
        } catch (error) {
            if (selection.current()) throw error;
        }
    }

    function command(id: string, action: (...args: unknown[]) => unknown): void {
        context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => {
            try { return await action(...args); }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                output.error(message);
                void vscode.window.showErrorMessage(message, "Show Log").then(choice => {
                    if (choice === "Show Log") output.show(true);
                });
            }
        }));
    }

    command("openswiftui.preview.run", run);
    command("openswiftui.preview.stop", async () => { cancelSelection(); await controller!.stop(); });
    command("openswiftui.preview.rebuild", async () => {
        requireLocalTrustedWorkspace();
        if (!lastRequest) { await run(); return; }
        const selection = beginSelection();
        const previousRequest = lastRequest;
        try {
            await refresh();
            if (!selection.current()) return;
            let preview = previousRequest.preview.origin ? undefined :
                tree.previews.find(item => key(item) === key(previousRequest.preview));
            if (!preview && !previousRequest.preview.origin) {
                throw new Error("The selected Preview was removed or its configuration is invalid. Run Preview to select another.");
            }
            let sourceSelection: SourceSelection | undefined;
            if (previousRequest.sourcePreview) {
                const sourcePreview = previousRequest.sourcePreview;
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePreview.filePath));
                const version = document.version;
                const source = await scanSources(document, preview);
                if (!selection.current()) return;
                const selected = source.find(item => sourceKey(item) === sourceKey(sourcePreview) && item.name === sourcePreview.name);
                if (!selected) throw new Error("The selected Preview source changed. Run Preview to select the declaration again.");
                sourceSelection = { kind: "source", preview: selected, documentVersion: version };
            }
            if (!preview) {
                if (!sourceSelection) throw new Error("Run Preview from a Swift source file to resolve its target again.");
                preview = await selectTarget(sourceSelection.preview, selection.signal, previousRequest.preview);
            }
            if (!preview || !selection.current()) return;
            if (!preview.platforms.includes(previousRequest.destination.platform)) {
                throw new Error("The selected destination is no longer supported. Run Preview to select another.");
            }
            const sourcePreview = sourceSelection ? await validateSource(sourceSelection, preview, true) : undefined;
            if (!selection.current()) return;
            lastRequest = { ...previousRequest, preview, sourcePreview, previewID: sourcePreview ? (sourcePreview.kind === "provider" ? previousRequest.previewID : undefined) : preview.previewID ?? previousRequest.previewID };
            trackDiscovery(lastRequest);
            output.show(true);
            await controller!.run(lastRequest);
            if (selection.current() && controller!.status.state === "running") lastRequest = controller!.status.request;
        } catch (error) {
            if (selection.current()) throw error;
        }
    });
    command("openswiftui.preview.configure", configure);
    command("openswiftui.preview.logs", () => output.show(true));
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${configurationPath}`);
    const configurationChanged = async () => { await refresh(); refreshSources(); };
    context.subscriptions.push(watcher, watcher.onDidChange(configurationChanged), watcher.onDidCreate(configurationChanged), watcher.onDidDelete(configurationChanged));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async event => {
        cancelSelection();
        const current = controller?.status.request ?? lastRequest;
        const previousFolder = current && owningFolder(current.sourcePreview?.filePath ?? current.preview.folder,
            [...(vscode.workspace.workspaceFolders ?? []), ...event.removed]);
        if (previousFolder && event.removed.some(folder => folder.uri.fsPath === previousFolder)) {
            lastRequest = undefined;
            await controller?.stop();
        }
        await refresh();
        refreshSources();
    }));
    await refresh();
    try { await scanSources(); } catch (error) { output.error(String(error)); }
    return {
        getStatus: (): PreviewStatus => controller!.status,
        getPreviews: (): PreviewDefinition[] => structuredClone(tree.previews),
        getSourcePreviews: (): SourcePreview[] => structuredClone(tree.sources.map(source => source.preview)),
    };
}

export async function deactivate(): Promise<void> {
    cancelPendingSelection?.();
    cancelPendingSelection = undefined;
    await controller?.dispose();
    controller = undefined;
}
