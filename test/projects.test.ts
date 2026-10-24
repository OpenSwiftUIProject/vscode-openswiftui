import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { resolvePreviewTargets, readXcodeProject, resolveProjectFiles, targetSources } from "../src/projects";
import { cancellationError, Command, ProcessRunner } from "../src/process";

async function fixture() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openswiftui-projects-")));
    const project = path.join(root, "Different App.xcodeproj");
    const source = path.join(root, "Sources", "Views", "Content.swift");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(project);
    await fs.writeFile(source, "#Preview { ContentView() }\n");
    const document = {
        archiveVersion: "1", objectVersion: "77", classes: {}, rootObject: "PROJECT",
        objects: {
            PROJECT: { isa: "PBXProject", mainGroup: "ROOT", targets: ["APP"], projectDirPath: "" },
            ROOT: { isa: "PBXGroup", sourceTree: "<group>", children: ["SOURCES"] },
            SOURCES: { isa: "PBXGroup", path: "Sources", sourceTree: "<group>", children: ["VIEWS"] },
            VIEWS: { isa: "PBXGroup", path: "Views", sourceTree: "<group>", children: ["FILE"] },
            FILE: { isa: "PBXFileReference", path: "Content.swift", sourceTree: "<group>" },
            BUILD: { isa: "PBXBuildFile", fileRef: "FILE" },
            PHASE: { isa: "PBXSourcesBuildPhase", files: ["BUILD"] },
            APP: { isa: "PBXNativeTarget", name: "Different App", productType: "com.apple.product-type.application", buildPhases: ["PHASE"], buildConfigurationList: "CONFIGS" },
            CONFIGS: { isa: "XCConfigurationList", buildConfigurations: ["DEBUG"], defaultConfigurationName: "Debug" },
            DEBUG: { isa: "XCBuildConfiguration", name: "Debug", buildSettings: {} },
        } as Record<string, Record<string, unknown>>,
    };
    const commands: Command[] = [];
    const runner: ProcessRunner = {
        spawn() { throw new Error("Discovery must not launch an app."); },
        async run(command, options) {
            commands.push(command);
            if (options?.signal?.aborted) throw cancellationError();
            if (command.command === "/usr/bin/plutil") return { stdout: await fs.readFile(command.args.at(-1)!, "utf8"), stderr: "" };
            if (command.args.includes("-list")) return { stdout: JSON.stringify({ project: { schemes: ["Different App"] } }), stderr: "" };
            assert.ok(command.args.includes("-showBuildSettings"));
            return { stdout: JSON.stringify([{ target: "Different App", buildSettings: {
                TARGET_NAME: "Different App", PROJECT_FILE_PATH: project, PRODUCT_TYPE: "com.apple.product-type.application",
                SUPPORTED_PLATFORMS: "macosx iphoneos iphonesimulator",
            } }]), stderr: "" };
        },
    };
    const save = () => fs.writeFile(path.join(project, "project.pbxproj"), JSON.stringify(document));
    await save();
    const options = { developerDirectory: "/Xcode/Contents/Developer", storagePath: path.join(root, "Cache"), signal: new AbortController().signal, log: () => {}, runner };
    const resolve = () => resolvePreviewTargets({ filePath: source, line: 1, column: 1 }, [root], options);
    return { root, project, source, document, commands, runner, save, options, resolve,
        cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function scheme(target = "APP", project = "Different App.xcodeproj") {
    return `<Scheme><BuildAction><BuildActionEntries><BuildActionEntry buildForRunning="YES"><BuildableReference BlueprintIdentifier="${target}" ReferencedContainer="container:${project}"/></BuildActionEntry></BuildActionEntries></BuildAction><LaunchAction buildConfiguration="Debug"/></Scheme>`;
}

test("automatic discovery resolves nested group membership without configuration or app build", async () => {
    const f = await fixture();
    try {
        const results = await f.resolve();
        assert.equal(results.length, 1);
        assert.equal(results[0].target, "Different App");
        assert.equal(results[0].scheme, "Different App");
        assert.equal(results[0].folder, f.root);
        assert.deepEqual(results[0].platforms, ["macos", "ios-simulator"]);
        assert.deepEqual(results[0].origin, { kind: "automatic", projectPath: f.project, targetID: "APP" });
        assert.equal(results[0].previewID, undefined);
        assert.ok(f.commands.every(command => !command.args.includes("build")));
        for (const command of f.commands.filter(command => command.command === "/usr/bin/xcrun")) {
            const cacheFlag = command.args.indexOf("-clonedSourcePackagesDirPath");
            assert.equal(command.args[cacheFlag + 1], path.join(f.options.storagePath, "SourcePackages"));
        }
        const model = await readXcodeProject(f.project, f.options.signal, f.runner);
        assert.equal(model.document.objectVersion, "77");
        assert.equal(resolveProjectFiles(model).get("FILE"), f.source);
    } finally { await f.cleanup(); }
});

test("a source is not owned just because it is next to an app project", async () => {
    const f = await fixture();
    try {
        f.document.objects.PHASE.files = [];
        await f.save();
        await assert.rejects(f.resolve(), /not.*application target|no.*application target/i);
        assert.ok(f.commands.every(command => !command.args.includes("-showBuildSettings")));
    } finally { await f.cleanup(); }
});

test("workspace schemes are matched by target UUID and project reference", async () => {
    const f = await fixture();
    try {
        const workspace = path.join(f.root, "Workspace.xcworkspace");
        await fs.mkdir(path.join(workspace, "xcshareddata", "xcschemes"), { recursive: true });
        await fs.writeFile(path.join(workspace, "contents.xcworkspacedata"), '<Workspace><Group location="group:"><FileRef location="group:Different App.xcodeproj"/></Group></Workspace>');
        await fs.writeFile(path.join(workspace, "xcshareddata/xcschemes/Preview & Run.xcscheme"), scheme());
        const result = (await f.resolve())[0];
        assert.equal(result.workspace, workspace);
        assert.equal(result.project, undefined);
        assert.equal(result.scheme, "Preview & Run");
        assert.equal((result.origin?.kind === "automatic" ? result.origin.workspacePath : undefined), workspace);
    } finally { await f.cleanup(); }
});

test("a file in two app targets returns two choices instead of guessing", async () => {
    const f = await fixture();
    try {
        f.document.objects.PROJECT.targets = ["APP", "OTHER"];
        f.document.objects.OTHER = { ...f.document.objects.APP, name: "Other" };
        const shared = path.join(f.project, "xcshareddata/xcschemes");
        await fs.mkdir(shared, { recursive: true });
        await fs.writeFile(path.join(shared, "All Apps.xcscheme"), scheme().replace("</BuildActionEntries>", '<BuildActionEntry buildForRunning="YES"><BuildableReference BlueprintIdentifier="OTHER" ReferencedContainer="container:Different App.xcodeproj"/></BuildActionEntry></BuildActionEntries>'));
        const originalRun = f.runner.run;
        f.runner.run = async (command, options) => {
            const result = await originalRun(command, options);
            if (command.args.includes("-showBuildSettings")) {
                const rows = JSON.parse(result.stdout); rows.push({ ...rows[0], target: "Other", buildSettings: { ...rows[0].buildSettings, TARGET_NAME: "Other" } });
                result.stdout = JSON.stringify(rows);
            }
            return result;
        };
        await f.save();
        assert.deepEqual((await f.resolve()).map(value => (value.origin?.kind === "automatic" ? value.origin.targetID : undefined)).sort(), ["APP", "OTHER"]);
    } finally { await f.cleanup(); }
});

test("synchronized groups apply membership exceptions and source platform filters", async () => {
    const f = await fixture();
    try {
        f.document.objects.PHASE.files = [];
        f.document.objects.APP.fileSystemSynchronizedGroups = ["SYNC"];
        f.document.objects.ROOT.children = ["SYNC"];
        f.document.objects.SYNC = { isa: "PBXFileSystemSynchronizedRootGroup", path: "Sources", sourceTree: "<group>", exceptions: ["EXCEPTION"] };
        f.document.objects.EXCEPTION = { isa: "PBXFileSystemSynchronizedBuildFileExceptionSet", target: "APP", platformFiltersByRelativePath: { "Views/Content.swift": ["ios"] }, membershipExceptions: ["Excluded.swift"] };
        await fs.writeFile(path.join(f.root, "Sources/Excluded.swift"), "#Preview {}\n");
        await f.save();
        const model = await readXcodeProject(f.project, f.options.signal, f.runner);
        const files = await targetSources(model, "APP", f.options.signal);
        assert.deepEqual(files, [{ filePath: f.source, platforms: ["ios-simulator"] }]);
        assert.deepEqual((await f.resolve())[0].platforms, ["ios-simulator"]);
        f.document.objects.EXCEPTION.membershipExceptions = ["Views/Content.swift"];
        await f.save();
        await assert.rejects(f.resolve(), /application target/i);
    } finally { await f.cleanup(); }
});

test("traditional membership matches canonical paths and respects build-file platform filters", async () => {
    const f = await fixture();
    try {
        const alias = path.join(f.root, "Alias.swift");
        await fs.symlink(f.source, alias);
        f.document.objects.FILE.path = alias;
        f.document.objects.FILE.sourceTree = "<absolute>";
        f.document.objects.BUILD.platformFilter = "macos";
        await f.save();
        assert.deepEqual((await f.resolve())[0].platforms, ["macos"]);
    } finally { await f.cleanup(); }
});

test("library-only ownership is reported explicitly", async () => {
    const f = await fixture();
    try {
        f.document.objects.APP.productType = "com.apple.product-type.framework";
        await f.save();
        await assert.rejects(f.resolve(), /library|framework/i);
    } finally { await f.cleanup(); }
});

test("cancellation stops project queries and never returns candidates", async () => {
    const f = await fixture();
    try {
        const cancellation = new AbortController(); cancellation.abort();
        await assert.rejects(resolvePreviewTargets({ filePath: f.source, line: 1, column: 1 }, [f.root], { ...f.options, signal: cancellation.signal }), { name: "AbortError" });
        assert.equal(f.commands.length, 0);
    } finally { await f.cleanup(); }
});


test("a workspace source symlink can belong to a target through its external canonical path", async () => {
    const f = await fixture();
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "openswiftui-external-source-"));
    try {
        const original = path.join(external, "Shared.swift");
        await fs.writeFile(original, "#Preview {}\n");
        await fs.rm(f.source);
        await fs.symlink(original, f.source);
        f.document.objects.FILE.path = original;
        f.document.objects.FILE.sourceTree = "<absolute>";
        await f.save();
        assert.equal(((await f.resolve())[0].origin as import("../src/types").AutomaticPreviewOrigin).targetID, "APP");
    } finally { await f.cleanup(); await fs.rm(external, { recursive: true, force: true }); }
});

