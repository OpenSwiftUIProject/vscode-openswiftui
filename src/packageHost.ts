import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createProcessRunner, ProcessRunner, throwIfCancelled } from "./process";
import type { ProjectResolutionOptions } from "./projects";
import { PackagePreviewOrigin, PreviewDefinition, PreviewPlatform, PreviewRequest, SourcePreview } from "./types";

const hostName = "OpenSwiftUIPreviewHost";
const canonical = (file: string) => fs.realpath(file).catch(() => path.resolve(file));
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }

async function describePackage(packagePath: string, storagePath: string, developerDirectory: string | undefined,
    runner: ProcessRunner, signal: AbortSignal, log: (message: string) => void): Promise<Record<string, unknown>> {
    throwIfCancelled(signal);
    const scratch = path.join(storagePath, "PackageMetadata", digest(packagePath));
    await fs.mkdir(scratch, { recursive: true });
    const result = await runner.run({ command: "/usr/bin/xcrun", args: ["swift", "package", "--package-path", packagePath,
        "--scratch-path", scratch, "describe", "--type", "json"],
        env: developerDirectory ? { DEVELOPER_DIR: developerDirectory } : undefined,
    }, { signal, onOutput: (stream, text) => { if (stream === "stderr") log(text); } });
    throwIfCancelled(signal);
    const metadata = record(JSON.parse(result.stdout));
    if (!Array.isArray(metadata.targets) || !Array.isArray(metadata.products)) throw new Error(`SwiftPM returned invalid package metadata for ${packagePath}.`);
    return metadata;
}

function libraryProducts(metadata: Record<string, unknown>, target: Record<string, unknown>): Record<string, unknown>[] {
    return records(metadata.products).filter(product => Array.isArray(record(product.type).library) && typeof product.name === "string" &&
        (strings(product.targets).includes(String(target.name)) || strings(target.product_memberships).includes(product.name)));
}

async function ownsSource(packagePath: string, target: Record<string, unknown>, sourcePath: string, signal: AbortSignal): Promise<boolean> {
    if (typeof target.path !== "string") return false;
    for (const file of strings(target.sources)) {
        throwIfCancelled(signal);
        if (await canonical(path.resolve(packagePath, target.path, file)) === sourcePath) return true;
    }
    return false;
}

export async function resolvePackagePreviewTargets(source: SourcePreview, packagePaths: string[], options: ProjectResolutionOptions): Promise<PreviewDefinition[]> {
    const runner = options.runner ?? createProcessRunner();
    const sourcePath = await canonical(source.filePath);
    const results: PreviewDefinition[] = [];
    const errors: string[] = [];
    for (const input of packagePaths) {
        throwIfCancelled(options.signal);
        const packagePath = await canonical(input);
        const metadata = await describePackage(packagePath, options.storagePath, options.developerDirectory, runner, options.signal, options.log);
        for (const target of records(metadata.targets)) {
            if (typeof target.path !== "string" || typeof target.name !== "string") continue;
            if (!await ownsSource(packagePath, target, sourcePath, options.signal)) continue;
            if (target.type !== "library" || target.module_type !== "SwiftTarget") {
                errors.push(`${target.name} is not a Swift library target.`); continue;
            }
            const products = libraryProducts(metadata, target);
            if (!products.length) { errors.push(`${target.name} has no exported library product that the Preview app can link.`); continue; }
            // SwiftPM platform declarations set deployment minimums; omitted platforms remain eligible.
            const platforms: PreviewPlatform[] = ["macos", "ios-simulator"];
            if (typeof target.c99name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target.c99name)) {
                errors.push(`SwiftPM did not report a valid module name for ${target.name}.`); continue;
            }
            for (const product of products) {
                const productName = product.name as string;
                results.push({
                    id: JSON.stringify(["package", packagePath, target.name, productName]),
                    name: target.name === productName ? target.name : `${target.name} (${productName})`, folder: packagePath,
                    scheme: hostName, target: hostName, configuration: "Debug", platforms,
                    arguments: [], environment: {}, buildArguments: [], developerDirectory: options.developerDirectory,
                    origin: { kind: "package", packagePath, targetName: target.name, productName, moduleName: target.c99name },
                });
            }
        }
    }
    throwIfCancelled(options.signal);
    if (results.length) return results.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    throw new Error(errors[0] ?? "The selected source is not a member of a Swift library target in the package metadata.");
}

export function packageBundleIdentifier(origin: PackagePreviewOrigin): string {
    return `org.openswiftuiproject.openswiftui.preview.${digest(JSON.stringify([origin.packagePath, origin.targetName, origin.productName]))}`;
}

