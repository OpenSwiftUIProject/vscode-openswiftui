import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    Command, CommandOptions, CommandResult, createProcessRunner, ManagedProcess,
    ProcessExit, ProcessRunner, cancellationError, throwIfCancelled,
} from "./process";
import { Destination, PreviewCase, PreviewDefinition, PreviewRequest } from "./types";
import { preparePreviewMacros } from "./macros";
import { automaticBundleIdentifier, finalizeAutomaticApp, prepareAutomaticHost } from "./automaticHost";
import { prepareProviderSources } from "./providerSources";
import { prepareExpandedSources } from "./expandedSources";
import { packageBundleIdentifier, packageHostModuleName, preparePackageHost } from "./packageHost";

export interface PreviewArtifact {
    appPath: string;
    executablePath: string;
    bundleIdentifier: string;
    developerDirectory: string;
    moduleName?: string;
}

export interface PreviewSession {
    readonly exited: Promise<ProcessExit>;
    stop(): Promise<void>;
}

/** Retains a host handle when startup and its cleanup both fail. */
export class PreviewStartError extends Error {
    constructor(message: string, readonly session: PreviewSession, cause: unknown) {
        super(message, { cause });
        this.name = "PreviewStartError";
    }
}

export interface PreviewBackend {
    build(request: PreviewRequest, signal: AbortSignal): Promise<PreviewArtifact>;
    discover(artifact: PreviewArtifact, request: PreviewRequest, sessionID: string,
        signal: AbortSignal, timeoutMs: number): Promise<PreviewCase[]>;
    start(artifact: PreviewArtifact, request: PreviewRequest, sessionID: string,
        signal: AbortSignal, readyTimeoutMs: number): Promise<PreviewSession>;
}

export interface BackendDependencies {
    processes: ProcessRunner;
    isFile(file: string): Promise<boolean>;
    isDirectory(directory: string): Promise<boolean>;
    mkdir(directory: string): Promise<void>;
    readSource(file: string): Promise<string>;
    prepareMacros(developerDirectory: string, storagePath: string, signal: AbortSignal): Promise<string>;
    prepareAutomaticHost(request: PreviewRequest, developerDirectory: string, macroLibrary: string,
        signal: AbortSignal, sourceOverlay?: string, compilerFlags?: string[]): Promise<PreviewDefinition>;
    preparePackageHost(request: PreviewRequest, developerDirectory: string, signal: AbortSignal): Promise<PreviewDefinition>;
    prepareExpandedSources(request: PreviewRequest, developerDirectory: string, expansionOutput: string,
        moduleName: string, signal: AbortSignal): Promise<string>;
    prepareProviderSources(request: PreviewRequest, developerDirectory: string, signal: AbortSignal): Promise<string | undefined>;
    finalizeAutomaticApp(appPath: string, destination: Destination, bundleIdentifier: string, signal: AbortSignal): Promise<void>;
}

export interface AppBuildSettings {
    target: string;
    buildSettings: Record<string, string>;
}

export function selectAppBuildSettings(json: unknown, target?: string): AppBuildSettings {
    if (!Array.isArray(json)) { throw new Error("Xcode returned invalid build settings."); }
    const applications = json.filter((entry): entry is AppBuildSettings => {
        const settings = entry?.buildSettings;
        return typeof entry?.target === "string" && settings &&
            settings.PRODUCT_TYPE === "com.apple.product-type.application" &&
            typeof settings.FULL_PRODUCT_NAME === "string" && settings.FULL_PRODUCT_NAME.endsWith(".app");
    });
    const selected = target ? applications.filter(entry => entry.target === target) : applications;
    if (selected.length !== 1) {
        const names = applications.map(entry => entry.target).join(", ") || "none";
        throw new Error(target
            ? `Expected exactly one app target named "${target}". Available app targets: ${names}.`
            : `The scheme must contain exactly one app target. Set "target" to select one. Available app targets: ${names}.`);
    }
    return selected[0]!;
}

