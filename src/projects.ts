import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createProcessRunner, ProcessRunner, throwIfCancelled } from "./process";
import { PreviewDefinition, PreviewPlatform, SourcePreview } from "./types";
import { resolvePackagePreviewTargets } from "./packageHost";

export interface PBXObject { isa: string; [key: string]: unknown }
export interface XcodeProjectModel {
    projectPath: string;
    sourceRoot: string;
    rootObject: string;
    objects: Record<string, PBXObject>;
    document: Record<string, unknown>;
}
export interface ProjectSource { filePath: string; platforms?: PreviewPlatform[] }
export interface ProjectResolutionOptions {
    developerDirectory?: string;
    storagePath: string;
    signal: AbortSignal;
    log(message: string): void;
    runner?: ProcessRunner;
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
const canonical = (file: string) => fs.realpath(file).catch(() => path.resolve(file));
function contains(folder: string, file: string): boolean {
    const relative = path.relative(folder, file);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function entries(directory: string) {
    try { return await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export async function readXcodeProject(projectPath: string, signal: AbortSignal, runner: ProcessRunner = createProcessRunner()): Promise<XcodeProjectModel> {
    throwIfCancelled(signal);
    projectPath = await canonical(projectPath);
    const result = await runner.run({ command: "/usr/bin/plutil", args: ["-convert", "json", "-o", "-", path.join(projectPath, "project.pbxproj")] }, { signal });
    const document = record(JSON.parse(result.stdout));
    const objects = record(document.objects) as Record<string, PBXObject>;
    const rootObject = document.rootObject;
    if (typeof rootObject !== "string" || objects[rootObject]?.isa !== "PBXProject" ||
        Object.values(objects).some(value => !value || typeof value.isa !== "string")) {
        throw new Error(`Invalid Xcode project: ${projectPath}.`);
    }
    const projectDirectory = objects[rootObject]!.projectDirPath;
    const sourceRoot = path.resolve(path.dirname(projectPath), typeof projectDirectory === "string" ? projectDirectory : "");
    return { projectPath, sourceRoot, rootObject, objects, document };
}

/** Resolve source paths without interpreting display names as group directories. */
export function resolveProjectFiles(model: XcodeProjectModel): Map<string, string> {
    const result = new Map<string, string>();
    const parents = new Map<string, string>();
    for (const [id, object] of Object.entries(model.objects)) {
        for (const child of strings(object.children)) parents.set(child, id);
    }
    const visiting = new Set<string>();
    function resolve(id: string): string | undefined {
        if (result.has(id)) return result.get(id);
        const object = model.objects[id];
        if (!object || visiting.has(id)) return undefined;
        visiting.add(id);
        let file = typeof object.path === "string" ? object.path
            : object.isa === "PBXFileReference" && typeof object.name === "string" ? object.name : "";
        file = file.replace(/\$\((?:SRCROOT|SOURCE_ROOT|PROJECT_DIR)\)|\$\{(?:SRCROOT|SOURCE_ROOT|PROJECT_DIR)\}/g, model.sourceRoot);
        let base: string | undefined;
        if (path.isAbsolute(file) || object.sourceTree === "<absolute>") base = "/";
        else if (object.sourceTree === "SOURCE_ROOT" || object.sourceTree === "PROJECT_DIR") base = model.sourceRoot;
        else if (object.sourceTree === undefined || object.sourceTree === "<group>") base = parents.has(id) ? resolve(parents.get(id)!) : model.sourceRoot;
        visiting.delete(id);
        if (base === undefined || /\$[({]/.test(file)) return undefined;
        const absolute = path.resolve(base, file);
        result.set(id, absolute);
        return absolute;
    }
    for (const [id, object] of Object.entries(model.objects)) {
        if (["PBXGroup", "PBXFileReference", "PBXVariantGroup", "XCVersionGroup", "PBXFileSystemSynchronizedRootGroup"].includes(object.isa)) resolve(id);
    }
    return result;
}

function platformFilters(value: unknown): PreviewPlatform[] | undefined {
    const filters = typeof value === "string" ? [value] : strings(value);
    if (!filters.length) return undefined;
    return [
        ...(filters.includes("macos") ? ["macos" as const] : []),
        ...(filters.includes("ios") ? ["ios-simulator" as const] : []),
    ];
}
const sourceExtensions = new Set([".swift", ".m", ".mm", ".c", ".cc", ".cpp", ".cxx", ".s", ".metal"]);

export async function targetSources(model: XcodeProjectModel, targetID: string, signal?: AbortSignal): Promise<ProjectSource[]> {
    const target = model.objects[targetID];
    if (!target) throw new Error(`The Xcode target ${targetID} no longer exists.`);
    const paths = resolveProjectFiles(model);
    const sources: ProjectSource[] = [];
    const phases = strings(target.buildPhases).filter(id => model.objects[id]?.isa === "PBXSourcesBuildPhase");
    for (const phase of phases) {
        for (const id of strings(model.objects[phase]!.files)) {
            const build = model.objects[id];
            const filePath = typeof build?.fileRef === "string" ? paths.get(build.fileRef) : undefined;
            if (!filePath) continue;
            const platforms = platformFilters(build.platformFilters ?? build.platformFilter);
            if (platforms?.length === 0) continue;
            sources.push({ filePath, ...(platforms ? { platforms } : {}) });
        }
    }
    for (const groupID of strings(target.fileSystemSynchronizedGroups)) {
        if (signal) throwIfCancelled(signal);
        const group = model.objects[groupID];
        const directory = paths.get(groupID);
        if (!group || !directory) throw new Error(`Cannot resolve synchronized source folder ${groupID}.`);
        const exclusions: string[] = [];
        const filters: Record<string, unknown> = {};
        for (const exceptionID of strings(group.exceptions)) {
            const exception = model.objects[exceptionID];
            if (exception?.target === targetID || typeof exception?.buildPhase === "string" && phases.includes(exception.buildPhase)) {
                exclusions.push(...strings(exception.membershipExceptions));
                Object.assign(filters, record(exception.platformFiltersByRelativePath));
            }
        }
        let count = 0;
        async function visit(folder: string): Promise<void> {
            if (signal) throwIfCancelled(signal);
            if (++count > 10000) throw new Error(`Synchronized source folder is too large: ${directory}.`);
            for (const entry of await entries(folder)) {
                const filePath = path.join(folder, entry.name);
                const relative = path.relative(directory!, filePath).split(path.sep).join("/");
                if (entry.name.startsWith(".") || exclusions.some(excluded => relative === excluded || relative.startsWith(`${excluded}/`))) continue;
                if (entry.isDirectory()) { await visit(filePath); continue; }
                if (!entry.isFile() && !entry.isSymbolicLink() || !sourceExtensions.has(path.extname(entry.name).toLowerCase())) continue;
                const platforms = platformFilters(filters[relative]);
                if (platforms?.length === 0) continue;
                sources.push({ filePath, ...(platforms ? { platforms } : {}) });
            }
        }
        await visit(directory);
    }
    return sources;
}

interface XMLTag { name: string; closing: boolean; empty: boolean; attributes: Record<string, string> }
function xmlTags(xml: string): XMLTag[] {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("External entities are not supported in Xcode workspace or scheme files.");
    const decode = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_match, entity: string) => {
        if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
        if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10));
        return ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" } as Record<string, string>)[entity]!;
    });
    const tags: XMLTag[] = [];
    for (const match of xml.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<\s*(\/?)([A-Za-z][\w:-]*)((?:[^"'>]|"[^"]*"|'[^']*')*)>/g)) {
        const attributes: Record<string, string> = {};
        for (const attribute of match[3]!.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[attribute[1]!] = decode(attribute[2] ?? attribute[3]!);
        tags.push({ name: match[2]!, closing: !!match[1], empty: /\/\s*$/.test(match[3]!), attributes });
    }
    return tags;
}
function locationPath(location: string, groupDirectory: string, containerDirectory: string): string {
    const colon = location.indexOf(":");
    const kind = colon < 0 ? "group" : location.slice(0, colon);
    const value = colon < 0 ? location : location.slice(colon + 1);
    if (kind === "absolute") return path.resolve("/", value);
    if (kind === "container") return path.resolve(containerDirectory, value);
    if (kind === "group") return path.resolve(groupDirectory, value);
    throw new Error(`Unsupported Xcode workspace reference: ${location}.`);
}

export async function readWorkspaceProjects(workspacePath: string, signal: AbortSignal): Promise<string[]> {
    const projects = new Set<string>();
    const visited = new Set<string>();
    async function read(workspace: string): Promise<void> {
        throwIfCancelled(signal);
        workspace = await canonical(workspace);
        if (visited.has(workspace)) return;
        visited.add(workspace);
        const container = path.dirname(workspace);
        const stack = [container];
        const xml = await fs.readFile(path.join(workspace, "contents.xcworkspacedata"), "utf8");
        for (const tag of xmlTags(xml)) {
            if (tag.name === "Group") {
                if (tag.closing) { if (stack.length > 1) stack.pop(); }
                else if (!tag.empty) stack.push(locationPath(tag.attributes.location ?? "group:", stack.at(-1)!, container));
            } else if (tag.name === "FileRef" && !tag.closing && tag.attributes.location) {
                const file = await canonical(locationPath(tag.attributes.location, stack.at(-1)!, container));
                if (file.endsWith(".xcodeproj")) projects.add(file);
                else if (file.endsWith(".xcworkspace")) await read(file);
            }
        }
    }
    await read(workspacePath);
    return [...projects];
}

const skippedDirectories = new Set([".git", ".build", ".swiftpm", "build", "Build", "Derived", "DerivedData", "node_modules", "Pods", "Carthage", "SourcePackages", "Frameworks", ".test-output"]);
async function containers(source: string, folders: readonly string[], signal: AbortSignal): Promise<{ projects: string[]; workspaces: string[]; packages: string[] }> {
    const projects = new Set<string>();
    const workspaces = new Set<string>();
    const visited = new Set<string>();
    const packages = new Set<string>();
    let count = 0;
    async function visit(folder: string, depth: number): Promise<void> {
        throwIfCancelled(signal);
        folder = await canonical(folder);
        if (visited.has(folder)) return;
        visited.add(folder);
        if (++count > 5000) throw new Error("Automatic project discovery reached its folder limit. Open the owning project folder as a workspace.");
        for (const entry of await entries(folder)) {
            const file = path.join(folder, entry.name);
            if (entry.name === "Package.swift" && contains(folder, source)) packages.add(folder);
            if (!entry.isDirectory()) continue;
            if (entry.name.endsWith(".xcodeproj")) projects.add(await canonical(file));
            else if (entry.name.endsWith(".xcworkspace")) workspaces.add(await canonical(file));
            else if (depth > 0 && !entry.name.startsWith(".") && !skippedDirectories.has(entry.name)) await visit(file, depth - 1);
        }
    }
    const roots = await Promise.all(folders.map(canonical));
    const owners = roots.filter(folder => contains(folder, source)).sort((a, b) => b.length - a.length);
    if (!owners.length) throw new Error("Open the folder containing the selected Swift file before running Preview.");
    // Inspect every ancestor of the selected file, including paths deeper than the bounded workspace walk.
    for (let directory = path.dirname(source); contains(owners[0]!, directory); directory = path.dirname(directory)) {
        await visit(directory, 0);
        if (directory === owners[0]) break;
    }
    // Revisit ancestor directories with traversal enabled; files are deduplicated separately.
    visited.clear();
    for (const folder of [owners[0]!, ...roots.filter(folder => folder !== owners[0])]) await visit(folder, 6);
    return { projects: [...projects], workspaces: [...workspaces], packages: [...packages] };
}

interface Scheme { name: string; configuration?: string; container: string; workspaceOwned?: boolean; references: Array<{ targetID: string; projectPath: string }> }
async function readSchemes(container: string): Promise<Scheme[]> {
    const directories = [path.join(container, "xcshareddata/xcschemes")];
    for (const entry of await entries(path.join(container, "xcuserdata"))) {
        if (entry.isDirectory()) directories.push(path.join(container, "xcuserdata", entry.name, "xcschemes"));
    }
    const schemes: Scheme[] = [];
    for (const directory of directories) {
        for (const entry of await entries(directory)) {
            if (!entry.isFile() || !entry.name.endsWith(".xcscheme")) continue;
            const tags = xmlTags(await fs.readFile(path.join(directory, entry.name), "utf8"));
            const references: Scheme["references"] = [];
            let running = false;
            let configuration: string | undefined;
            for (const tag of tags) {
                if (tag.name === "BuildActionEntry") running = !tag.closing && tag.attributes.buildForRunning !== "NO";
                if (tag.name === "LaunchAction" && !tag.closing) configuration = tag.attributes.buildConfiguration;
                if (tag.name === "BuildableReference" && !tag.closing && running && tag.attributes.BlueprintIdentifier && tag.attributes.ReferencedContainer) {
                    references.push({ targetID: tag.attributes.BlueprintIdentifier, projectPath: await canonical(locationPath(tag.attributes.ReferencedContainer, path.dirname(container), path.dirname(container))) });
                }
            }
            schemes.push({ name: path.basename(entry.name, ".xcscheme"), configuration, container, workspaceOwned: container.endsWith(".xcworkspace"), references });
        }
    }
    return schemes;
}

function runningTargetCount(scheme: Scheme): number {
    return new Set(scheme.references.map(reference => JSON.stringify([reference.projectPath, reference.targetID]))).size;
}

function configurationName(model: XcodeProjectModel, target: PBXObject): string {
    const list = typeof target.buildConfigurationList === "string" ? model.objects[target.buildConfigurationList] : undefined;
    const names = strings(list?.buildConfigurations).map(id => model.objects[id]?.name).filter((name): name is string => typeof name === "string");
    return names.includes("Debug") ? "Debug" : typeof list?.defaultConfigurationName === "string" ? list.defaultConfigurationName : names[0] ?? "Debug";
}

export async function resolvePreviewTargets(source: SourcePreview, folders: readonly string[], options: ProjectResolutionOptions): Promise<PreviewDefinition[]> {
    const { signal, log } = options;
    throwIfCancelled(signal);
    const runner = options.runner ?? createProcessRunner();
    log(`Detecting the app target for ${path.basename(source.filePath)}…\n`);
    const sourcePath = await canonical(source.filePath);
    // Keep a workspace-local symlink visible to discovery; membership still uses its canonical destination.
    const visibleSource = path.join(await canonical(path.dirname(source.filePath)), path.basename(source.filePath));
    const found = await containers(visibleSource, folders, signal);
    const workspaces = new Map<string, string[]>();
    const projectPaths = new Set(found.projects);
    for (const workspace of found.workspaces) {
        try {
            const projects = await readWorkspaceProjects(workspace, signal);
            workspaces.set(workspace, projects);
            for (const project of projects) projectPaths.add(project);
        } catch (error) { throwIfCancelled(signal); log(`Could not inspect ${workspace}: ${String(error)}\n`); }
    }
    const results: PreviewDefinition[] = [];
    const unsupported: string[] = [];
    const failures: string[] = [];
    const env = options.developerDirectory ? { DEVELOPER_DIR: options.developerDirectory } : undefined;
    for (const projectPath of projectPaths) {
        throwIfCancelled(signal);
        let model: XcodeProjectModel;
        try { model = await readXcodeProject(projectPath, signal, runner); }
        catch (error) { throwIfCancelled(signal); log(`Could not inspect ${projectPath}: ${String(error)}\n`); continue; }
        for (const targetID of strings(model.objects[model.rootObject]!.targets)) {
            throwIfCancelled(signal);
            const target = model.objects[targetID];
            if (target?.isa !== "PBXNativeTarget") continue;
            const sources = await targetSources(model, targetID, signal);
            const matched: ProjectSource[] = [];
            for (const file of sources) if (await canonical(file.filePath) === sourcePath) matched.push(file);
            if (!matched.length) continue;
            const name = typeof target.name === "string" ? target.name : targetID;
            if (target.productType !== "com.apple.product-type.application") { unsupported.push(name); continue; }
            const memberPlatforms = matched.some(file => !file.platforms) ? undefined : [...new Set(matched.flatMap(file => file.platforms!))];
            const containing = [...workspaces].filter(([, projects]) => projects.includes(projectPath)).map(([workspace]) => workspace);
            const schemes = (await Promise.all([...containing, projectPath].map(readSchemes))).flat()
                .filter(scheme => scheme.references.some(reference => reference.targetID === targetID && reference.projectPath === projectPath));
            // Project-owned schemes are also visible through a containing workspace. Keep that
            // context so Xcode can resolve implicit dependencies in sibling projects.
            let selected = containing.length ? [
                ...schemes.filter(scheme => scheme.container.endsWith(".xcworkspace")),
                ...schemes.filter(scheme => scheme.container === projectPath)
                    .flatMap(scheme => containing.map(workspace => ({ ...scheme, container: workspace }))),
            ] : schemes;
            if (!selected.length) {
                for (const container of containing.length ? containing : [projectPath]) {
                    const workspace = container.endsWith(".xcworkspace");
                    log(`Reading schemes in ${path.basename(container)}…\n`);
                    const listing = await runner.run({ command: "/usr/bin/xcrun", args: ["xcodebuild", workspace ? "-workspace" : "-project", container,
                        "-clonedSourcePackagesDirPath", path.join(options.storagePath, "SourcePackages"), "-skipPackageUpdates", "-list", "-json"], env }, { signal });
                    const listed = strings(record(record(JSON.parse(listing.stdout))[workspace ? "workspace" : "project"]).schemes);
                    // Autogenerated schemes have no XML. Verify their target below instead of assuming the name matches.
                    selected.push(...listed.map(name => ({ name, container, references: [] })));
                }
            }
            const unique = new Map<string, Scheme>();
            for (const scheme of selected) {
                const key = JSON.stringify([scheme.container, scheme.name]);
                if (!unique.has(key)) unique.set(key, scheme);
            }
            const defaultConfiguration = configurationName(model, target);
            const preferred = [...unique.values()].sort((a, b) =>
                Number(b.name === name) - Number(a.name === name) ||
                Number((b.configuration ?? defaultConfiguration) === defaultConfiguration) - Number((a.configuration ?? defaultConfiguration) === defaultConfiguration) ||
                runningTargetCount(a) - runningTargetCount(b) ||
                Number(!!b.workspaceOwned) - Number(!!a.workspaceOwned) || a.name.localeCompare(b.name));
            const resolvedContexts = new Set<string>();
            for (const scheme of preferred) {
                throwIfCancelled(signal);
                if (resolvedContexts.has(scheme.container)) continue;
                const configuration = scheme.configuration ?? defaultConfiguration;
                const workspace = scheme.container.endsWith(".xcworkspace") ? scheme.container : undefined;
                const containerArgs = workspace ? ["-workspace", workspace] : ["-project", projectPath];
                const hash = createHash("sha256").update(JSON.stringify([scheme.container, scheme.name, configuration])).digest("hex").slice(0, 20);
                try {
                    log(`Resolving ${name} with scheme ${scheme.name} in ${path.basename(scheme.container)}…\n`);
                    const settings = await runner.run({ command: "/usr/bin/xcrun", args: ["xcodebuild", ...containerArgs, "-scheme", scheme.name,
                        "-configuration", configuration, "-derivedDataPath", path.join(options.storagePath, "ProjectMetadata", hash),
                        "-clonedSourcePackagesDirPath", path.join(options.storagePath, "SourcePackages"),
                        "-skipPackageUpdates", "-showBuildSettings", "-json"], env, cwd: model.sourceRoot }, { signal });
                    const rows: unknown = JSON.parse(settings.stdout);
                    if (!Array.isArray(rows)) throw new Error("Xcode returned invalid target build settings.");
                    const matching = [];
                    for (const row of rows) {
                        const value = record(row), build = record(value.buildSettings);
                        if (value.target !== name || build.PRODUCT_TYPE !== "com.apple.product-type.application") continue;
                        if (typeof build.PROJECT_FILE_PATH === "string" && await canonical(build.PROJECT_FILE_PATH) !== projectPath) continue;
                        matching.push(build);
                    }
                    if (matching.length !== 1) continue;
                    const settingsPlatforms = String(matching[0]!.SUPPORTED_PLATFORMS ?? "").split(/\s+/);
                    let platforms: PreviewPlatform[] = [
                        ...(settingsPlatforms.includes("macosx") ? ["macos" as const] : []),
                        ...(settingsPlatforms.includes("iphonesimulator") ? ["ios-simulator" as const] : []),
                    ];
                    if (memberPlatforms) platforms = platforms.filter(platform => memberPlatforms.includes(platform));
                    if (!platforms.length) { failures.push(`${name} does not compile this source for macOS or iOS Simulator.`); continue; }
                    resolvedContexts.add(scheme.container);
                    results.push({
                        id: JSON.stringify(["automatic", projectPath, targetID, scheme.container, scheme.name]),
                        name: name === scheme.name ? name : `${name} (${scheme.name})`, folder: model.sourceRoot,
                        ...(workspace ? { workspace } : { project: projectPath }), scheme: scheme.name, target: name, configuration,
                        platforms, arguments: [], environment: {}, buildArguments: [], developerDirectory: options.developerDirectory,
                        origin: { kind: "automatic", projectPath, targetID, ...(workspace ? { workspacePath: workspace } : {}) },
                    });
                } catch (error) { throwIfCancelled(signal); failures.push(`${name} / ${scheme.name}: ${String(error)}`); }
            }
        }
    }
    throwIfCancelled(signal);
    if (results.length) return results.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (found.packages.length) return resolvePackagePreviewTargets(source, found.packages, { ...options, runner });
    if (failures.length) throw new Error(`Could not resolve the owning Preview app target. ${failures[0]}`);
    if (unsupported.length) throw new Error(`The selected source belongs to a library, framework, or non-app target (${unsupported.join(", ")}). Automatic Preview currently requires source membership in an Xcode app target.`);
    throw new Error("No owning application target was found for the selected Swift file. Open its Xcode project folder and check source target membership and scheme availability.");
}