test("Stop cancels an in-flight build-settings query without returning stale ownership", async () => {
    const f = await fixture();
    try {
        const controller = new AbortController();
        const previous = f.runner.run;
        let queried!: () => void;
        const started = new Promise<void>(resolve => { queried = resolve; });
        f.runner.run = async (command, options) => {
            if (!command.args.includes("-showBuildSettings")) return previous(command, options);
            assert.equal(options?.signal, controller.signal);
            queried();
            return new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(cancellationError()), { once: true }));
        };
        const resolving = resolvePreviewTargets({ filePath: f.source, line: 1, column: 1 }, [f.root], { ...f.options, signal: controller.signal });
        await started;
        controller.abort();
        await assert.rejects(resolving, { name: "AbortError" });
    } finally { await f.cleanup(); }
});

test("a standalone Swift library resolves the exact manifest target and exported product", async () => {
    const f = await fixture();
    try {
        await fs.rm(f.project, { recursive: true, force: true });
        await fs.writeFile(path.join(f.root, "Package.swift"), "// swift-tools-version:6.3\n");
        f.runner.run = async (command, options) => {
            f.commands.push(command);
            assert.equal(command.command, "/usr/bin/xcrun");
            assert.deepEqual(command.args.slice(-3), ["describe", "--type", "json"]);
            assert.equal(options?.signal, f.options.signal);
            assert.equal(command.env?.DEVELOPER_DIR, f.options.developerDirectory);
            return { stdout: JSON.stringify({ path: f.root, name: "Demo", platforms: [{ name: "ios", version: "18.0" }],
                products: [{ name: "DemoViews", type: { library: ["automatic"] }, targets: ["View-Types"] }],
                targets: [{ name: "View-Types", c99name: "View_Types", type: "library", module_type: "SwiftTarget",
                    path: "Sources/Views", sources: ["Content.swift"], product_memberships: ["DemoViews"] }] }), stderr: "" };
        };
        const targets = await f.resolve();
        assert.equal(targets.length, 1);
        assert.deepEqual(targets[0].origin, { kind: "package", packagePath: f.root, targetName: "View-Types", productName: "DemoViews", moduleName: "View_Types" });
        assert.deepEqual(targets[0].platforms, ["macos", "ios-simulator"]);
        assert.equal(targets[0].folder, f.root);
        assert.equal(targets[0].project, undefined);
        assert.equal(await fs.readFile(path.join(f.root, "Package.swift"), "utf8"), "// swift-tools-version:6.3\n");
        assert.equal(await fs.access(path.join(f.root, ".vscode")).then(() => true, () => false), false);
    } finally { await f.cleanup(); }
});