async function developerDirectory(runner: ProcessRunner, configured?: string, signal?: AbortSignal): Promise<string> {
    const selected = configured ?? (await runner.run({ command: "/usr/bin/xcode-select", args: ["-p"] }, { signal })).stdout.trim();
    if (!path.isAbsolute(selected)) { throw new Error("Select a full Xcode installation or set developerDirectory."); }
    return selected;
}

function xcrun(directory: string, args: string[], cwd?: string): Command {
    return { command: "/usr/bin/xcrun", args, cwd, env: { DEVELOPER_DIR: directory } };
}

export async function listSimulators(configuredDeveloperDirectory?: string): Promise<Array<Extract<Destination, { platform: "ios-simulator" }>>> {
    const runner = createProcessRunner();
    const directory = await developerDirectory(runner, configuredDeveloperDirectory);
    const result = await runner.run(xcrun(directory, ["simctl", "list", "devices", "available", "--json"]));
    const json: unknown = JSON.parse(result.stdout);
    if (typeof json !== "object" || json === null || !("devices" in json) || typeof json.devices !== "object" || json.devices === null) {
        throw new Error("Simulator returned an invalid device list.");
    }
    const devices: Array<Extract<Destination, { platform: "ios-simulator" }>> = [];
    for (const [runtime, entries] of Object.entries(json.devices)) {
        if (!/\.iOS-/.test(runtime) || !Array.isArray(entries)) { continue; }
        for (const device of entries) {
            if (device?.isAvailable !== false && typeof device?.name === "string" && typeof device?.udid === "string") {
                devices.push({ platform: "ios-simulator", name: `${device.name} (${runtime.split(".iOS-")[1]!.replaceAll("-", ".")})`, udid: device.udid });
            }
        }
    }
    return devices.sort((a, b) => a.name.localeCompare(b.name) || a.udid.localeCompare(b.udid));
}

function requiredSetting(settings: Record<string, string>, name: string): string {
    const value = settings[name];
    if (!value || typeof value !== "string" || value.includes("$(")) {
        throw new Error(`Xcode did not resolve the ${name} build setting.`);
    }
    return value;
}

function contained(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function embeddedAppExtension(appPath: string, signal: AbortSignal): Promise<string | undefined> {
    const pending = [appPath];
    while (pending.length) {
        throwIfCancelled(signal);
        const directory = pending.pop()!;
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const file = path.join(directory, entry.name);
            if (entry.name.endsWith(".appex")) return path.relative(appPath, file);
            pending.push(file);
        }
    }
    return undefined;
}

