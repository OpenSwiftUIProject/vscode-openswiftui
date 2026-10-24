import * as path from "node:path";
import { PreviewDefinition, PreviewPlatform } from "./types";

export const configurationPath = ".vscode/openswiftui-previews.json";

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value)) {
        throw new Error(`${label} must be a nonempty string without control characters.`);
    }
    return value;
}

function strings(value: unknown, label: string): string[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
    return value.map((item, index) => string(item, `${label}[${index}]`));
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) throw new Error(`Unknown ${label} property: ${key}.`);
    }
}

export function parseConfiguration(text: string, folder: string): PreviewDefinition[] {
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch (error) { throw new Error(`Invalid preview JSON: ${String(error)}`); }
    const config = object(parsed, "Configuration");
    keys(config, ["$schema", "version", "previews"], "configuration");
    if (config.version !== 1) throw new Error("Preview configuration version must be 1.");
    if (!Array.isArray(config.previews)) throw new Error("previews must be an array.");
    const ids = new Set<string>();
    const expand = (value: string) => value.replaceAll("${workspaceFolder}", folder);
    const resolve = (value: unknown, label: string) => path.resolve(folder, expand(string(value, label)));

    return config.previews.map((value, index) => {
        const label = `previews[${index}]`;
        const item = object(value, label);
        keys(item, ["id", "name", "previewID", "project", "workspace", "scheme", "configuration", "target", "platforms", "arguments", "environment", "buildArguments", "developerDirectory"], label);
        const id = string(item.id, `${label}.id`);
        if (ids.has(id)) throw new Error(`Duplicate preview ID: ${id}.`);
        ids.add(id);
        if ((item.project === undefined) === (item.workspace === undefined)) {
            throw new Error(`${label} must specify exactly one of project or workspace.`);
        }
        const project = item.project === undefined ? undefined : resolve(item.project, `${label}.project`);
        const workspace = item.workspace === undefined ? undefined : resolve(item.workspace, `${label}.workspace`);
        if (project && !project.endsWith(".xcodeproj")) throw new Error(`${label}.project must end with .xcodeproj.`);
        if (workspace && !workspace.endsWith(".xcworkspace")) throw new Error(`${label}.workspace must end with .xcworkspace.`);
        const platforms = strings(item.platforms ?? ["macos", "ios-simulator"], `${label}.platforms`);
        if (!platforms.length || platforms.some(value => value !== "macos" && value !== "ios-simulator")) {
            throw new Error(`${label}.platforms must contain macos or ios-simulator.`);
        }
        const environment: Record<string, string> = {};
        for (const [name, value] of Object.entries(object(item.environment ?? {}, `${label}.environment`))) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.startsWith("OPENSWIFTUI_PREVIEW_")) {
                throw new Error(`${label}.environment contains an invalid or reserved name: ${name}.`);
            }
            if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label}.environment.${name} must be a string without NUL characters.`);
            environment[name] = expand(value);
        }
        const buildArguments = strings(item.buildArguments ?? [], `${label}.buildArguments`).map(expand);
        const arguments_ = strings(item.arguments ?? [], `${label}.arguments`).map(expand);
        if (arguments_.includes("--openswiftui-list-previews")) throw new Error(`${label}.arguments contains a reserved host protocol flag.`);
        const reserved = /^(CONFIGURATION_BUILD_DIR|TARGET_BUILD_DIR|BUILT_PRODUCTS_DIR|SYMROOT|OBJROOT|DSTROOT|CONFIGURATION|SDKROOT|PRODUCT_BUNDLE_IDENTIFIER|EXECUTABLE_PATH|FULL_PRODUCT_NAME)=/;
        if (buildArguments.some(value => !/^[A-Z_][A-Z0-9_]*=/.test(value) || reserved.test(value))) {
            throw new Error(`${label}.buildArguments must be KEY=VALUE build settings and must not override the destination, product identity, or build directories.`);
        }
        return {
            id,
            name: string(item.name ?? id, `${label}.name`),
            previewID: item.previewID === undefined ? undefined : string(item.previewID, `${label}.previewID`),
            folder,
            project,
            workspace,
            scheme: string(item.scheme, `${label}.scheme`),
            configuration: string(item.configuration ?? "Debug", `${label}.configuration`),
            target: item.target === undefined ? undefined : string(item.target, `${label}.target`),
            platforms: [...new Set(platforms)] as PreviewPlatform[],
            arguments: arguments_,
            environment,
            buildArguments,
            developerDirectory: item.developerDirectory === undefined ? undefined : resolve(item.developerDirectory, `${label}.developerDirectory`),
        };
    });
}

export const starterConfiguration = {
    version: 1,
    previews: [],
};