test("native OpenStep synchronized-folder metadata preserves exclusions and platform-filter dictionaries", { skip: process.platform !== "darwin" }, async () => {
    const f = await fixture();
    try {
        await fs.writeFile(path.join(f.root, "Sources/Excluded.swift"), "#Preview {}\n");
        // Xcode stores these fields as OpenStep dictionaries and arrays, not explicit source build files.
        await fs.writeFile(path.join(f.project, "project.pbxproj"), `// !$*UTF8*$!
        {
            archiveVersion = 1; classes = {}; objectVersion = 77;
            objects = {
                A00000000000000000000001 = { isa = PBXProject; mainGroup = A00000000000000000000002; targets = (A00000000000000000000003,); };
                A00000000000000000000002 = { isa = PBXGroup; children = (A00000000000000000000004,); sourceTree = "<group>"; };
                A00000000000000000000003 = { isa = PBXNativeTarget; name = NativeApp; productType = "com.apple.product-type.application"; buildPhases = (A00000000000000000000005,); fileSystemSynchronizedGroups = (A00000000000000000000004,); };
                A00000000000000000000004 = { isa = PBXFileSystemSynchronizedRootGroup; exceptions = (A00000000000000000000006,); explicitFileTypes = {}; explicitFolders = (); path = Sources; sourceTree = "<group>"; };
                A00000000000000000000005 = { isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
                A00000000000000000000006 = { isa = PBXFileSystemSynchronizedBuildFileExceptionSet; membershipExceptions = (Excluded.swift,); platformFiltersByRelativePath = { "Views/Content.swift" = (ios,); }; target = A00000000000000000000003; };
            };
            rootObject = A00000000000000000000001;
        }`);
        const model = await readXcodeProject(f.project, f.options.signal);
        assert.equal(model.document.objectVersion, "77");
        assert.deepEqual(await targetSources(model, "A00000000000000000000003", f.options.signal), [
            { filePath: f.source, platforms: ["ios-simulator"] },
        ]);
    } finally { await f.cleanup(); }
});


