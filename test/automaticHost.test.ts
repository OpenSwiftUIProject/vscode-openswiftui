import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { automaticBundleIdentifier, finalizeAutomaticApp, prepareAutomaticHost } from "../src/automaticHost";
import { cancellationError, Command, createProcessRunner, ProcessRunner } from "../src/process";
import { PreviewRequest } from "../src/types";

async function fixture() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openswiftui-overlay-")));
    const project = path.join(root, "Original App.xcodeproj");
    await fs.mkdir(project);
    await fs.mkdir(path.join(root, "Sources"));
    const source = path.join(root, "Sources", "App.swift");
    const originalSource = '@main struct ExistingApp { static func main() { fatalError("Original entry must not run") } }\n';
    await fs.writeFile(source, originalSource);
    const plist = { CFBundleIdentifier: "original.app", CustomResource: "marker.txt", NSMainStoryboardFile: "Main", "UIMainStoryboardFile~ipad": "Main", UIApplicationSceneManifest: { UISceneConfigurations: { Original: [] } } };
    await fs.writeFile(path.join(root, "Info.plist"), JSON.stringify(plist));
    const document = { archiveVersion: "1", objectVersion: "77", classes: {}, rootObject: "PROJECT", objects: {
        PROJECT: { isa: "PBXProject", mainGroup: "ROOT", targets: ["APP", "LIB"], projectDirPath: "", packageReferences: ["PACKAGE"] },
        ROOT: { isa: "PBXGroup", sourceTree: "<group>", children: ["SOURCES", "RESOURCE", "CONFIG", "PRODUCT"] },
        SOURCES: { isa: "PBXGroup", path: "Sources", sourceTree: "<group>", children: ["FILE"] },
        FILE: { isa: "PBXFileReference", path: "App.swift", sourceTree: "<group>" },
        RESOURCE: { isa: "PBXFileReference", path: "marker.txt", sourceTree: "SOURCE_ROOT" },
        CONFIG: { isa: "PBXFileReference", path: "App.xcconfig", sourceTree: "<group>" },
        PRODUCT: { isa: "PBXFileReference", path: "Original App.app", sourceTree: "BUILT_PRODUCTS_DIR" },
        BUILD: { isa: "PBXBuildFile", fileRef: "FILE" },
        RESOURCEBUILD: { isa: "PBXBuildFile", fileRef: "RESOURCE" },
        SOURCESPHASE: { isa: "PBXSourcesBuildPhase", files: ["BUILD"] },
        RESOURCESPHASE: { isa: "PBXResourcesBuildPhase", files: ["RESOURCEBUILD"] },
        SCRIPT: { isa: "PBXShellScriptBuildPhase", shellScript: 'cat "$SRCROOT/marker.txt"', inputPaths: ["$(SRCROOT)/marker.txt"] },
        APP: { isa: "PBXNativeTarget", name: "Original App", productType: "com.apple.product-type.application", buildPhases: ["SOURCESPHASE", "RESOURCESPHASE", "SCRIPT"], buildConfigurationList: "CONFIGS", dependencies: ["DEPENDENCY"] },
        LIB: { isa: "PBXNativeTarget", name: "Library", buildConfigurationList: "LIBCONFIGS" },
        DEPENDENCY: { isa: "PBXTargetDependency", target: "LIB" },
        CONFIGS: { isa: "XCConfigurationList", buildConfigurations: ["DEBUG"] },
        DEBUG: { isa: "XCBuildConfiguration", name: "Debug", baseConfigurationReference: "CONFIG", buildSettings: { OTHER_SWIFT_FLAGS: ["$(inherited)", "-D", "APP_FLAG"], "OTHER_SWIFT_FLAGS[sdk=macosx*]": "-D PLATFORM_FLAG", "PRODUCT_BUNDLE_IDENTIFIER[sdk=iphonesimulator*]": "original.app", "INFOPLIST_FILE[sdk=iphonesimulator*]": "Other.plist", "ENABLE_DEBUG_DYLIB[config=Debug]": "YES", INFOPLIST_FILE: "$(DERIVED_FILE_DIR)/Generated.plist", INFOPLIST_PREPROCESS: "YES", INFOPLIST_PREPROCESSOR_DEFINITIONS: "FEATURE=1", GENERATE_INFOPLIST_FILE: "YES", INFOPLIST_KEY_UIApplicationSceneManifest_Generation: "YES" } },
        LIBCONFIGS: { isa: "XCConfigurationList", buildConfigurations: ["LIBDEBUG"] },
        LIBDEBUG: { isa: "XCBuildConfiguration", name: "Debug", buildSettings: { OTHER_SWIFT_FLAGS: "-D LIB_FLAG", PRODUCT_BUNDLE_IDENTIFIER: "original.lib" } },
        PACKAGE: { isa: "XCLocalSwiftPackageReference", relativePath: "../Support Package" },
    } as Record<string, Record<string, unknown>> };
    const save = () => fs.writeFile(path.join(project, "project.pbxproj"), JSON.stringify(document));
    await save();
    const commands: Command[] = [];
    const runner: ProcessRunner = {
        spawn() { throw new Error("Preparing an overlay must not launch an app."); },
        async run(command, options) {
            commands.push(command);
            if (options?.signal?.aborted) throw cancellationError();
            if (command.command === "/usr/bin/plutil") {
                const input = await fs.readFile(command.args.at(-1)!, "utf8");
                const output = command.args[command.args.indexOf("-o") + 1];
                if (output !== "-") await fs.writeFile(output, input);
                return { stdout: output === "-" ? input : "", stderr: "" };
            }
            throw new Error("Overlay preparation must not run Xcode or read build settings.");
        },
    };
    const request: PreviewRequest = { preview: { id: "automatic", name: "Original App", folder: root, project, scheme: "Original App", target: "Original App", configuration: "Debug", platforms: ["macos", "ios-simulator"], arguments: [], environment: {}, buildArguments: [], origin: { kind: "automatic", projectPath: project, targetID: "APP" } }, destination: { platform: "macos", name: "This Mac" }, storagePath: path.join(root, "Storage") };
    const prepare = (signal = new AbortController().signal) => prepareAutomaticHost(request, "/Xcode/Contents/Developer", "/Plugin Cache/Preview.dylib", runner, signal, () => {});
    return { root, project, source, originalSource, document, commands, runner, request, save, prepare, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test("automatic overlay preserves source membership, resources, scripts, local packages, and dependency target settings", async () => {
    const f = await fixture();
    try {
        const before = await fs.readFile(path.join(f.project, "project.pbxproj"), "utf8");
        const result = await f.prepare();
        const graph = JSON.parse(await fs.readFile(path.join(result.project!, "project.pbxproj"), "utf8"));
        const o = graph.objects;
        assert.equal(await fs.readFile(f.source, "utf8"), f.originalSource);
        assert.equal(await fs.readFile(path.join(f.project, "project.pbxproj"), "utf8"), before);
        assert.equal(o.PROJECT.projectDirPath, f.root);
        assert.equal(o.FILE.path, f.source);
        assert.equal(o.RESOURCE.path, path.join(f.root, "marker.txt"));
        assert.equal(o.CONFIG.path, path.join(f.root, "App.xcconfig"));
        assert.equal(o.PRODUCT.sourceTree, "BUILT_PRODUCTS_DIR");
        assert.equal(o.PACKAGE.relativePath, path.resolve(f.root, "../Support Package"));
        assert.deepEqual(o.SCRIPT, f.document.objects.SCRIPT);
        assert.deepEqual(o.APP.dependencies, ["DEPENDENCY"]);
        assert.deepEqual(o.LIBDEBUG, f.document.objects.LIBDEBUG);
        assert.equal(o.SOURCESPHASE.files.length, 5);
        assert.equal(o.SOURCESPHASE.files[0], "BUILD");
        const settings = o.DEBUG.buildSettings;
        assert.deepEqual(settings.OTHER_SWIFT_FLAGS.slice(0, 3), ["$(inherited)", "-D", "APP_FLAG"]);
        assert.ok(settings.OTHER_SWIFT_FLAGS.includes('"/Plugin Cache/Preview.dylib"'));
        assert.match(settings["OTHER_SWIFT_FLAGS[sdk=macosx*]"], /PLATFORM_FLAG.*OPENSWIFTUI_AUTOMATIC_HOST/);
        assert.match(settings.OTHER_LDFLAGS, /\$\(inherited\).*_openswiftui_preview_main/);
        assert.equal(settings["PRODUCT_BUNDLE_IDENTIFIER[sdk=iphonesimulator*]"], automaticBundleIdentifier(f.request.preview.origin!));
        assert.equal(settings["ENABLE_DEBUG_DYLIB[config=Debug]"], "NO");
        const originalSettings = f.document.objects.DEBUG.buildSettings as Record<string, unknown>;
        for (const key of Object.keys(originalSettings).filter(key => key.startsWith("INFOPLIST_") || key === "GENERATE_INFOPLIST_FILE")) {
            assert.deepEqual(settings[key], originalSettings[key], `Preserve original plist processing: ${key}`);
        }
        assert.ok(f.commands.every(command => command.command === "/usr/bin/plutil"));
        assert.ok(f.commands.every(command => !command.args.at(-1)!.endsWith("Info.plist")));
    } finally { await f.cleanup(); }
});

test("overlay cache is stable and invalidates when the package lock or graph changes", async () => {
    const f = await fixture();
    try {
        const first = await f.prepare();
        assert.equal((await f.prepare()).project, first.project);
        const lock = path.join(f.project, "project.xcworkspace/xcshareddata/swiftpm/Package.resolved");
        await fs.mkdir(path.dirname(lock), { recursive: true });
        await fs.writeFile(lock, '{"pins":[]}');
        const locked = await f.prepare();
        assert.notEqual(locked.project, first.project);
        assert.equal(await fs.readFile(path.join(locked.project!, "project.xcworkspace/xcshareddata/swiftpm/Package.resolved"), "utf8"), '{"pins":[]}');
        f.document.objects.SCRIPT.shellScript = "true";
        await f.save();
        assert.notEqual((await f.prepare()).project, locked.project);
        assert.ok((await fs.readdir(path.join(f.request.storagePath, "AutomaticHosts"))).every(name => !name.startsWith("preparing-")));
    } finally { await f.cleanup(); }
});

test("compiler-expanded hosts retain the project's macro implementation", async () => {
    const f = await fixture();
    try {
        const result = await prepareAutomaticHost(f.request, "/Xcode/Contents/Developer", "", f.runner,
            new AbortController().signal, () => {});
        const graph = JSON.parse(await fs.readFile(path.join(result.project!, "project.pbxproj"), "utf8"));
        const files = Object.values(graph.objects) as Array<Record<string, unknown>>;
        assert.ok(!files.some(file => typeof file.path === "string" && file.path.endsWith("/PreviewMacro.swift")),
            "The generated target must resolve #Preview from its own dependency.");
        const settings = graph.objects.DEBUG.buildSettings;
        assert.ok(!JSON.stringify(settings.OTHER_SWIFT_FLAGS).includes("-load-plugin-library"));
        assert.ok(!JSON.stringify(settings.OTHER_SWIFT_FLAGS).includes("OPENSWIFTUI_STANDALONE_PREVIEW"));
        assert.deepEqual(graph.objects.LIBDEBUG, f.document.objects.LIBDEBUG);
    } finally { await f.cleanup(); }
});

test("workspace overlay preserves external projects and rebases the shared scheme", async () => {
    const f = await fixture();
    try {
        const workspace = path.join(f.root, "Existing.xcworkspace");
        await fs.mkdir(path.join(workspace, "xcshareddata/xcschemes"), { recursive: true });
        await fs.writeFile(path.join(workspace, "contents.xcworkspacedata"), '<Workspace><FileRef location="group:Original App.xcodeproj"/><FileRef location="group:Support.xcodeproj"/></Workspace>');
        await fs.mkdir(path.join(f.root, "Support.xcodeproj"));
        await fs.writeFile(path.join(workspace, "xcshareddata/xcschemes/Original App.xcscheme"), '<Scheme><BuildAction><BuildActionEntries><BuildActionEntry><BuildableReference BlueprintIdentifier =  "APP" ReferencedContainer="container:Original App.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction><LaunchAction buildConfiguration="Debug"/></Scheme>');
        assert.equal(f.request.preview.origin?.kind, "automatic");
        if (f.request.preview.origin?.kind === "automatic") f.request.preview.origin.workspacePath = workspace;
        const result = await f.prepare();
        assert.equal(result.project, undefined);
        const data = await fs.readFile(path.join(result.workspace!, "contents.xcworkspacedata"), "utf8");
        assert.ok(data.includes(`absolute:${path.join(f.root, "Support.xcodeproj")}`));
        assert.ok(!data.includes(`absolute:${f.project}`));
        const derivedProject = path.join(path.dirname(result.workspace!), "Original App.xcodeproj");
        const scheme = await fs.readFile(path.join(derivedProject, "xcshareddata/xcschemes/Original App.xcscheme"), "utf8");
        assert.ok(scheme.includes(`container:${derivedProject}`));
        assert.ok(scheme.includes('<LaunchAction buildConfiguration="Debug"/>'));
    } finally { await f.cleanup(); }
});

test("failed and cancelled overlay preparation removes staging directories", async () => {
    const f = await fixture();
    try {
        const base = f.runner.run;
        const cancellation = new AbortController();
        f.runner.run = async (command, options) => {
            if (command.args.includes("xml1")) { cancellation.abort(); throw cancellationError(); }
            return base(command, options);
        };
        await assert.rejects(f.prepare(cancellation.signal), { name: "AbortError" });
        assert.deepEqual(await fs.readdir(path.join(f.request.storagePath, "AutomaticHosts")), []);
        f.request.preview.buildArguments = ["PRODUCT_BUNDLE_IDENTIFIER=original.app"];
        await assert.rejects(f.prepare(), /replace/);
    } finally { await f.cleanup(); }
});

test("user schemes retain build pre-actions and resolve symlinked project references", async () => {
    const f = await fixture();
    try {
        await fs.symlink(f.project, path.join(f.root, "Alias.xcodeproj"));
        const schemeDirectory = path.join(f.project, "xcuserdata/developer.xcuserdatad/xcschemes");
        await fs.mkdir(schemeDirectory, { recursive: true });
        await fs.writeFile(path.join(schemeDirectory, "Original App.xcscheme"), '<Scheme><BuildAction><PreActions><ExecutionAction ActionType="custom"/></PreActions><BuildActionEntries><BuildActionEntry><BuildableReference BlueprintIdentifier="APP" ReferencedContainer="container:Alias.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction></Scheme>');
        const result = await f.prepare();
        const scheme = await fs.readFile(path.join(result.project!, "xcshareddata/xcschemes/Original App.xcscheme"), "utf8");
        assert.ok(scheme.includes('<PreActions><ExecutionAction ActionType="custom"/></PreActions>'));
        assert.ok(scheme.includes(`container:${result.project}`));
        assert.ok(!scheme.includes("Alias.xcodeproj"));
    } finally { await f.cleanup(); }
});


test("finalizing a processed macOS plist preserves app metadata and enables the native Preview window", { skip: process.platform !== "darwin" }, async () => {
    const f = await fixture();
    f.runner.run = createProcessRunner().run;
    try {
        const app = path.join(f.request.storagePath, "Built.app");
        const plistPath = path.join(app, "Contents/Info.plist");
        await fs.mkdir(path.dirname(plistPath), { recursive: true });
        const custom = { CFBundleExecutable: "ExistingApp", CFBundleShortVersionString: "4.2", ProcessedNumber: 12, ResourceConfig: { names: ["marker.txt"], enabled: true } };
        await fs.writeFile(plistPath, JSON.stringify({ ...custom, CFBundleIdentifier: "original.app", NSMainNibFile: "Main", NSMainStoryboardFile: "Main", "NSMainStoryboardFile-macos": "MacMain", UIApplicationSceneManifest: {}, NSPrincipalClass: "OriginalApplication", "NSPrincipalClass-macos": "OtherApplication", LSUIElement: true, "LSUIElement-macos": true, LSBackgroundOnly: true }));
        const identity = automaticBundleIdentifier(f.request.preview.origin!);
        await finalizeAutomaticApp(app, { platform: "macos", name: "This Mac" }, identity, f.runner, new AbortController().signal);
        assert.deepEqual(JSON.parse((await f.runner.run({ command: "/usr/bin/plutil", args: ["-convert", "json", "-o", "-", plistPath] })).stdout), { ...custom, CFBundleIdentifier: identity, NSPrincipalClass: "NSApplication", LSUIElement: false, LSBackgroundOnly: false });
        assert.deepEqual(await fs.readdir(path.dirname(plistPath)), ["Info.plist"]);
    } finally { await f.cleanup(); }
});

test("finalizing an iOS plist replaces storyboard and scene startup while retaining processed resources", { skip: process.platform !== "darwin" }, async () => {
    const f = await fixture();
    f.runner.run = createProcessRunner().run;
    try {
        const app = path.join(f.request.storagePath, "Built.app");
        await fs.mkdir(app, { recursive: true });
        const plistPath = path.join(app, "Info.plist");
        const custom = { CFBundleExecutable: "ExistingApp", UIRequiredDeviceCapabilities: ["arm64"], NSCameraUsageDescription: "Use the camera.", CustomResourcePath: "Resources/marker.txt" };
        await fs.writeFile(plistPath, JSON.stringify({ ...custom, NSPrincipalClass: "OriginalApp", UIMainStoryboardFile: "Main", "UIMainStoryboardFile~ipad": "PadMain", UILaunchStoryboardName: "Launch", UIApplicationSceneManifest: { UISceneConfigurations: { Original: [] } }, UILaunchScreen: { UIColorName: "OriginalColor" }, "UILaunchScreen~ipad": { UIColorName: "PadColor" } }));
        await finalizeAutomaticApp(app, { platform: "ios-simulator", name: "iPhone", udid: "fixture" }, "preview.app", f.runner, new AbortController().signal);
        assert.deepEqual(JSON.parse((await f.runner.run({ command: "/usr/bin/plutil", args: ["-convert", "json", "-o", "-", plistPath] })).stdout), { ...custom, CFBundleIdentifier: "preview.app", UIApplicationSceneManifest: { UIApplicationSupportsMultipleScenes: false, UISceneConfigurations: {} }, UILaunchScreen: {} });
    } finally { await f.cleanup(); }
});

test("plist finalization failures and cancellation preserve the built plist and stop before launch", { skip: process.platform !== "darwin" }, async () => {
    const f = await fixture();
    f.runner.run = createProcessRunner().run;
    try {
        const app = path.join(f.request.storagePath, "Built.app");
        const plistPath = path.join(app, "Contents/Info.plist");
        await fs.mkdir(path.dirname(plistPath), { recursive: true });
        const original = '{"CFBundleIdentifier":"original.app"}';
        await fs.writeFile(plistPath, original);
        const base = f.runner.run;
        const abort = new AbortController();
        f.runner.run = async (command, options) => {
            if (command.args.includes("xml1")) {
                await base(command, options);
                abort.abort();
                return { stdout: "", stderr: "" };
            }
            return base(command, options);
        };
        await assert.rejects(finalizeAutomaticApp(app, f.request.destination, "preview.app", f.runner, abort.signal), { name: "AbortError" });
        assert.equal(await fs.readFile(plistPath, "utf8"), original);
        assert.deepEqual(await fs.readdir(path.dirname(plistPath)), ["Info.plist"]);
        f.runner.run = async (command, options) => {
            if (command.args.includes("-insert")) throw new Error("Could not serialize plist");
            return base(command, options);
        };
        await assert.rejects(finalizeAutomaticApp(app, f.request.destination, "preview.app", f.runner, new AbortController().signal), /serialize plist/);
        assert.equal(await fs.readFile(plistPath, "utf8"), original);
        f.runner.run = base;
        await fs.writeFile(plistPath, "[]");
        await assert.rejects(finalizeAutomaticApp(app, f.request.destination, "preview.app", f.runner, new AbortController().signal), /dictionary/);
        assert.equal(await fs.readFile(plistPath, "utf8"), "[]");
    } finally { await f.cleanup(); }
});


test("native plist edits preserve data, dates, and nested startup names", { skip: process.platform !== "darwin" }, async () => {
    const f = await fixture();
    const runner = createProcessRunner();
    try {
        const app = path.join(f.request.storagePath, "Typed.app");
        const plistPath = path.join(app, "Contents/Info.plist");
        await fs.mkdir(path.dirname(plistPath), { recursive: true });
        await fs.writeFile(plistPath, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CustomDate</key><date>2026-10-11T00:00:00Z</date><key>CustomData</key><data>aGVsbG8=</data><key>Nested</key><dict><key>NSMainStoryboardFile</key><string>Keep nested value</string></dict><key>Literal&amp;#100;</key><string>Keep encoded text</string><key>NSMainStoryboardFile</key><string>Main</string></dict></plist>');
        await finalizeAutomaticApp(app, f.request.destination, "preview.app", runner, new AbortController().signal);
        const extract = async (key: string) => (await runner.run({ command: "/usr/bin/plutil", args: ["-extract", key, "raw", "-n", "-o", "-", plistPath] })).stdout;
        assert.equal(await extract("CustomDate"), "2026-10-11T00:00:00Z");
        assert.equal(await extract("CustomData"), "aGVsbG8=");
        assert.equal(await extract("Nested.NSMainStoryboardFile"), "Keep nested value");
        assert.equal(await extract("Literal&#100;"), "Keep encoded text");
        assert.equal(await extract("CFBundleIdentifier"), "preview.app");
        await assert.rejects(extract("NSMainStoryboardFile"));
    } finally { await f.cleanup(); }
});
