import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTests } from "@vscode/test-electron";

interface InstalledExtension {
    id: string;
    version: string;
    directory: string;
    dependencies: string[];
}

async function linkSwiftExtensions(destination: string): Promise<void> {
    const source = process.env.VSCODE_EXTENSIONS_PATH ?? path.join(os.homedir(), ".vscode", "extensions");
    const installed = new Map<string, InstalledExtension>();
    for (const entry of await readdir(source, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
            continue;
        }
        const directory = path.join(source, entry.name);
        let manifest: Record<string, unknown>;
        try {
            manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
        } catch {
            continue;
        }
        if (typeof manifest.publisher !== "string" || typeof manifest.name !== "string" || typeof manifest.version !== "string") {
            continue;
        }
        const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
        const previous = installed.get(id);
        if (previous && previous.version.localeCompare(manifest.version, undefined, { numeric: true }) >= 0) {
            continue;
        }
        installed.set(id, {
            id,
            version: manifest.version,
            directory,
            dependencies: Array.isArray(manifest.extensionDependencies)
                ? manifest.extensionDependencies.filter((value): value is string => typeof value === "string")
                : [],
        });
    }

    const linked = new Set<string>();
    async function link(id: string): Promise<void> {
        id = id.toLowerCase();
        if (linked.has(id)) {
            return;
        }
        const extension = installed.get(id);
        if (!extension) {
            throw new Error(`Smoke tests require an installed ${id} extension. Set VSCODE_EXTENSIONS_PATH to the extensions directory.`);
        }
        linked.add(id);
        await symlink(extension.directory, path.join(destination, `${id}-${extension.version}`), process.platform === "win32" ? "junction" : "dir");
        for (const dependency of extension.dependencies) {
            await link(dependency);
        }
    }
    await link("swiftlang.swift-vscode");
}

async function main(): Promise<void> {
    const executable = process.env.VSCODE_EXECUTABLE_PATH;
    if (executable) {
        if (!path.isAbsolute(executable)) {
            throw new Error("VSCODE_EXECUTABLE_PATH must be an absolute path to the VS Code executable.");
        }
        await access(executable);
    }

    // VS Code uses Unix sockets below this directory; macOS limits their path length.
    const temporaryRoot = process.platform === "darwin" ? "/tmp" : os.tmpdir();
    const directory = await mkdtemp(path.join(temporaryRoot, "osui-vsc-"));
    try {
        const workspace = path.join(directory, "workspace");
        const extensions = path.join(directory, "extensions");
        await mkdir(path.join(workspace, ".vscode"), { recursive: true });
        await mkdir(extensions);
        await writeFile(path.join(workspace, ".vscode", "settings.json"), JSON.stringify({
            "swift.backgroundCompilation": false,
        }));
        await writeFile(path.join(workspace, "Preview.swift"), [
            "import OpenSwiftUI", "", '#Preview("First source preview") { Text("First") }', "",
            '#Preview("Second source preview") { Text("Second") }', "",
        ].join("\n"));
        await linkSwiftExtensions(extensions);
        await runTests({
            vscodeExecutablePath: executable,
            extensionDevelopmentPath: path.resolve(__dirname, "../.."),
            extensionTestsPath: path.join(__dirname, "extensionSmoke.js"),
            reuseMachineInstall: false,
            launchArgs: [
                workspace,
                "--user-data-dir", path.join(directory, "user-data"),
                "--extensions-dir", extensions,
                "--disable-telemetry",
                "--disable-updates",
                "--skip-welcome",
                "--skip-release-notes",
            ],
            extensionTestsEnv: { OPENSWIFTUI_SMOKE_WORKSPACE: workspace },
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