test("a project-owned shared scheme keeps its containing workspace dependency context", async () => {
    const f = await fixture();
    try {
        const workspace = path.join(f.root, "Dependency Graph.xcworkspace");
        await fs.mkdir(workspace);
        await fs.writeFile(path.join(workspace, "contents.xcworkspacedata"), '<Workspace><FileRef location="group:Different App.xcodeproj"/></Workspace>');
        const shared = path.join(f.project, "xcshareddata/xcschemes");
        await fs.mkdir(shared, { recursive: true });
        await fs.writeFile(path.join(shared, "Different App.xcscheme"), scheme());
        const results = await f.resolve();
        assert.equal(results.length, 1);
        assert.equal(results[0].workspace, workspace);
        assert.equal((results[0].origin?.kind === "automatic" ? results[0].origin.workspacePath : undefined), workspace);
        const query = f.commands.find(command => command.args.includes("-showBuildSettings"))!;
        assert.equal(query.args[query.args.indexOf("-workspace") + 1], workspace);
        assert.ok(!query.args.includes("-project"));
    } finally { await f.cleanup(); }
});

test("the target-named scheme takes priority over a narrower workspace scheme", async () => {
    const f = await fixture();
    try {
        const workspace = path.join(f.root, "Workspace.xcworkspace");
        await fs.mkdir(path.join(workspace, "xcshareddata/xcschemes"), { recursive: true });
        await fs.writeFile(path.join(workspace, "contents.xcworkspacedata"), '<Workspace><FileRef location="group:Different App.xcodeproj"/></Workspace>');
        await fs.writeFile(path.join(workspace, "xcshareddata/xcschemes/All Applications.xcscheme"), scheme());
        const shared = path.join(f.project, "xcshareddata/xcschemes");
        await fs.mkdir(shared, { recursive: true });
        await fs.writeFile(path.join(shared, "Different App.xcscheme"), scheme().replace("</BuildActionEntries>", '<BuildActionEntry buildForRunning="YES"><BuildableReference BlueprintIdentifier="LIBRARY" ReferencedContainer="container:Different App.xcodeproj"/></BuildActionEntry></BuildActionEntries>'));
        const results = await f.resolve();
        assert.equal(results.length, 1);
        assert.equal(results[0].scheme, "Different App");
        assert.equal(results[0].workspace, workspace);
        assert.equal(f.commands.filter(command => command.args.includes("-showBuildSettings")).length, 1);
    } finally { await f.cleanup(); }
});