export function createPreviewBackend(log: (message: string) => void, overrides: Partial<BackendDependencies> = {}): PreviewBackend {
    const dependencies: BackendDependencies = {
        processes: createProcessRunner(),
        async isFile(file) { try { return (await fs.stat(file)).isFile(); } catch { return false; } },
        async isDirectory(directory) { try { return (await fs.stat(directory)).isDirectory(); } catch { return false; } },
        async mkdir(directory) { await fs.mkdir(directory, { recursive: true }); },
        async readSource(file) { return fs.readFile(file, "utf8"); },
        async prepareMacros(directory, storagePath, signal) {
            return preparePreviewMacros(directory, storagePath, dependencies.processes, signal, log);
        },
        async prepareAutomaticHost(request, directory, macroLibrary, signal, sourceOverlay, compilerFlags) {
            return prepareAutomaticHost(request, directory, macroLibrary, dependencies.processes, signal, log, sourceOverlay, compilerFlags);
        },
        async preparePackageHost(request, directory, signal) {
            return preparePackageHost(request, directory, dependencies.processes, signal, log);
        },
        async prepareExpandedSources(request, directory, expansionOutput, moduleName, signal) {
            if (!request.sourcePreview) throw new Error("Select a source declaration before compiling a Preview.");
            return prepareExpandedSources({ source: request.sourcePreview, expansionOutput, moduleName,
                developerDirectory: directory, storagePath: request.storagePath, signal, log,
                appendHost: request.preview.origin?.kind === "package" });
        },
        async prepareProviderSources(request, directory, signal) {
            return prepareProviderSources(request.sourcePreview, directory, request.storagePath, signal, log);
        },
        async finalizeAutomaticApp(appPath, destination, bundleIdentifier, signal) {
            await finalizeAutomaticApp(appPath, destination, bundleIdentifier, dependencies.processes, signal);
        },
        ...overrides,
    };
    const runner = dependencies.processes;
    const run = (command: Command, signal?: AbortSignal, stream = true, capture?: (text: string) => void): Promise<CommandResult> => {
        const options: CommandOptions = { signal };
        if (stream) { options.onOutput = (_stream, text) => { log(text); capture?.(text); }; }
        return runner.run(command, options);
    };

    async function hostCommand(artifact: PreviewArtifact, request: PreviewRequest, sessionID: string,
        signal: AbortSignal, listing: boolean): Promise<Command> {
        const { preview, destination } = request;
        const previewID = request.previewID ?? preview.previewID;
        if (!listing && !previewID) throw new Error("Select a compiled preview before starting the host.");
        const environment: Record<string, string> = {
            ...preview.environment,
            OPENSWIFTUI_PREVIEW_ID: listing ? "" : previewID!,
            OPENSWIFTUI_PREVIEW_SESSION: sessionID,
        };
        const args = listing ? ["--openswiftui-list-previews"] : preview.arguments;
        if (destination.platform === "macos") {
            return { command: artifact.executablePath, args, cwd: preview.folder,
                env: { ...environment, DEVELOPER_DIR: artifact.developerDirectory } };
        }
        const simulatorApp = path.join(artifact.developerDirectory, "Applications", "Simulator.app");
        if (!await dependencies.isDirectory(simulatorApp)) throw new Error(`Simulator.app is missing from ${artifact.developerDirectory}.`);
        await run(xcrun(artifact.developerDirectory, ["simctl", "bootstatus", destination.udid, "-b"]), signal);
        if (!listing) {
            await run({ command: "/usr/bin/open", args: ["-a", simulatorApp, "--args", "-CurrentDeviceUDID", destination.udid] }, signal);
        }
        await run(xcrun(artifact.developerDirectory, ["simctl", "install", destination.udid, artifact.appPath]), signal);
        const command = xcrun(artifact.developerDirectory, ["simctl", "launch", "--console", destination.udid, artifact.bundleIdentifier, ...args], preview.folder);
        command.env = { ...command.env, ...Object.fromEntries(Object.entries(environment).map(([key, value]) => [`SIMCTL_CHILD_${key}`, value])) };
        return command;
    }

    async function buildApp(request: PreviewRequest, preview: PreviewDefinition, directory: string,
        buildArguments: string[], signal: AbortSignal, cacheKey?: string, capture?: (text: string) => void): Promise<PreviewArtifact> {
        const { destination } = request;
        const key = createHash("sha256").update(JSON.stringify({
            project: preview.project, workspace: preview.workspace, scheme: preview.scheme,
            configuration: preview.configuration, target: preview.target, destination,
            developerDirectory: directory, buildArguments,
        })).digest("hex").slice(0, 24);
        const derivedData = path.join(request.storagePath, "DerivedData", cacheKey ?? key);
        await dependencies.mkdir(derivedData);
        if (request.preview.origin) {
            buildArguments.push(`SYMROOT=${path.join(derivedData, "Build/Products")}`,
                `OBJROOT=${path.join(derivedData, "Build/Intermediates.noindex")}`,
                `CONFIGURATION_BUILD_DIR=${path.join(derivedData, "Build/Products/$(CONFIGURATION)$(EFFECTIVE_PLATFORM_NAME)")}`);
        }
        const args = [
            ...(preview.workspace ? ["-workspace", preview.workspace] : ["-project", preview.project!]),
            "-scheme", preview.scheme, "-configuration", preview.configuration,
            "-destination", destination.platform === "macos"
                ? `platform=macOS,arch=${process.arch === "arm64" ? "arm64" : "x86_64"}`
                : `platform=iOS Simulator,id=${destination.udid}`,
            "-derivedDataPath", derivedData,
            "-clonedSourcePackagesDirPath", path.join(request.storagePath, "SourcePackages"), ...buildArguments,
        ];
        const settingsResult = await run(xcrun(directory, ["xcodebuild", ...args, "-showBuildSettings", "-json"], preview.folder), signal, false);
        let settingsJson: unknown;
        try { settingsJson = JSON.parse(settingsResult.stdout); }
        catch { throw new Error(`Xcode did not return valid build settings JSON. ${settingsResult.stderr.trim()}`); }
        const { buildSettings } = selectAppBuildSettings(settingsJson, preview.target);
        const buildDirectory = requiredSetting(buildSettings, "TARGET_BUILD_DIR");
        const appPath = path.resolve(buildDirectory, requiredSetting(buildSettings, "FULL_PRODUCT_NAME"));
        const executablePath = path.resolve(buildDirectory, requiredSetting(buildSettings, "EXECUTABLE_PATH"));
        const bundleIdentifier = requiredSetting(buildSettings, "PRODUCT_BUNDLE_IDENTIFIER");
        if (!path.isAbsolute(buildDirectory) || !contained(buildDirectory, appPath) || !contained(appPath, executablePath)) {
            throw new Error("The app executable must be inside the app product reported by Xcode.");
        }
        if (request.preview.origin) {
            const canonical = async (file: string) => fs.realpath(file).catch(() => path.resolve(file));
            if (!contained(await canonical(request.storagePath), await canonical(buildDirectory))) {
                throw new Error("The automatic Preview product must stay inside extension storage. Check custom output directory settings.");
            }
            if (bundleIdentifier !== (request.preview.origin.kind === "package" ? packageBundleIdentifier(request.preview.origin) : automaticBundleIdentifier(request.preview.origin))) {
                throw new Error("Xcode did not use the isolated Preview application identifier. Check conditional build settings.");
            }
        }
        throwIfCancelled(signal);
        await run(xcrun(directory, ["xcodebuild", ...args, "build"], preview.folder), signal, true, capture);
        throwIfCancelled(signal);
        if (!await dependencies.isDirectory(appPath) || !await dependencies.isFile(executablePath)) {
            throw new Error(`Xcode did not produce a runnable app at ${appPath}.`);
        }
        if (request.preview.origin) {
            if (destination.platform === "ios-simulator") {
                const embedded = await embeddedAppExtension(appPath, signal);
                if (embedded) {
                    throw new Error(`Automatic iOS Simulator Preview does not yet support apps with embedded extensions (${embedded}). Use a dedicated Preview host without embedded extensions.`);
                }
            }
            await dependencies.finalizeAutomaticApp(appPath, destination, bundleIdentifier, signal);
            throwIfCancelled(signal);
        }
        return { appPath, executablePath, bundleIdentifier, developerDirectory: directory, moduleName: buildSettings.PRODUCT_MODULE_NAME };
    }

    async function buildExpanded(request: PreviewRequest, signal: AbortSignal): Promise<PreviewArtifact> {
        const origin = request.preview.origin!;
        const sourcePath = request.sourcePreview!.filePath;
        const originalSource = await dependencies.readSource(sourcePath);
        const validateSource = async () => {
            throwIfCancelled(signal);
            if (await dependencies.readSource(sourcePath) !== originalSource) {
                throw new Error("The Preview source changed during compilation. Run Preview again with the saved file.");
            }
        };
        const directory = await developerDirectory(runner, request.preview.developerDirectory, signal);
        const cacheKey = createHash("sha256").update(JSON.stringify({ origin, directory,
            configuration: request.preview.configuration, destination: request.destination })).digest("hex").slice(0, 24);
        // A new compilation condition forces fresh expansion output from the selected target.
        // The two passes share build products and never run the original app.
        const expansionFlags = ["-Xfrontend", "-dump-macro-expansions", "-D",
            `OPENSWIFTUI_PREVIEW_EXPANSION_${randomUUID().replaceAll("-", "")}`];
        const packageHost = origin.kind === "package"
            ? await dependencies.preparePackageHost(request, directory, signal) : undefined;
        const first = packageHost ?? await dependencies.prepareAutomaticHost(request, directory, "", signal, undefined,
            ["$(OPENSWIFTUI_PREVIEW_COMPILER_FLAGS)"]);
        throwIfCancelled(signal);
        const firstArguments = [...first.buildArguments];
        const packageFlags = "OTHER_SWIFT_FLAGS=$(inherited) $(OPENSWIFTUI_PREVIEW_FLAGS_$(PRODUCT_MODULE_NAME))";
        if (origin.kind === "package") firstArguments.push(packageFlags, `OPENSWIFTUI_PREVIEW_FLAGS_${origin.moduleName}=${expansionFlags.join(" ")}`);
        else firstArguments.push(`OPENSWIFTUI_PREVIEW_COMPILER_FLAGS=${expansionFlags.join(" ")}`);
        let expansionOutput = "";
        let outputTooLarge = false;
        log("Compiling the project's Preview macros…\n");
        const artifact = await buildApp(request, first, directory, firstArguments, signal, cacheKey, text => {
            if (expansionOutput.length + text.length > 64 * 1024 * 1024) outputTooLarge = true;
            else if (!outputTooLarge) expansionOutput += text;
        });
        if (outputTooLarge) throw new Error("Macro expansion output exceeded 64 MiB. Use a narrower Preview scheme.");
        await validateSource();
        const moduleName = origin.kind === "package" ? origin.moduleName : artifact.moduleName;
        if (!moduleName) throw new Error("The build did not report the Preview source's Swift module name.");
        const overlay = await dependencies.prepareExpandedSources(request, directory, expansionOutput, moduleName, signal);
        await validateSource();
        throwIfCancelled(signal);
        // Keep the derived project path fixed so dependencies retain their build context.
        const secondArguments = [...first.buildArguments];
        const quotedOverlay = `"${overlay.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        if (origin.kind === "package") {
            secondArguments.push(packageFlags,
                `OPENSWIFTUI_PREVIEW_FLAGS_${origin.moduleName}=-D OPENSWIFTUI_AUTOMATIC_HOST -vfsoverlay ${quotedOverlay}`,
                `OPENSWIFTUI_PREVIEW_FLAGS_${packageHostModuleName(origin)}=-D OPENSWIFTUI_PREVIEW_EXECUTE`);
        } else secondArguments.push(`OPENSWIFTUI_PREVIEW_COMPILER_FLAGS=-vfsoverlay ${quotedOverlay}`);
        log("Building the native host from compiler-expanded previews…\n");
        const result = await buildApp(request, first, directory, secondArguments, signal, cacheKey);
        await validateSource();
        return result;
    }

    return {
        async build(request, signal) {
            throwIfCancelled(signal);
            if (request.preview.origin && request.sourcePreview) return buildExpanded(request, signal);
            const { destination } = request;
            let { preview } = request;
            if (!!preview.project === !!preview.workspace) { throw new Error("Set exactly one Xcode project or workspace."); }
            const directory = await developerDirectory(runner, preview.developerDirectory, signal);
            const macroLibrary = await dependencies.prepareMacros(directory, request.storagePath, signal);
            const sourceOverlay = await dependencies.prepareProviderSources(request, directory, signal);
            throwIfCancelled(signal);
            if (preview.origin?.kind === "automatic") {
                preview = await dependencies.prepareAutomaticHost(request, directory, macroLibrary, signal, sourceOverlay);
                throwIfCancelled(signal);
            }
            const configuredFlags = preview.buildArguments.filter(value => value.startsWith("OTHER_SWIFT_FLAGS=")).at(-1)?.slice("OTHER_SWIFT_FLAGS=".length);
            const quotedLibrary = `"${macroLibrary.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
            const buildArguments = preview.buildArguments.filter(value => !value.startsWith("OTHER_SWIFT_FLAGS="));
            if (request.preview.origin?.kind === "automatic") {
                if (configuredFlags !== undefined) buildArguments.push(`OTHER_SWIFT_FLAGS=${configuredFlags}`);
            } else {
                const overlayFlags = sourceOverlay ? ` -vfsoverlay "${sourceOverlay.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : "";
                buildArguments.push(`OTHER_SWIFT_FLAGS=${configuredFlags ?? "$(inherited)"} -D OPENSWIFTUI_STANDALONE_PREVIEW -load-plugin-library ${quotedLibrary}${overlayFlags}`);
            }
            return buildApp(request, preview, directory, buildArguments, signal);
        },

        async discover(artifact, request, sessionID, signal, timeoutMs) {
            throwIfCancelled(signal);
            const command = await hostCommand(artifact, request, sessionID, signal, true);
            throwIfCancelled(signal);
            const child = runner.spawn(command);
            const session: PreviewSession = {
                exited: child.exited,
                async stop() { if (!child.exit) await child.terminate(); },
            };
            try {
                return await readPreviewList(child, sessionID, signal, timeoutMs, log);
            } catch (error) {
                try { await session.stop(); }
                catch (cleanupError) {
                    throw new PreviewStartError(`${String(error)} Discovery cleanup failed: ${String(cleanupError)}`, session, error);
                }
                throw error;
            }
        },

        async start(artifact, request, sessionID, signal, readyTimeoutMs) {
            throwIfCancelled(signal);
            const { destination } = request;
            const command = await hostCommand(artifact, request, sessionID, signal, false);
            throwIfCancelled(signal);
            const child = runner.spawn(command);
            let owned = false;
            let stopped: Promise<void> | undefined;
            const session: PreviewSession = {
                exited: child.exited,
                stop() {
                    if (stopped) { return stopped; }
                    stopped = (async () => {
                        if (child.exit) { return; }
                        // Never terminate an unrelated app when launch failed before our handshake.
                        if (owned && destination.platform === "ios-simulator") {
                            const cancellation = new AbortController();
                            const timer = setTimeout(() => cancellation.abort(), 3000);
                            try {
                                await run(xcrun(artifact.developerDirectory, ["simctl", "terminate", destination.udid, artifact.bundleIdentifier]), cancellation.signal);
                                // simctl --console closes after the app exits. Give it time to
                                // finish before signalling a launcher group that may be gone.
                                await waitForExit(child, 1000);
                            } catch (error) { log(`Simulator termination: ${String(error)}\n`); }
                            finally { clearTimeout(timer); }
                        }
                        if (!child.exit) { await child.terminate(); }
                    })();
                    const attempt = stopped;
                    void attempt.catch(() => { if (stopped === attempt) { stopped = undefined; } });
                    return stopped;
                },
            };
            try {
                await waitForReady(child, sessionID, signal, readyTimeoutMs, log);
                owned = true;
                throwIfCancelled(signal);
                if (child.exit) { throw new Error("Preview host exited immediately after reporting ready."); }
                return session;
            } catch (error) {
                try { await session.stop(); }
                catch (cleanupError) {
                    log(`Preview cleanup: ${String(cleanupError)}\n`);
                    throw new PreviewStartError(`${String(error)} Cleanup failed: ${String(cleanupError)}`, session, error);
                }
                throw error;
            }
        },
    };
}

async function waitForExit(child: ManagedProcess, timeoutMs: number): Promise<void> {
    if (child.exit) { return; }
    await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, timeoutMs);
        void child.exited.then(() => { clearTimeout(timer); resolve(); });
    });
}

function parsePreviewList(text: string): PreviewCase[] {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
        !("previews" in value) || !Array.isArray(value.previews) || value.previews.length > 10000) {
        throw new Error("The host returned an invalid preview list or unsupported protocol version.");
    }
    const ids = new Set<string>();
    return value.previews.map((item: unknown) => {
        if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !item.id ||
            !("fileID" in item) || typeof item.fileID !== "string" || !item.fileID ||
            !("line" in item) || !Number.isSafeInteger(item.line) || (item.line as number) < 1 ||
            !("column" in item) || !Number.isSafeInteger(item.column) || (item.column as number) < 1 ||
            ("name" in item && item.name !== null && typeof item.name !== "string") ||
            ("kind" in item && item.kind !== "macro" && item.kind !== "provider") ||
            ("typeName" in item && item.typeName !== null && typeof item.typeName !== "string") ||
            ("providerType" in item && item.providerType !== null && typeof item.providerType !== "string") ||
            ("filePath" in item && item.filePath !== null && typeof item.filePath !== "string")) {
            throw new Error("The host returned invalid preview metadata.");
        }
        if (ids.has(item.id)) throw new Error(`The host returned duplicate preview ID: ${item.id}.`);
        ids.add(item.id);
        return {
            id: item.id,
            ...("name" in item && typeof item.name === "string" ? { name: item.name } : {}),
            ...("kind" in item ? { kind: item.kind as "macro" | "provider" } : {}),
            ...("typeName" in item && typeof item.typeName === "string" ? { typeName: item.typeName } : {}),
            ...("providerType" in item && typeof item.providerType === "string" ? { providerType: item.providerType } : {}),
            fileID: item.fileID,
            ...("filePath" in item && typeof item.filePath === "string" ? { filePath: item.filePath } : {}),
            line: item.line as number,
            column: item.column as number,
        };
    });
}

async function readPreviewList(child: ManagedProcess, sessionID: string, signal: AbortSignal,
    timeoutMs: number, log: (message: string) => void): Promise<PreviewCase[]> {
    let pending = "";
    let previews: PreviewCase[] | undefined;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<PreviewCase[]>((resolve, reject) => {
        rejectResult = reject;
        void child.exited.then(exit => {
            if (exit.error) reject(exit.error);
            else if (exit.code !== 0) reject(new Error(`Preview discovery exited with ${exit.signal ?? exit.code}.`));
            else if (!previews) reject(new Error("The host exited without a compiled preview list. Check its preview registry and list hook."));
            else resolve(previews);
        });
    });
    const prefix = `OPENSWIFTUI_PREVIEW_LIST:${sessionID}:`;
    const unsubscribe = child.onOutput((stream, text) => {
        log(text);
        if (stream !== "stdout") return;
        pending += text;
        if (pending.length > 1024 * 1024) {
            rejectResult(new Error("The preview list exceeded the 1 MiB protocol limit."));
            pending = "";
            return;
        }
        let index: number;
        while ((index = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, index).replace(/\r$/, "");
            pending = pending.slice(index + 1);
            if (!line.startsWith(prefix)) continue;
            try {
                if (previews) throw new Error("The host returned more than one preview list.");
                previews = parsePreviewList(line.slice(prefix.length));
            } catch (error) { rejectResult(error instanceof Error ? error : new Error(String(error))); }
        }
    });
    const abort = () => rejectResult(cancellationError());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => rejectResult(new Error("Preview discovery timed out before the listing host exited.")), timeoutMs);
    try { return await result; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); unsubscribe(); }
}

async function waitForReady(child: ManagedProcess, sessionID: string, signal: AbortSignal,
    timeoutMs: number, log: (message: string) => void): Promise<void> {
    let pending = "";
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const unsubscribe = child.onOutput((stream, text) => {
        log(text);
        if (stream !== "stdout") { return; }
        pending += text;
        let index: number;
        while ((index = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, index).replace(/\r$/, "");
            pending = pending.slice(index + 1);
            if (line === `OPENSWIFTUI_PREVIEW_READY:${sessionID}`) { resolveReady(); }
        }
        pending = pending.slice(-64 * 1024);
    });
    void child.exited.then(exit => {
        unsubscribe();
        rejectReady(exit.error ?? new Error(`Preview host exited before readiness (${exit.signal ?? exit.code}).`));
    });
    const abort = () => rejectReady(cancellationError());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); }
    const timer = setTimeout(() => rejectReady(new Error("Preview host timed out before reporting ready. Check the native host readiness hook.")), timeoutMs);
    try { await ready; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
