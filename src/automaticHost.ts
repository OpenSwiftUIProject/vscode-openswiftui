import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ProcessRunner, throwIfCancelled } from "./process";
import { PBXObject, readWorkspaceProjects, readXcodeProject, resolveProjectFiles } from "./projects";
import { Destination, PreviewDefinition, PreviewRequest } from "./types";

const hostFiles = ["PreviewApp.swift", "PreviewMacro.swift", "PreviewRegistry.swift", "PreviewSession.swift"];
const entrySymbol = "_openswiftui_preview_main";
const lifecycleKeys = ["NSMainNibFile", "NSMainStoryboardFile", "UIMainStoryboardFile", "UILaunchStoryboardName", "UIApplicationSceneManifest"];

function digest(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function xml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function unxml(value: string): string { return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); }
function list(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function quote(value: string): string { return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }

export function automaticBundleIdentifier(origin: PreviewDefinition["origin"]): string {
    if (origin?.kind !== "automatic") throw new Error("An Xcode host requires an Xcode project origin.");
    return `org.openswiftuiproject.openswiftui.preview.${digest(`${origin.projectPath}:${origin.targetID}`)}`;
}

function appendFlags(value: unknown, flags: string[]): string | string[] {
    if (Array.isArray(value)) return [...list(value), ...flags];
    return `${typeof value === "string" ? value : "$(inherited)"} ${flags.join(" ")}`;
}

function overrideSetting(settings: Record<string, unknown>, name: string, value: unknown): void {
    for (const key of new Set([name, ...Object.keys(settings).filter(key => key.startsWith(`${name}[`))])) settings[key] = value;
}

function appendSetting(settings: Record<string, unknown>, name: string, flags: string[]): void {
    for (const key of new Set([name, ...Object.keys(settings).filter(key => key.startsWith(`${name}[`))])) settings[key] = appendFlags(settings[key], flags);
}

async function optionalFile(file: string): Promise<Buffer | undefined> {
    try { return await fs.readFile(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function writePlist(file: string, value: unknown, runner: ProcessRunner, signal: AbortSignal): Promise<void> {
    const input = `${file}.json`;
    await fs.writeFile(input, JSON.stringify(value));
    try { await runner.run({ command: "/usr/bin/plutil", args: ["-convert", "xml1", "-o", file, input] }, { signal }); }
    finally { await fs.rm(input, { force: true }); }
}

async function originalScheme(projectPath: string, workspacePath: string | undefined, scheme: string): Promise<{ text: string; base: string } | undefined> {
    if (path.basename(scheme) !== scheme) throw new Error("The selected scheme name cannot contain path separators.");
    for (const container of [workspacePath, projectPath]) {
        if (!container) continue;
        const directories = [path.join(container, "xcshareddata", "xcschemes")];
        try {
            for (const entry of await fs.readdir(path.join(container, "xcuserdata"), { withFileTypes: true })) {
                if (entry.isDirectory()) directories.push(path.join(container, "xcuserdata", entry.name, "xcschemes"));
            }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        for (const directory of directories) {
            const contents = await optionalFile(path.join(directory, `${scheme}.xcscheme`));
            if (!contents) continue;
            let text = contents.toString("utf8");
            for (const match of [...text.matchAll(/ReferencedContainer\s*=\s*"([^"]*)"/g)]) {
                const reference = unxml(match[1]);
                if (!reference.startsWith("container:")) throw new Error(`Unsupported scheme container: ${reference}`);
                const resolved = path.resolve(path.dirname(container), reference.slice("container:".length));
                const canonical = await fs.realpath(resolved).catch(() => resolved);
                text = text.replace(match[0], `ReferencedContainer="${xml(`container:${canonical}`)}"`);
            }
            return { text, base: path.dirname(container) };
        }
    }
    return undefined;
}

function schemeXML(targetID: string, targetName: string, projectPath: string, original?: { text: string; base: string }, originalProject?: string): string {
    if (original) {
        const build = original.text.match(/<BuildAction(?:\s[^>]*)?>[\s\S]*?<\/BuildAction>/)?.[0];
        if (!build || ![...build.matchAll(/BlueprintIdentifier\s*=\s*"([^"]*)"/g)].some(match => unxml(match[1]) === targetID)) {
            throw new Error("The selected scheme does not build the preview's owning target.");
        }
        return original.text.replace(/ReferencedContainer\s*=\s*"([^"]*)"/g, (_match, encoded: string) => {
            const reference = unxml(encoded);
            if (!reference.startsWith("container:")) throw new Error(`Unsupported scheme container: ${reference}`);
            const resolved = path.resolve(original.base, reference.slice("container:".length));
            return `ReferencedContainer="${xml(`container:${resolved === originalProject ? projectPath : resolved}`)}"`;
        });
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Scheme version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForRunning="YES" buildForTesting="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${xml(targetID)}" BuildableName="${xml(targetName)}.app" BlueprintName="${xml(targetName)}" ReferencedContainer="${xml(`container:${projectPath}`)}"/></BuildActionEntry></BuildActionEntries></BuildAction></Scheme>\n`;
}

/** Build an isolated project overlay; the owning source project is never changed. */
export async function prepareAutomaticHost(
    request: PreviewRequest, _developerDirectory: string, macroLibrary: string,
    runner: ProcessRunner, signal: AbortSignal, log: (s: string) => void, sourceOverlay?: string,
    compilerFlags: string[] = [],
): Promise<PreviewDefinition> {
    const { preview } = request;
    const origin = preview.origin;
    if (!origin) return preview;
    if (origin.kind !== "automatic") throw new Error("An Xcode host requires an Xcode project origin.");
    throwIfCancelled(signal);
    const model = await readXcodeProject(origin.projectPath, signal, runner);
    const document = structuredClone(model.document);
    const objects = document.objects as Record<string, PBXObject>;
    const target = objects[origin.targetID];
    if (target?.isa !== "PBXNativeTarget" || target.productType !== "com.apple.product-type.application" || typeof target.name !== "string") {
        throw new Error("Automatic Preview requires a native application target.");
    }
    const phases = list(target.buildPhases).map(id => objects[id]).filter(object => object?.isa === "PBXSourcesBuildPhase");
    if (phases.length !== 1) throw new Error("Automatic Preview requires exactly one source build phase in its application target.");
    const configurationList = objects[String(target.buildConfigurationList)];
    const configurations = list(configurationList?.buildConfigurations).map(id => objects[id]);
    if (!configurations.length || configurations.some(object => object?.isa !== "XCBuildConfiguration")) {
        throw new Error("The selected application target has no supported build configurations.");
    }
    if (preview.buildArguments.some(argument => /^(OTHER_SWIFT_FLAGS|OTHER_LDFLAGS|ENABLE_DEBUG_DYLIB|PRODUCT_BUNDLE_IDENTIFIER|CODE_SIGNING_ALLOWED|CODE_SIGN_ENTITLEMENTS)(?:\[[^\]]*\])*=/.test(argument))) {
        throw new Error("Automatic Preview cannot apply build arguments that replace its compiler, entry point, or application identity.");
    }

    for (const [id, filePath] of resolveProjectFiles(model)) {
        const object = objects[id];
        if (!object || !["PBXFileReference", "PBXGroup", "PBXVariantGroup", "XCVersionGroup", "PBXFileSystemSynchronizedRootGroup"].includes(object.isa)) continue;
        object.name ??= typeof object.path === "string" ? path.basename(object.path) : undefined;
        object.path = filePath;
        object.sourceTree = "<absolute>";
    }
    for (const object of Object.values(objects)) {
        if (object.isa === "XCLocalSwiftPackageReference") {
            if (typeof object.relativePath !== "string") throw new Error("A local package reference has no path.");
            object.relativePath = path.resolve(model.sourceRoot, object.relativePath);
        }
    }
    const project = objects[model.rootObject];
    project.projectDirPath = model.sourceRoot;

    const cache = path.join(request.storagePath, "AutomaticHosts");
    await fs.mkdir(cache, { recursive: true });
    const staging = await fs.mkdtemp(path.join(cache, "preparing-"));
    try {
        const projectName = path.basename(origin.projectPath);
        const generatedProject = path.join(staging, projectName);
        const generatedWorkspace = path.join(staging, "Preview.xcworkspace");
        const hostDirectory = path.join(staging, "NativeHost");
        await fs.mkdir(generatedProject, { recursive: true });
        await fs.mkdir(hostDirectory);
        const templates = path.resolve(__dirname, "../../templates/NativeHost");
        const contents: Record<string, string> = {};
        for (const filename of hostFiles.filter(file => macroLibrary || file !== "PreviewMacro.swift")) {
            const text = await fs.readFile(path.join(templates, filename), "utf8");
            contents[filename] = text;
            await fs.writeFile(path.join(hostDirectory, filename), text);
            const fileID = digest(`preview-file:${origin.targetID}:${filename}`).toUpperCase();
            const buildID = digest(`preview-build:${origin.targetID}:${filename}`).toUpperCase();
            if (objects[fileID] || objects[buildID]) throw new Error("A generated preview identifier conflicts with the original project.");
            objects[fileID] = { isa: "PBXFileReference", path: path.join(hostDirectory, filename), sourceTree: "<absolute>", lastKnownFileType: "sourcecode.swift" };
            objects[buildID] = { isa: "PBXBuildFile", fileRef: fileID };
            phases[0].files = [...list(phases[0].files), buildID];
            const group = objects[String(project.mainGroup)];
            group.children = [...list(group.children), fileID];
        }

        const identity = automaticBundleIdentifier(origin);
        for (const configuration of configurations) {
            const settings = (configuration.buildSettings ??= {}) as Record<string, unknown>;
            appendSetting(settings, "OTHER_SWIFT_FLAGS", ["-D", "OPENSWIFTUI_AUTOMATIC_HOST", ...compilerFlags,
                ...(macroLibrary ? ["-D", "OPENSWIFTUI_STANDALONE_PREVIEW", "-load-plugin-library", quote(macroLibrary)] : [])]);
            if (sourceOverlay) appendSetting(settings, "OTHER_SWIFT_FLAGS", ["-vfsoverlay", quote(sourceOverlay)]);
            appendSetting(settings, "OTHER_LDFLAGS", [`-Wl,-e,${entrySymbol}`]);
            overrideSetting(settings, "ENABLE_DEBUG_DYLIB", "NO");
            overrideSetting(settings, "PRODUCT_BUNDLE_IDENTIFIER", identity);
            overrideSetting(settings, "CODE_SIGNING_ALLOWED", "NO");
            overrideSetting(settings, "CODE_SIGN_ENTITLEMENTS", "");
        }

        const existingScheme = await originalScheme(origin.projectPath, origin.workspacePath, preview.scheme);
        const workspaceProjects = origin.workspacePath ? await readWorkspaceProjects(origin.workspacePath, signal) : [];
        const sharedFiles: Record<string, string> = {};
        for (const [sourceContainer, destinationContainer] of [[origin.projectPath, generatedProject], [origin.workspacePath, generatedWorkspace]]) {
            if (!sourceContainer) continue;
            const prefix = sourceContainer.endsWith(".xcodeproj") ? "project.xcworkspace/xcshareddata" : "xcshareddata";
            for (const relative of [`${prefix}/swiftpm/Package.resolved`, `${prefix}/WorkspaceSettings.xcsettings`]) {
                const contents = await optionalFile(path.join(sourceContainer, relative));
                if (contents) {
                    sharedFiles[`${sourceContainer}/${relative}`] = contents.toString("base64");
                    const destination = path.join(destinationContainer!, relative);
                    await fs.mkdir(path.dirname(destination), { recursive: true });
                    await fs.writeFile(destination, contents);
                }
            }
        }
        log(`Preparing an automatic Preview host for ${target.name}…\n`);
        const normalized = JSON.stringify(document).split(staging).join("$PREVIEW_HOST");
        const key = digest(JSON.stringify({ document: normalized, contents, scheme: existingScheme, workspaceProjects, sharedFiles, configuration: preview.configuration }));
        const finalDirectory = path.join(cache, key);
        const replacePaths = (value: unknown): unknown => {
            if (typeof value === "string") return value.split(staging).join(finalDirectory);
            if (Array.isArray(value)) return value.map(replacePaths);
            if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replacePaths(item)]));
            return value;
        };
        const finalProject = path.join(finalDirectory, projectName);
        const finalWorkspace = path.join(finalDirectory, "Preview.xcworkspace");
        await writePlist(path.join(generatedProject, "project.pbxproj"), replacePaths(document), runner, signal);
        await fs.mkdir(path.join(generatedProject, "xcshareddata", "xcschemes"), { recursive: true });
        await fs.writeFile(path.join(generatedProject, "xcshareddata", "xcschemes", `${preview.scheme}.xcscheme`), schemeXML(origin.targetID, target.name as string, finalProject, existingScheme, origin.projectPath));
        if (origin.workspacePath) {
            await fs.mkdir(generatedWorkspace, { recursive: true });
            const projects = new Set([...workspaceProjects.filter(item => item !== origin.projectPath), finalProject]);
            await fs.writeFile(path.join(generatedWorkspace, "contents.xcworkspacedata"), `<?xml version="1.0" encoding="UTF-8"?>\n<Workspace version="1.0">${[...projects].map(item => `<FileRef location="${xml(`absolute:${item}`)}"/>`).join("")}</Workspace>\n`);
        }
        throwIfCancelled(signal);
        try { await fs.rename(staging, finalDirectory); }
        catch (error) {
            if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
        return { ...preview, project: origin.workspacePath ? undefined : finalProject,
            workspace: origin.workspacePath ? finalWorkspace : undefined, target: target.name as string };
    } finally {
        await fs.rm(staging, { recursive: true, force: true });
    }
}

function topLevelPlistKeys(contents: string): string[] {
    const keys: string[] = [];
    let depth = 0;
    let root: string | undefined;
    // plutil emits canonical XML: strings and key text contain escaped markup.
    for (const match of contents.matchAll(/<(\/?)(dict|array|key)\b[^>]*>/g)) {
        const [, closing, tag] = match;
        if (tag === "key") {
            if (!closing && depth === 1) {
                const start = match.index! + match[0].length;
                const end = match[0].endsWith("/>") ? start : contents.indexOf("</key>", start);
                if (end < 0) throw new Error("The built app's Info.plist has an invalid key.");
                keys.push(contents.slice(start, end).replace(/&(#x[0-9a-f]+|#[0-9]+|amp|quot|apos|lt|gt);/gi, (_match, value: string) => {
                    if (value.startsWith("#")) return String.fromCodePoint(/^#x/i.test(value) ? parseInt(value.slice(2), 16) : parseInt(value.slice(1), 10));
                    return ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" } as Record<string, string>)[value];
                }));
            }
        } else {
            root ??= tag;
            if (closing) depth--;
            else if (!match[0].endsWith("/>")) depth++;
        }
    }
    if (root !== "dict" || depth !== 0) throw new Error("The built app's Info.plist must contain a dictionary.");
    return keys;
}

/** Replace startup metadata only after Xcode has generated and processed the app's plist. */
export async function finalizeAutomaticApp(
    appPath: string, destination: Destination, bundleIdentifier: string,
    runner: ProcessRunner, signal: AbortSignal,
): Promise<void> {
    throwIfCancelled(signal);
    const plistPath = path.join(appPath, destination.platform === "macos" ? "Contents/Info.plist" : "Info.plist");
    const temporary = await fs.mkdtemp(path.join(path.dirname(plistPath), ".openswiftui-preview-plist-"));
    try {
        const output = path.join(temporary, "Info.plist");
        const edit = (args: string[]) => runner.run({ command: "/usr/bin/plutil", args: [...args, output] }, { signal });
        await runner.run({ command: "/usr/bin/plutil", args: ["-convert", "xml1", "-o", output, plistPath] }, { signal });
        const keys = topLevelPlistKeys(await fs.readFile(output, "utf8"));
        const startupKeys = [...lifecycleKeys, "CFBundleIdentifier", "NSPrincipalClass",
            ...(destination.platform === "macos" ? ["LSUIElement", "LSBackgroundOnly"] : ["UILaunchScreen"])];
        for (const key of keys) {
            if (startupKeys.some(name => key === name || key.startsWith(`${name}~`) || key.startsWith(`${name}-`))) {
                await edit(["-remove", key.replace(/\./g, "\\.")]);
            }
        }
        await edit(["-insert", "CFBundleIdentifier", "-string", bundleIdentifier]);
        if (destination.platform === "macos") {
            await edit(["-insert", "NSPrincipalClass", "-string", "NSApplication"]);
            await edit(["-insert", "LSUIElement", "-bool", "NO"]);
            await edit(["-insert", "LSBackgroundOnly", "-bool", "NO"]);
        } else {
            await edit(["-insert", "UIApplicationSceneManifest", "-xml", "<dict><key>UIApplicationSupportsMultipleScenes</key><false/><key>UISceneConfigurations</key><dict/></dict>"]);
            await edit(["-insert", "UILaunchScreen", "-dictionary"]);
        }
        throwIfCancelled(signal);
        await fs.rename(output, plistPath);
    } finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}