test("a narrower scheme wins over a workspace aggregate using distinct running target references", async () => {
    const f = await fixture();
    try {
        const workspace = path.join(f.root, "Workspace.xcworkspace");
        const workspaceSchemes = path.join(workspace, "xcshareddata/xcschemes");
        const projectSchemes = path.join(f.project, "xcshareddata/xcschemes");
        await fs.mkdir(workspaceSchemes, { recursive: true });
        await fs.mkdir(projectSchemes, { recursive: true });
        await fs.writeFile(path.join(workspace, "contents.xcworkspacedata"), '<Workspace><FileRef location="group:Different App.xcodeproj"/></Workspace>');
        // Repeated entries and targets used only for testing do not widen the running build.
        const duplicate = '<BuildActionEntry buildForRunning="YES"><BuildableReference BlueprintIdentifier="APP" ReferencedContainer="container:Different App.xcodeproj"/></BuildActionEntry>';
        const testOnly = '<BuildActionEntry buildForRunning="NO"><BuildableReference BlueprintIdentifier="TESTS" ReferencedContainer="container:Different App.xcodeproj"/></BuildActionEntry>';
        const narrow = scheme().replace("</BuildActionEntries>", `${duplicate}${duplicate}${testOnly}</BuildActionEntries>`);
        // A matching target UUID in a different project is a distinct target.
        const aggregate = scheme().replace("</BuildActionEntries>", '<BuildActionEntry buildForRunning="YES"><BuildableReference BlueprintIdentifier="APP" ReferencedContainer="container:Dependency.xcodeproj"/></BuildActionEntry></BuildActionEntries>');
        await fs.writeFile(path.join(workspaceSchemes, "Workspace Aggregate.xcscheme"), aggregate);
        await fs.writeFile(path.join(projectSchemes, "OSUI_Example.xcscheme"), narrow);
        const results = await f.resolve();
        assert.equal(results.length, 1);
        assert.equal(results[0].scheme, "OSUI_Example");
        assert.equal(results[0].workspace, workspace);
        assert.equal((results[0].origin?.kind === "automatic" ? results[0].origin.workspacePath : undefined), workspace);
        const queries = f.commands.filter(command => command.args.includes("-showBuildSettings"));
        assert.equal(queries.length, 1);
        assert.equal(queries[0].args[queries[0].args.indexOf("-workspace") + 1], workspace);
        assert.ok(!queries[0].args.includes("-project"));
    } finally { await f.cleanup(); }
});

