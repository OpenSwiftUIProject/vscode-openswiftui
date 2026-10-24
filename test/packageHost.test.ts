import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { packageBundleIdentifier, packageHostModuleName, preparePackageHost, resolvePackagePreviewTargets } from "../src/packageHost";
import { cancellationError, ProcessRunner } from "../src/process";
import { PreviewRequest } from "../src/types";

async function fixture() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openswiftui-package-host-")));
    const packagePath = path.join(root, "Original Package");
    const source = path.join(packagePath, "Custom Sources", "Content.swift");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "private struct Content {}\n");
    await fs.writeFile(path.join(packagePath, "Package.swift"), "// swift-tools-version:6.3\n");
    const metadata = { name: "Demo", path: packagePath, platforms: [{ name: "macos", version: "15.0" }, { name: "ios", version: "18.0" }],
        products: [{ name: "DemoProduct", type: { library: ["automatic"] }, targets: ["View-Types"] }],
        targets: [{ name: "View-Types", c99name: "View_Types", type: "library", module_type: "SwiftTarget", path: "Custom Sources",
            sources: ["Content.swift"], product_memberships: ["DemoProduct"], resources: [{ path: "Resources", rule: { process: {} } }] }] };
    const runner: ProcessRunner = {
        spawn() { throw new Error("Package preparation must not launch an app."); },
        async run(command, options) {
            if (options?.signal?.aborted) throw cancellationError();
            if (command.command === "/usr/bin/xcrun") {
                assert.equal(command.args[0], "swift");
                assert.ok(command.args.includes("describe"));
                assert.equal(command.args[command.args.indexOf("--package-path") + 1], packagePath);
                return { stdout: JSON.stringify(metadata), stderr: "" };
            }
            assert.equal(command.command, "/usr/bin/plutil");
            const input = await fs.readFile(command.args.at(-1)!, "utf8");
            const output = command.args[command.args.indexOf("-o") + 1];
            await fs.writeFile(output, input);
            return { stdout: "", stderr: "" };
        },
    };
    const options = { storagePath: path.join(root, "Storage With Spaces"), signal: new AbortController().signal, runner, log() {} };
    const sourcePreview = { filePath: source, line: 2, column: 1 };
    const request: PreviewRequest = {
        preview: { id: "package", name: "View-Types", folder: packagePath, scheme: "OpenSwiftUIPreviewHost", configuration: "Debug",
            platforms: ["macos", "ios-simulator"], arguments: [], environment: {}, buildArguments: [],
            origin: { kind: "package", packagePath, targetName: "View-Types", productName: "DemoProduct", moduleName: "View_Types" } },
        sourcePreview, storagePath: options.storagePath, destination: { platform: "macos", name: "This Mac" },
    };
    const resolve = () => resolvePackagePreviewTargets(sourcePreview, [packagePath], options);
    const prepare = () => preparePackageHost(request, "/Xcode/Contents/Developer", runner, options.signal, () => {});
    return { root, packagePath, source, metadata, runner, options, request, resolve, prepare, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test("package resolution uses described source membership and exported library products", async () => {
    const f = await fixture();
    try {
        const result = await f.resolve();
        assert.equal(result.length, 1);
        assert.deepEqual(result[0].origin, f.request.preview.origin);
        f.metadata.targets[0].sources = ["Different.swift"];
        await assert.rejects(f.resolve(), /not.*Swift.*target|No.*target/i);
        f.metadata.targets[0].sources = ["Content.swift"];
        f.metadata.targets[0].type = "test";
        await assert.rejects(f.resolve(), /Swift library target/);
        f.metadata.targets[0].type = "library";
        f.metadata.products = [];
        await assert.rejects(f.resolve(), /exported library product/);
    } finally { await f.cleanup(); }
});

test("package candidates retain product ambiguity without treating deployment minimums as a platform whitelist", async () => {
    const f = await fixture();
    try {
        f.metadata.products.push({ name: "AnotherProduct", type: { library: ["dynamic"] }, targets: ["View-Types"] });
        assert.deepEqual((await f.resolve()).map(item => item.origin?.kind === "package" && item.origin.productName).sort(), ["AnotherProduct", "DemoProduct"]);
        f.metadata.platforms = [{ name: "ios", version: "18.0" }];
        assert.deepEqual((await f.resolve())[0].platforms, ["macos", "ios-simulator"]);
        f.metadata.platforms = [];
        assert.deepEqual((await f.resolve())[0].platforms, ["macos", "ios-simulator"]);
        f.metadata.platforms = [{ name: "watchos", version: "11.0" }];
        assert.deepEqual((await f.resolve())[0].platforms, ["macos", "ios-simulator"]);
    } finally { await f.cleanup(); }
});

test("generated app links the original package product and isolates identity without copying package sources or resources", async () => {
    const f = await fixture();
    try {
        const original = await fs.readFile(f.source, "utf8");
        const result = await f.prepare();
        assert.equal(result.origin, f.request.preview.origin);
        assert.equal(result.folder, f.packagePath);
        assert.equal(result.target, "OpenSwiftUIPreviewHost");
        const graph = JSON.parse(await fs.readFile(path.join(result.project!, "project.pbxproj"), "utf8"));
        const objects = Object.values(graph.objects) as Array<Record<string, any>>;
        const app = objects.find(item => item.isa === "PBXNativeTarget")!;
        const product = graph.objects[app.packageProductDependencies[0]];
        assert.equal(product.productName, "DemoProduct");
        assert.equal(graph.objects[product.package].relativePath, f.packagePath);
        const frameworkPhase = app.buildPhases.map((id: string) => graph.objects[id]).find((item: any) => item.isa === "PBXFrameworksBuildPhase");
        assert.equal(graph.objects[frameworkPhase.files[0]].productRef, app.packageProductDependencies[0]);
        assert.equal(objects.filter(item => item.isa === "PBXNativeTarget").length, 1);
        assert.equal(objects.filter(item => item.isa === "PBXFileReference" && item.lastKnownFileType === "sourcecode.swift").length, 1);
        const settings = graph.objects[graph.objects[app.buildConfigurationList].buildConfigurations[0]].buildSettings;
        assert.match(settings.PRODUCT_BUNDLE_IDENTIFIER, /^org\.openswiftuiproject\.openswiftui\.preview\./);
        assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, packageBundleIdentifier(f.request.preview.origin as import("../src/types").PackagePreviewOrigin));
        assert.equal(settings.MACOSX_DEPLOYMENT_TARGET, "15.0");
        assert.equal(settings.IPHONEOS_DEPLOYMENT_TARGET, "18.0");
        assert.equal(settings.ENABLE_DEBUG_DYLIB, "NO");
        assert.equal(settings.ONLY_ACTIVE_ARCH, "YES", "The app must use the same active architecture as SwiftPM Debug targets.");
        assert.equal(settings.FRAMEWORK_SEARCH_PATHS, undefined);
        assert.equal(settings.OTHER_SWIFT_FLAGS, undefined);
        assert.equal(await fs.readFile(f.source, "utf8"), original);
        assert.equal(await fs.access(path.join(f.packagePath, ".vscode")).then(() => true, () => false), false);
    } finally { await f.cleanup(); }
});