export function packageHostModuleName(origin: PackagePreviewOrigin): string {
    return origin.moduleName === hostName ? `${hostName}App` : hostName;
}

function mainSource(moduleName: string): string {
    return `import Foundation
import \`${moduleName}\`

#if OPENSWIFTUI_PREVIEW_EXECUTE
@_silgen_name("openswiftui_preview_main")
@MainActor
private func runPreview(_ argc: Int32, _ argv: UnsafeMutablePointer<UnsafeMutablePointer<Int8>?>?) -> Int32
#endif

@main
@MainActor
private enum PackagePreviewEntry {
    static func main() {
        #if OPENSWIFTUI_PREVIEW_EXECUTE
        _ = runPreview(CommandLine.argc, CommandLine.unsafeArgv)
        #endif
    }
}
`;
}

function deploymentVersion(metadata: Record<string, unknown>, name: string, minimum: string): string {
    const value = records(metadata.platforms).find(item => item.name === name)?.version;
    if (typeof value !== "string" || !/^\d+(?:\.\d+){0,2}$/.test(value)) return minimum;
    const actual = value.split(".").map(Number), floor = minimum.split(".").map(Number);
    for (let index = 0; index < Math.max(actual.length, floor.length); ++index) {
        if ((actual[index] ?? 0) > (floor[index] ?? 0)) return value;
        if ((actual[index] ?? 0) < (floor[index] ?? 0)) return minimum;
    }
    return value;
}

function projectDocument(origin: PackagePreviewOrigin, metadata: Record<string, unknown>) {
    const id = (name: string) => digest(`package-host:${name}`).toUpperCase();
    const objects: Record<string, Record<string, unknown>> = {};
    function add(name: string, isa: string, values: Record<string, unknown>) { objects[id(name)] = { isa, ...values }; }
    add("project", "PBXProject", { buildConfigurationList: id("projectConfigs"), compatibilityVersion: "Xcode 14.0", developmentRegion: "en",
        mainGroup: id("root"), productRefGroup: id("products"), projectDirPath: "", projectRoot: "", targets: [id("app")], packageReferences: [id("package")] });
    add("root", "PBXGroup", { sourceTree: "<group>", children: [id("main"), id("products")] });
    add("products", "PBXGroup", { name: "Products", sourceTree: "<group>", children: [id("product")] });
    add("app", "PBXNativeTarget", { buildConfigurationList: id("appConfigs"), buildPhases: [id("sources"), id("frameworks")], buildRules: [], dependencies: [],
        name: hostName, productName: hostName, productReference: id("product"), productType: "com.apple.product-type.application", packageProductDependencies: [id("packageProduct")] });
    add("product", "PBXFileReference", { explicitFileType: "wrapper.application", includeInIndex: 0, path: `${hostName}.app`, sourceTree: "BUILT_PRODUCTS_DIR" });
    add("main", "PBXFileReference", { lastKnownFileType: "sourcecode.swift", path: "Main.swift", sourceTree: "<group>" });
    add("mainBuild", "PBXBuildFile", { fileRef: id("main") });
    add("sources", "PBXSourcesBuildPhase", { buildActionMask: 2147483647, files: [id("mainBuild")], runOnlyForDeploymentPostprocessing: 0 });
    add("frameworks", "PBXFrameworksBuildPhase", { buildActionMask: 2147483647, files: [id("packageBuild")], runOnlyForDeploymentPostprocessing: 0 });
    // The original package owns target settings, local dependencies, macros, resources, and binary products.
    add("package", "XCLocalSwiftPackageReference", { relativePath: origin.packagePath });
    add("packageProduct", "XCSwiftPackageProductDependency", { package: id("package"), productName: origin.productName });
    add("packageBuild", "PBXBuildFile", { productRef: id("packageProduct") });
    for (const scope of ["project", "app"]) add(`${scope}Configs`, "XCConfigurationList", {
        buildConfigurations: [id(`${scope}Debug`)], defaultConfigurationIsVisible: 0, defaultConfigurationName: "Debug" });
    add("projectDebug", "XCBuildConfiguration", { name: "Debug", buildSettings: { SWIFT_VERSION: "6.0", SWIFT_OPTIMIZATION_LEVEL: "-Onone", CLANG_ENABLE_MODULES: "YES" } });
    add("appDebug", "XCBuildConfiguration", { name: "Debug", buildSettings: {
        PRODUCT_BUNDLE_IDENTIFIER: packageBundleIdentifier(origin), PRODUCT_NAME: hostName, PRODUCT_MODULE_NAME: packageHostModuleName(origin),
        GENERATE_INFOPLIST_FILE: "YES", SUPPORTED_PLATFORMS: "macosx iphonesimulator iphoneos",
        MACOSX_DEPLOYMENT_TARGET: deploymentVersion(metadata, "macos", "14.0"), IPHONEOS_DEPLOYMENT_TARGET: deploymentVersion(metadata, "ios", "17.0"),
        CODE_SIGNING_ALLOWED: "NO", ENABLE_DEBUG_DYLIB: "NO", ONLY_ACTIVE_ARCH: "YES", TARGETED_DEVICE_FAMILY: "1,2",
        LD_RUNPATH_SEARCH_PATHS: "$(inherited) @executable_path/../Frameworks @executable_path/Frameworks",
    } });
    return { archiveVersion: "1", objectVersion: "56", classes: {}, objects, rootObject: id("project") };
}