test("the target default configuration takes priority over a narrower running build", async () => {
    const f = await fixture();
    try {
        const shared = path.join(f.project, "xcshareddata/xcschemes");
        await fs.mkdir(shared, { recursive: true });
        const debug = scheme().replace("</BuildActionEntries>", '<BuildActionEntry buildForRunning="YES"><BuildableReference BlueprintIdentifier="LIBRARY" ReferencedContainer="container:Different App.xcodeproj"/></BuildActionEntry></BuildActionEntries>');
        await fs.writeFile(path.join(shared, "Debug App.xcscheme"), debug);
        await fs.writeFile(path.join(shared, "Release App.xcscheme"), scheme().replace('buildConfiguration="Debug"', 'buildConfiguration="Release"'));
        const results = await f.resolve();
        assert.equal(results[0].scheme, "Debug App");
        assert.equal(results[0].configuration, "Debug");
    } finally { await f.cleanup(); }
});

test("equal running build scopes still prefer a workspace-owned scheme", async () => {
    const f = await fixture();
    try {
        const workspace = path.join(f.root, "Workspace.xcworkspace");
        const workspaceSchemes = path.join(workspace, "xcshareddata/xcschemes");
        const projectSchemes = path.join(f.project, "xcshareddata/xcschemes");
        await fs.mkdir(workspaceSchemes, { recursive: true });
        await fs.mkdir(projectSchemes, { recursive: true });
        await fs.writeFile(path.join(workspace, "contents.xcworkspacedata"), '<Workspace><FileRef location="group:Different App.xcodeproj"/></Workspace>');
        await fs.writeFile(path.join(workspaceSchemes, "Workspace Run.xcscheme"), scheme());
        await fs.writeFile(path.join(projectSchemes, "App Run.xcscheme"), scheme());
        assert.equal((await f.resolve())[0].scheme, "Workspace Run");
    } finally { await f.cleanup(); }
});

test("different containing workspaces remain distinct owning-project choices", async () => {
    const f = await fixture();
    try {
        const shared = path.join(f.project, "xcshareddata/xcschemes");
        await fs.mkdir(shared, { recursive: true });
        await fs.writeFile(path.join(shared, "Different App.xcscheme"), scheme());
        for (const name of ["First", "Second"]) {
            const workspace = path.join(f.root, `${name}.xcworkspace`);
            await fs.mkdir(workspace);
            await fs.writeFile(path.join(workspace, "contents.xcworkspacedata"), '<Workspace><FileRef location="group:Different App.xcodeproj"/></Workspace>');
        }
        const results = await f.resolve();
        assert.equal(results.length, 2);
        assert.equal(new Set(results.map(value => (value.origin?.kind === "automatic" ? value.origin.targetID : undefined))).size, 1);
        assert.equal(new Set(results.map(value => value.workspace)).size, 2);
    } finally { await f.cleanup(); }
});
