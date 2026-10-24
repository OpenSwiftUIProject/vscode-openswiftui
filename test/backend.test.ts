import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { BackendDependencies, createPreviewBackend, PreviewArtifact, selectAppBuildSettings } from "../src/backend";
import { Command, CommandOptions, CommandResult, ManagedProcess, ProcessExit, ProcessRunner } from "../src/process";
import { PreviewRequest } from "../src/types";
import { automaticBundleIdentifier } from "../src/automaticHost";
import { packageBundleIdentifier } from "../src/packageHost";

class FakeProcess implements ManagedProcess {
    readonly pid = 100;
    exit: ProcessExit | undefined;
    private resolve!: (exit: ProcessExit) => void;
    readonly exited = new Promise<ProcessExit>(resolve => { this.resolve = resolve; });
    private listeners = new Set<(stream: "stdout" | "stderr", text: string) => void>();
    stops = 0;
    onOutput(listener: (stream: "stdout" | "stderr", text: string) => void) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    output(text: string) { for (const listener of this.listeners) { listener("stdout", text); } }
    finish(code: number) { this.exit = { code, signal: null }; this.resolve(this.exit); }
    async terminate() { this.stops++; this.finish(0); }
}

const request: PreviewRequest = {
    preview: {
        id: "sample", name: "Sample", previewID: "counter", folder: "/project",
        project: "/project/Preview.xcodeproj", scheme: "Preview", configuration: "Debug",
        platforms: ["macos", "ios-simulator"], arguments: ["a b", "$(literal)"],
        environment: { CUSTOM: "value", OPENSWIFTUI_PREVIEW_SESSION: "wrong" },
        buildArguments: [], developerDirectory: "/Xcode/Contents/Developer",
    },
    destination: { platform: "macos", name: "My Mac" }, storagePath: "/storage",
};
const artifact: PreviewArtifact = {
    appPath: "/build/Preview.app", executablePath: "/build/Preview.app/Contents/MacOS/Preview",
    bundleIdentifier: "org.openswiftuiproject.openswiftui.preview", developerDirectory: "/Xcode/Contents/Developer",
};
const settings = (name = "Preview") => ({ target: name, buildSettings: {
    PRODUCT_MODULE_NAME: name,
    PRODUCT_TYPE: "com.apple.product-type.application", FULL_PRODUCT_NAME: `${name}.app`,
    TARGET_BUILD_DIR: "/build", EXECUTABLE_PATH: `${name}.app/Contents/MacOS/${name}`,
    PRODUCT_BUNDLE_IDENTIFIER: "org.openswiftuiproject.openswiftui.preview",
} });

function harness(onRun?: (command: Command, processes: FakeProcess[]) => void, overrides: Partial<BackendDependencies> = {}, appSettings = settings()) {
    const commands: Command[] = [];
    const processes: FakeProcess[] = [];
    const runner: ProcessRunner = {
        async run(command: Command, _options?: CommandOptions): Promise<CommandResult> {
            commands.push(command);
            onRun?.(command, processes);
            return { stdout: command.args.includes("-showBuildSettings") ? JSON.stringify([appSettings]) : "", stderr: "" };
        },
        spawn(command: Command) {
            commands.push(command);
            const process = new FakeProcess(); processes.push(process); return process;
        },
    };
    const backend = createPreviewBackend(() => {}, {
        processes: runner,
        async isFile() { return true; },
        async isDirectory() { return true; },
        async mkdir() {},
        async readSource() { return "#Preview { ContentView() }"; },
        async prepareMacros() { return "/macro cache/libOpenSwiftUIPreviewMacros.dylib"; },
        async prepareProviderSources() { return undefined; },
        async finalizeAutomaticApp() {},
        ...overrides,
    });
    return { backend, commands, processes };
}

test("ambiguous app schemes require an explicit target", () => {
    assert.throws(() => selectAppBuildSettings([settings(), settings("Other")]), /multiple|exactly one/i);
    assert.equal(selectAppBuildSettings([settings(), settings("Other")], "Other").target, "Other");
    assert.throws(() => selectAppBuildSettings([settings()], "Missing"), /Missing/);
});