async function optionalFile(file: string): Promise<string | undefined> {
    try { return await fs.readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function preparePackageHost(request: PreviewRequest, developerDirectory: string, runner: ProcessRunner,
    signal: AbortSignal, log: (message: string) => void): Promise<PreviewDefinition> {
    throwIfCancelled(signal);
    const { preview } = request;
    const origin = preview.origin;
    if (origin?.kind !== "package") throw new Error("A package host requires a Swift package origin.");
    const metadata = await describePackage(origin.packagePath, request.storagePath, developerDirectory, runner, signal, log);
    const target = records(metadata.targets).find(item => item.name === origin.targetName);
    if (!target || target.type !== "library" || target.module_type !== "SwiftTarget" || target.c99name !== origin.moduleName ||
        !libraryProducts(metadata, target).some(item => item.name === origin.productName)) {
        throw new Error("The selected Swift package target or product changed. Run Preview again to resolve it.");
    }
    if (request.sourcePreview && !await ownsSource(origin.packagePath, target, await canonical(request.sourcePreview.filePath), signal)) {
        throw new Error("The selected source is no longer a member of the Swift package target. Run Preview again to resolve it.");
    }
    const manifests: Record<string, string> = {};
    for (const entry of (await fs.readdir(origin.packagePath)).sort()) {
        if (/^Package(?:@swift-[\d.]+)?\.swift$/.test(entry)) manifests[entry] = await fs.readFile(path.join(origin.packagePath, entry), "utf8");
    }
    const lock = await optionalFile(path.join(origin.packagePath, "Package.resolved"));
    const document = projectDocument(origin, metadata);
    const main = mainSource(origin.moduleName);
    const key = digest(JSON.stringify({ document, main, manifests, lock }));
    const cache = path.join(request.storagePath, "PackageHosts");
    const finalDirectory = path.join(cache, key);
    const finalProject = path.join(finalDirectory, `${hostName}.xcodeproj`);
    throwIfCancelled(signal);
    await fs.mkdir(cache, { recursive: true });
    const staging = await fs.mkdtemp(path.join(cache, "preparing-"));
    try {
        const project = path.join(staging, `${hostName}.xcodeproj`);
        await fs.mkdir(path.join(project, "xcshareddata/xcschemes"), { recursive: true });
        await fs.writeFile(path.join(staging, "Main.swift"), main);
        const json = path.join(staging, "project.json");
        await fs.writeFile(json, JSON.stringify(document));
        await runner.run({ command: "/usr/bin/plutil", args: ["-convert", "xml1", "-o", path.join(project, "project.pbxproj"), json] }, { signal });
        await fs.unlink(json);
        const appID = digest("package-host:app").toUpperCase();
        await fs.writeFile(path.join(project, "xcshareddata/xcschemes", `${hostName}.xcscheme`),
            `<Scheme version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForRunning="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${appID}" BuildableName="${hostName}.app" BlueprintName="${hostName}" ReferencedContainer="container:${hostName}.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction><LaunchAction buildConfiguration="Debug"/></Scheme>`);
        const workspace = path.join(project, "project.xcworkspace");
        await fs.mkdir(workspace, { recursive: true });
        await fs.writeFile(path.join(workspace, "contents.xcworkspacedata"), '<Workspace version="1.0"><FileRef location="self:"/></Workspace>');
        if (lock !== undefined) {
            const destination = path.join(workspace, "xcshareddata/swiftpm/Package.resolved");
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, lock);
        }
        throwIfCancelled(signal);
        try { await fs.rename(staging, finalDirectory); }
        catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        throwIfCancelled(signal);
        log(`Prepared a Preview app for package target ${origin.targetName}.\n`);
        return { ...preview, project: finalProject, workspace: undefined, target: hostName, scheme: hostName, configuration: "Debug",
            buildArguments: [...preview.buildArguments, ...(lock !== undefined && !preview.buildArguments.includes("-onlyUsePackageVersionsFromResolvedFile") ? ["-onlyUsePackageVersionsFromResolvedFile"] : [])] };
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