test("a package module matching the host name keeps a separate compiler flag scope", async () => {
    const f = await fixture();
    try {
        const origin = f.request.preview.origin as import("../src/types").PackagePreviewOrigin;
        origin.moduleName = "OpenSwiftUIPreviewHost";
        f.metadata.targets[0].c99name = origin.moduleName;
        const result = await f.prepare();
        const graph = JSON.parse(await fs.readFile(path.join(result.project!, "project.pbxproj"), "utf8"));
        const settings = (Object.values(graph.objects) as Array<Record<string, any>>)
            .find(item => item.isa === "XCBuildConfiguration" && item.buildSettings.PRODUCT_MODULE_NAME)!.buildSettings;
        assert.notEqual(settings.PRODUCT_MODULE_NAME, origin.moduleName);
        assert.equal(settings.PRODUCT_MODULE_NAME, packageHostModuleName(origin));
    } finally { await f.cleanup(); }
});

test("package host cache copies lockfiles, enforces pins, and invalidates after manifest or lock edits", async () => {
    const f = await fixture();
    try {
        const first = await f.prepare();
        assert.equal((await f.prepare()).project, first.project);
        const lock = '{"version":3,"pins":[{"identity":"dependency"}]}\n';
        await fs.writeFile(path.join(f.packagePath, "Package.resolved"), lock);
        const second = await f.prepare();
        assert.notEqual(second.project, first.project);
        assert.equal(await fs.readFile(path.join(second.project!, "project.xcworkspace/xcshareddata/swiftpm/Package.resolved"), "utf8"), lock);
        assert.ok(second.buildArguments.includes("-onlyUsePackageVersionsFromResolvedFile"));
        assert.equal(await fs.readFile(path.join(f.packagePath, "Package.resolved"), "utf8"), lock);
        await fs.appendFile(path.join(f.packagePath, "Package.swift"), "// Changed target settings\n");
        assert.notEqual((await f.prepare()).project, second.project);
        assert.ok((await fs.readdir(path.join(f.options.storagePath, "PackageHosts"))).every(name => !name.startsWith("preparing-")));
    } finally { await f.cleanup(); }
});

test("cancellation prevents returning a package target or publishing a partial generated app", async () => {
    const f = await fixture();
    try {
        const abort = new AbortController();
        const base = f.runner.run;
        f.runner.run = async (command, options) => { const result = await base(command, options); abort.abort(); return result; };
        await assert.rejects(resolvePackagePreviewTargets(f.request.sourcePreview!, [f.packagePath], { ...f.options, signal: abort.signal }), { name: "AbortError" });
        await assert.rejects(preparePackageHost(f.request, "/Xcode", f.runner, abort.signal, () => {}), { name: "AbortError" });
        assert.equal(await fs.access(path.join(f.options.storagePath, "PackageHosts")).then(() => true, () => false), false);
    } finally { await f.cleanup(); }
});

test("a source removed from the package target cannot reuse an earlier resolution", async () => {
    const f = await fixture();
    try {
        f.metadata.targets[0].sources = ["Different.swift"];
        await assert.rejects(f.prepare(), /source.*no longer.*target/i);
        assert.equal(await fs.access(path.join(f.options.storagePath, "PackageHosts")).then(() => true, () => false), false);
    } finally { await f.cleanup(); }
});

test("cancelled project serialization removes only its staging output", async () => {
    const f = await fixture();
    try {
        const base = f.runner.run;
        const abort = new AbortController();
        f.runner.run = async (command, options) => {
            const result = await base(command, options);
            if (command.command === "/usr/bin/plutil") abort.abort();
            return result;
        };
        await assert.rejects(preparePackageHost(f.request, "/Xcode", f.runner, abort.signal, () => {}), { name: "AbortError" });
        assert.deepEqual(await fs.readdir(path.join(f.options.storagePath, "PackageHosts")), []);
        assert.equal(await fs.readFile(f.source, "utf8"), "private struct Content {}\n");
    } finally { await f.cleanup(); }
});