test("native launch preserves argument boundaries and waits for its own readiness line", async () => {
    const h = harness();
    const running = h.backend.start(artifact, request, "owned", new AbortController().signal, 1000);
    await new Promise<void>(resolve => setImmediate(resolve));
    const child = h.processes[0]!;
    assert.deepEqual(h.commands.at(-1)!.args, ["a b", "$(literal)"]);
    assert.equal(h.commands.at(-1)!.env?.OPENSWIFTUI_PREVIEW_SESSION, "owned");
    let ready = false;
    void running.then(() => { ready = true; });
    child.output("OPENSWIFTUI_PREVIEW_READY:other\n");
    await Promise.resolve();
    assert.equal(ready, false);
    child.output("OPENSWIFTUI_PREVIEW_RE");
    child.output("ADY:owned\r\n");
    const session = await running;
    await session.stop();
    assert.equal(child.stops, 1);
});

test("timeout and exit before readiness reject startup and clean up the host", async () => {
    const timeout = harness();
    await assert.rejects(timeout.backend.start(artifact, request, "timeout", new AbortController().signal, 5), /ready|readiness|timed out/i);
    assert.equal(timeout.processes[0]!.stops, 1);
    const early = harness();
    const pending = early.backend.start(artifact, request, "early", new AbortController().signal, 1000);
    await new Promise<void>(resolve => setImmediate(resolve));
    early.processes[0]!.finish(1);
    await assert.rejects(pending, /exit/i);
});

test("a failed simulator launch never terminates an unowned bundle", async () => {
    const h = harness();
    const simulatorRequest: PreviewRequest = {
        ...request, destination: { platform: "ios-simulator", name: "Phone", udid: "ABC-123" },
    };
    const starting = h.backend.start(artifact, simulatorRequest, "not-owned", new AbortController().signal, 1000);
    await new Promise<void>(resolve => setImmediate(resolve));
    h.processes[0]!.finish(1);
    await assert.rejects(starting, /exit/i);
    assert.equal(h.commands.some(command => command.args.includes("terminate")), false);
});

test("a cancelled readiness wait stops its console process without terminating an unowned bundle", async () => {
    const h = harness();
    const controller = new AbortController();
    const simulatorRequest: PreviewRequest = {
        ...request, destination: { platform: "ios-simulator", name: "Phone", udid: "ABC-123" },
    };
    const starting = h.backend.start(artifact, simulatorRequest, "cancelled", controller.signal, 1000);
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(starting, error => error instanceof Error && error.name === "AbortError");
    assert.equal(h.processes[0]!.stops, 1);
    assert.equal(h.commands.some(command => command.args.includes("terminate")), false);
});

test("simulator launch uses the selected Xcode, explicit UDID, and child environment", async () => {
    const h = harness();
    const simulatorRequest: PreviewRequest = {
        ...request, destination: { platform: "ios-simulator", name: "Phone", udid: "ABC-123" },
    };
    const starting = h.backend.start(artifact, simulatorRequest, "sim-session", new AbortController().signal, 1000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(h.commands.some(command => command.args.join(" ").includes("bootstatus ABC-123 -b")));
    assert.ok(h.commands.some(command => command.command === "/usr/bin/open" && command.args.includes("/Xcode/Contents/Developer/Applications/Simulator.app")));
    const launch = h.commands.at(-1)!;
    assert.deepEqual(launch.args.slice(0, 4), ["simctl", "launch", "--console", "ABC-123"]);
    assert.equal(launch.env?.SIMCTL_CHILD_OPENSWIFTUI_PREVIEW_SESSION, "sim-session");
    assert.equal(launch.env?.SIMCTL_CHILD_CUSTOM, "value");
    h.processes[0]!.output("OPENSWIFTUI_PREVIEW_READY:sim-session\n");
    const host = await starting;
    await host.stop();
    assert.ok(h.commands.some(command => command.args.join(" ").includes(`terminate ABC-123 ${artifact.bundleIdentifier}`)));
});

test("successful simulator termination waits for console exit without signalling its process group", async () => {
    const h = harness((command, processes) => {
        if (command.args.includes("terminate")) {
            setTimeout(() => processes[0]!.finish(0), 10);
        }
    });
    const simulatorRequest: PreviewRequest = {
        ...request, destination: { platform: "ios-simulator", name: "Phone", udid: "ABC-123" },
    };
    const starting = h.backend.start(artifact, simulatorRequest, "console-exit", new AbortController().signal, 1000);
    await new Promise<void>(resolve => setImmediate(resolve));
    const child = h.processes[0]!;
    child.terminate = async () => {
        child.stops++;
        throw Object.assign(new Error("The exited launcher group is not owned by this process."), { code: "EPERM" });
    };
    child.output("OPENSWIFTUI_PREVIEW_READY:console-exit\n");
    const session = await starting;
    await session.stop();
    assert.equal(child.stops, 0);
    assert.equal(child.exit?.code, 0);
});

test("builds reuse storage but separate destinations and verify the app product", async () => {
    const h = harness();
    await h.backend.build(request, new AbortController().signal);
    const first = h.commands.find(command => command.args.includes("-showBuildSettings"))!;
    assert.equal(first.env?.DEVELOPER_DIR, request.preview.developerDirectory);
    const index = first.args.indexOf("-derivedDataPath");
    assert.ok(first.args[index + 1]!.startsWith("/storage/"));
    await h.backend.build({ ...request, destination: { platform: "ios-simulator", name: "Phone", udid: "ABC-123" } }, new AbortController().signal);
    const queries = h.commands.filter(command => command.args.includes("-showBuildSettings"));
    assert.notEqual(queries[0]!.args[index + 1], queries[1]!.args[index + 1]);
});

const compiledCase = { id: "Module/Content.swift:12:1", name: "Counter", fileID: "Module/Content.swift", line: 12, column: 1 };

function discover(h: ReturnType<typeof harness>, token = "listing", signal = new AbortController().signal, timeout = 1000, selectedRequest = request) {
    return h.backend.discover(artifact, selectedRequest, token, signal, timeout);
}

function listing(token = "listing", previews: unknown[] = [compiledCase]): string {
    return `OPENSWIFTUI_PREVIEW_LIST:${token}:${JSON.stringify({ version: 1, previews })}\n`;
}

test("discovery reads compiled metadata from its own frame and waits for successful exit", async () => {
    const h = harness();
    const pending = discover(h);
    await new Promise<void>(resolve => setImmediate(resolve));
    const child = h.processes[0]!;
    assert.ok(h.commands.at(-1)!.args.includes("--openswiftui-list-previews"));
    child.output(listing("other"));
    child.output(listing().slice(0, 25));
    child.output(listing().slice(25));
    let completed = false;
    void pending.then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(completed, false);
    child.finish(0);
    assert.deepEqual(await pending, [compiledCase]);
});

test("discovery retains provider identity and resolved display metadata", async () => {
    const h = harness();
    const pending = discover(h);
    await new Promise<void>(resolve => setImmediate(resolve));
    const provider = { ...compiledCase, kind: "provider", typeName: "ContentView", providerType: "ContentPreviews" };
    h.processes[0]!.output(listing("listing", [provider]));
    h.processes[0]!.finish(0);
    assert.deepEqual(await pending, [provider]);
});

test("discovery rejects malformed metadata, duplicate IDs, missing frames, and nonzero exits", async () => {
    for (const scenario of [
        { output: "", code: 0 },
        { output: listing(), code: 1 },
        { output: listing("listing", [compiledCase, compiledCase]), code: 0 },
        { output: listing("listing", [{ ...compiledCase, line: 0 }]), code: 0 },
        { output: listing("listing", [{ ...compiledCase, kind: "unknown" }]), code: 0 },
        { output: listing("listing", [{ ...compiledCase, typeName: 42 }]), code: 0 },
        { output: "OPENSWIFTUI_PREVIEW_LIST:listing:{broken}\n", code: 0 },
    ]) {
        const h = harness();
        const pending = discover(h);
        await new Promise<void>(resolve => setImmediate(resolve));
        h.processes[0]!.output(scenario.output);
        h.processes[0]!.finish(scenario.code);
        await assert.rejects(pending);
    }
});

test("simulator discovery uses its selected device and never terminates an unowned bundle", async () => {
    const h = harness();
    const abort = new AbortController();
    const selectedRequest: PreviewRequest = { ...request, destination: { platform: "ios-simulator", name: "Phone", udid: "ABC-123" } };
    const pending = discover(h, "listing", abort.signal, 1000, selectedRequest);
    await new Promise<void>(resolve => setImmediate(resolve));
    const launch = h.commands.at(-1)!;
    assert.deepEqual(launch.args.slice(0, 4), ["simctl", "launch", "--console", "ABC-123"]);
    assert.ok(launch.args.includes("--openswiftui-list-previews"));
    assert.equal(launch.env?.SIMCTL_CHILD_OPENSWIFTUI_PREVIEW_SESSION, "listing");
    abort.abort();
    await assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
    assert.equal(h.processes[0]!.stops, 1);
    assert.equal(h.commands.some(command => command.args.includes("terminate")), false);
    assert.equal(h.commands.some(command => command.command === "/usr/bin/open"), false);
});

test("discovery times out if a listing host never exits", async () => {
    const h = harness();
    const pending = discover(h, "listing", new AbortController().signal, 10);
    await new Promise<void>(resolve => setImmediate(resolve));
    h.processes[0]!.output(listing());
    await assert.rejects(pending, /timed out/i);
    assert.equal(h.processes[0]!.stops, 1);
});

test("builds load the preview macro library and preserve the user's Swift flags", async () => {
    const h = harness(undefined, { async prepareProviderSources() { return "/provider cache/overlay.json"; } });
    await h.backend.build({ ...request, preview: { ...request.preview, buildArguments: ["OTHER_SWIFT_FLAGS=$(inherited) -D CUSTOM", "CODE_SIGNING_ALLOWED=NO"] } }, new AbortController().signal);
    const command = h.commands.find(value => value.args.includes("build"))!;
    const flags = command.args.filter(value => value.startsWith("OTHER_SWIFT_FLAGS="));
    assert.equal(flags.length, 1);
    assert.match(flags[0]!, /\$\(inherited\) -D CUSTOM/);
    assert.match(flags[0]!, /-D OPENSWIFTUI_STANDALONE_PREVIEW/);
    assert.match(flags[0]!, /-load-plugin-library "\/macro cache\/libOpenSwiftUIPreviewMacros.dylib"/);
    assert.match(flags[0]!, /-vfsoverlay "\/provider cache\/overlay.json"/);
    assert.ok(command.args.includes("CODE_SIGNING_ALLOWED=NO"));
});

test("automatic builds use the generated target without applying preview flags to dependencies", async () => {
    const automatic: PreviewRequest = { ...request, preview: { ...request.preview,
        origin: { kind: "automatic", projectPath: "/project/Original.xcodeproj", targetID: "TARGET" },
    } };
    let prepared = false;
    let finalized = false;
    const h = harness(undefined, {
        async prepareProviderSources() { return "/provider cache/overlay.json"; },
        async prepareAutomaticHost(received, directory, macroLibrary, signal, sourceOverlay) {
            assert.equal(received, automatic);
            assert.equal(directory, request.preview.developerDirectory);
            assert.match(macroLibrary, /libOpenSwiftUIPreviewMacros/);
            assert.equal(signal.aborted, false);
            assert.equal(sourceOverlay, "/provider cache/overlay.json");
            prepared = true;
            return { ...received.preview, project: "/storage/Generated/Original.xcodeproj", scheme: "GeneratedPreview" };
        },
        async finalizeAutomaticApp(appPath, destination, bundleIdentifier) {
            assert.equal(appPath, "/storage/build/Preview.app");
            assert.equal(destination, automatic.destination);
            assert.equal(bundleIdentifier, automaticBundleIdentifier(automatic.preview.origin!));
            finalized = true;
        },
    }, { ...settings(), buildSettings: { ...settings().buildSettings, TARGET_BUILD_DIR: "/storage/build",
        PRODUCT_BUNDLE_IDENTIFIER: automaticBundleIdentifier(automatic.preview.origin!),
    } });
    await h.backend.build(automatic, new AbortController().signal);
    assert.ok(prepared);
    assert.ok(finalized);
    const commands = h.commands.filter(command => command.args[0] === "xcodebuild");
    assert.equal(commands.length, 2);
    for (const command of commands) {
        assert.ok(command.args.includes("/storage/Generated/Original.xcodeproj"));
        assert.ok(command.args.includes("GeneratedPreview"));
        assert.ok(!command.args.some(argument => argument.startsWith("OTHER_SWIFT_FLAGS=")));
        assert.ok(command.args.some(argument => argument.startsWith("CONFIGURATION_BUILD_DIR=/storage/")));
    }
});

test("automatic source previews compile project macros before building the adapted host", async () => {
    const automatic: PreviewRequest = { ...request, sourcePreview: {
        filePath: "/project/Content.swift", line: 14, column: 1,
    }, preview: { ...request.preview,
        origin: { kind: "automatic", projectPath: "/project/Original.xcodeproj", targetID: "TARGET" },
    } };
    const prepared: Array<string | undefined> = [];
    let expanded = false;
    const overrides = {
        async prepareMacros(): Promise<string> { throw new Error("The project must provide its own Preview macro."); },
        async prepareAutomaticHost(received: PreviewRequest, _directory: string, library: string,
            _signal: AbortSignal, overlay?: string) {
            assert.equal(library, "");
            assert.equal(!!overlay, expanded);
            prepared.push(overlay);
            return { ...received.preview, project: "/storage/Generated/Original.xcodeproj" };
        },
        async prepareExpandedSources() { expanded = true; return "/storage/Expanded/overlay.json"; },
    };
    const h = harness(undefined, overrides, { ...settings(), buildSettings: {
        ...settings().buildSettings, TARGET_BUILD_DIR: "/storage/build", PRODUCT_MODULE_NAME: "Original",
        PRODUCT_BUNDLE_IDENTIFIER: automaticBundleIdentifier(automatic.preview.origin!),
    } });
    await h.backend.build(automatic, new AbortController().signal);
    assert.deepEqual(prepared, [undefined]);
    const builds = h.commands.filter(command => command.args.includes("build"));
    assert.equal(builds.length, 2);
    assert.match(builds[0]!.args.find(arg => arg.startsWith("OPENSWIFTUI_PREVIEW_COMPILER_FLAGS="))!, /-dump-macro-expansions/);
    assert.equal(builds[1]!.args.find(arg => arg.startsWith("OPENSWIFTUI_PREVIEW_COMPILER_FLAGS=")),
        'OPENSWIFTUI_PREVIEW_COMPILER_FLAGS=-vfsoverlay "/storage/Expanded/overlay.json"');
});

test("package expansion and execution flags apply only to the source module and host", async () => {
    const origin = { kind: "package" as const, packagePath: "/project", targetName: "Demo-Kit", productName: "DemoKit", moduleName: "Demo_Kit" };
    const packageRequest: PreviewRequest = { ...request, sourcePreview: { filePath: "/project/Content.swift", line: 14, column: 1 },
        preview: { ...request.preview, project: undefined, origin } };
    const h = harness(undefined, {
        async prepareMacros(): Promise<string> { throw new Error("Use the package's macro."); },
        async preparePackageHost(received) { return { ...received.preview, project: "/storage/PackageHost.xcodeproj" }; },
        async prepareExpandedSources() { return "/storage/Expanded Sources/overlay.json"; },
    }, { ...settings(), buildSettings: { ...settings().buildSettings, TARGET_BUILD_DIR: "/storage/build",
        PRODUCT_BUNDLE_IDENTIFIER: packageBundleIdentifier(origin) } });
    await h.backend.build(packageRequest, new AbortController().signal);
    const builds = h.commands.filter(command => command.args.includes("build"));
    assert.equal(builds.length, 2);
    for (const command of builds) assert.ok(command.args.includes("OTHER_SWIFT_FLAGS=$(inherited) $(OPENSWIFTUI_PREVIEW_FLAGS_$(PRODUCT_MODULE_NAME))"));
    assert.match(builds[0]!.args.find(arg => arg.startsWith("OPENSWIFTUI_PREVIEW_FLAGS_Demo_Kit="))!, /-dump-macro-expansions/);
    assert.match(builds[1]!.args.find(arg => arg.startsWith("OPENSWIFTUI_PREVIEW_FLAGS_Demo_Kit="))!, /-vfsoverlay "\/storage\/Expanded Sources\/overlay.json"/);
    assert.ok(builds[1]!.args.includes("OPENSWIFTUI_PREVIEW_FLAGS_OpenSwiftUIPreviewHost=-D OPENSWIFTUI_PREVIEW_EXECUTE"));
    assert.equal(builds[0]!.args[builds[0]!.args.indexOf("-derivedDataPath") + 1], builds[1]!.args[builds[1]!.args.indexOf("-derivedDataPath") + 1]);
});

test("a source edit during macro compilation rejects the stale replacement before adaptation", async () => {
    const automatic: PreviewRequest = { ...request, sourcePreview: { filePath: "/project/Content.swift", line: 1, column: 1 },
        preview: { ...request.preview, origin: { kind: "automatic", projectPath: "/project/Original.xcodeproj", targetID: "TARGET" } } };
    let reads = 0;
    let adapted = false;
    const h = harness(undefined, {
        async readSource() { return reads++ === 0 ? "#Preview { First() }" : "#Preview { Second() }"; },
        async prepareAutomaticHost(received) { return received.preview; },
        async prepareExpandedSources() { adapted = true; return "/storage/overlay.json"; },
    }, { ...settings(), buildSettings: { ...settings().buildSettings, TARGET_BUILD_DIR: "/storage/build",
        PRODUCT_BUNDLE_IDENTIFIER: automaticBundleIdentifier(automatic.preview.origin) } });
    await assert.rejects(h.backend.build(automatic, new AbortController().signal), /source changed/i);
    assert.equal(adapted, false);
    assert.equal(h.commands.filter(command => command.args.includes("build")).length, 1);
});

test("automatic builds reject an original app identity or output outside extension storage", async () => {
    const automatic: PreviewRequest = { ...request, preview: { ...request.preview,
        origin: { kind: "automatic", projectPath: "/project/Original.xcodeproj", targetID: "TARGET" },
    } };
    for (const [directory, identifier, expected] of [
        ["/project/build", automaticBundleIdentifier(automatic.preview.origin!), /extension storage/],
        ["/storage/build", "org.example.original", /isolated Preview application identifier/],
    ] as const) {
        const h = harness(undefined, { async prepareAutomaticHost(received) { return received.preview; } },
            { ...settings(), buildSettings: { ...settings().buildSettings,
                TARGET_BUILD_DIR: directory, PRODUCT_BUNDLE_IDENTIFIER: identifier,
            } });
        await assert.rejects(h.backend.build(automatic, new AbortController().signal), expected);
        assert.equal(h.commands.some(command => command.args.includes("build")), false);
    }
});

test("automatic iOS builds report embedded extensions before finalization or installation", async () => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "preview-extension-"));
    try {
        const appPath = path.join(storagePath, "build/Preview.app");
        const extensionPath = path.join(appPath, "PlugIns/Widget.appex");
        await fs.mkdir(extensionPath, { recursive: true });
        const metadata = '{"CFBundleIdentifier":"org.example.App.Widget"}';
        await fs.writeFile(path.join(extensionPath, "Info.plist"), metadata);
        const automatic: PreviewRequest = { ...request, storagePath,
            destination: { platform: "ios-simulator", name: "Phone", udid: "ABC-123" },
            preview: { ...request.preview,
                origin: { kind: "automatic", projectPath: "/project/Original.xcodeproj", targetID: "TARGET" },
            },
        };
        let finalized = false;
        const h = harness(undefined, {
            async prepareAutomaticHost(received) { return received.preview; },
            async finalizeAutomaticApp() { finalized = true; },
        }, { ...settings(), buildSettings: { ...settings().buildSettings,
            TARGET_BUILD_DIR: path.dirname(appPath), PRODUCT_BUNDLE_IDENTIFIER: automaticBundleIdentifier(automatic.preview.origin!),
        } });
        await assert.rejects(h.backend.build(automatic, new AbortController().signal), /automatic.*iOS.*embedded extensions.*Widget\.appex/i);
        assert.equal(finalized, false);
        assert.equal(h.commands.some(command => command.args.includes("install")), false);
        assert.equal(await fs.readFile(path.join(extensionPath, "Info.plist"), "utf8"), metadata);

        await h.backend.build({ ...automatic, destination: request.destination }, new AbortController().signal);
        assert.equal(finalized, true, "The iOS installation restriction must not disable macOS Preview.");
        await h.backend.build({ ...automatic, preview: { ...automatic.preview, origin: undefined } }, new AbortController().signal);
    } finally { await fs.rm(storagePath, { recursive: true, force: true }); }
});

test("cancellation during automatic host preparation never starts an app build", async () => {
    const abort = new AbortController();
    const h = harness(undefined, {
        async prepareAutomaticHost(received) { abort.abort(); return received.preview; },
    });
    await assert.rejects(h.backend.build({ ...request, preview: { ...request.preview,
        origin: { kind: "automatic", projectPath: "/project/Original.xcodeproj", targetID: "TARGET" },
    } }, abort.signal), error => error instanceof Error && error.name === "AbortError");
    assert.equal(h.commands.some(command => command.args[0] === "xcodebuild"), false);
});
