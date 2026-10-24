import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createProcessRunner, ProcessRunner, throwIfCancelled } from "./process";
import { discoverSourcePreviews } from "./sourcePreviews";
import { SourcePreview } from "./types";

export interface ExpandedSourceOptions {
    source: SourcePreview;
    expansionOutput: string;
    moduleName: string;
    developerDirectory: string;
    storagePath: string;
    signal: AbortSignal;
    log(message: string): void;
    appendHost?: boolean;
}

/** Adapt actual compiler expansions in a cached copy of the selected source. */
export async function prepareExpandedSources(options: ExpandedSourceOptions): Promise<string> {
    const { source, moduleName, developerDirectory, storagePath, signal, log } = options;
    throwIfCancelled(signal);
    if (!path.isAbsolute(source.filePath)) throw new Error("Compiled Preview source must use an absolute file path.");
    if (!moduleName || /[\/\r\n]/.test(moduleName)) throw new Error("The compiled Preview module name is invalid.");
    if (Buffer.byteLength(options.expansionOutput) > 64 * 1024 * 1024) throw new Error("Compiler expansion output exceeds 64 MiB. Use a narrower build target.");
    const contents = await fs.readFile(source.filePath, "utf8");
    const previews = await discoverSourcePreviews(contents, source.filePath, developerDirectory, storagePath, signal, log);
    const runner = createProcessRunner();
    const helper = await prepareHelper(developerDirectory, storagePath, runner, signal, log);
    const input = JSON.stringify({ sourceText: contents, filePath: source.filePath, moduleName,
        expansionOutput: options.expansionOutput, previews, selected: source });
    const captureKey = createHash("sha256").update(input).digest("hex").slice(0, 24);
    const captures = path.join(storagePath, "PreviewExpansions", captureKey);
    await fs.mkdir(captures, { recursive: true });
    const temporary = await fs.mkdtemp(path.join(captures, "preparing-"));
    let transformed: string;
    try {
        const inputFile = path.join(temporary, "input.json");
        await fs.writeFile(inputFile, input, { mode: 0o600 });
        await fs.writeFile(path.join(captures, "expansions.txt"), options.expansionOutput, { mode: 0o600 });
        throwIfCancelled(signal);
        const result = await runner.run({ command: helper, args: [inputFile], env: { DEVELOPER_DIR: developerDirectory } }, { signal });
        let output: unknown;
        try { output = JSON.parse(result.stdout); } catch { throw new Error("The compiler expansion parser returned invalid JSON."); }
        if (!output || typeof output !== "object" || !("source" in output) || typeof output.source !== "string") {
            throw new Error("The compiler expansion parser returned invalid source.");
        }
        transformed = output.source;
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }

    if (options.appendHost) {
        const templates = path.resolve(__dirname, "../../templates/NativeHost");
        const hosts = await Promise.all(["PreviewRegistry.swift", "PreviewSession.swift", "PreviewApp.swift"]
            .map(filename => fs.readFile(path.join(templates, filename), "utf8")));
        transformed += "\n#sourceLocation()\n" + hosts.join("\n");
    }
    const paths = [...new Set([source.filePath, await fs.realpath(source.filePath)])];
    const key = createHash("sha256").update(JSON.stringify(paths)).update(transformed).digest("hex").slice(0, 24);
    const cache = path.join(storagePath, "ExpandedSources");
    const directory = path.join(cache, key);
    const overlayPath = path.join(directory, "overlay.json");
    const annotatedPath = path.join(directory, "Source.swift");
    throwIfCancelled(signal);
    try {
        await fs.access(overlayPath); await fs.access(annotatedPath);
        return overlayPath;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await fs.mkdir(cache, { recursive: true });
    const staging = await fs.mkdtemp(path.join(cache, "preparing-"));
    try {
        await fs.writeFile(path.join(staging, "Source.swift"), transformed, { mode: 0o600 });
        await fs.writeFile(path.join(staging, "overlay.json"), JSON.stringify({
            version: 0, "use-external-names": false,
            roots: paths.map(name => ({ type: "file", name, "external-contents": annotatedPath })),
        }), { mode: 0o600 });
        throwIfCancelled(signal);
        try { await fs.rename(staging, directory); }
        catch (error) {
            if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            await fs.access(overlayPath); await fs.access(annotatedPath);
        }
        throwIfCancelled(signal);
        return overlayPath;
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

async function prepareHelper(developerDirectory: string, storagePath: string, runner: ProcessRunner,
    signal: AbortSignal, log: (message: string) => void): Promise<string> {
    const env = { DEVELOPER_DIR: developerDirectory };
    const compiler = (await runner.run({ command: "/usr/bin/xcrun", args: ["--find", "swiftc"], env }, { signal })).stdout.trim();
    const sdk = (await runner.run({ command: "/usr/bin/xcrun", args: ["--sdk", "macosx", "--show-sdk-path"], env }, { signal })).stdout.trim();
    if (!path.isAbsolute(compiler) || !path.isAbsolute(sdk)) throw new Error("Xcode did not return a Swift compiler and macOS SDK.");
    const version = (await runner.run({ command: compiler, args: ["--version"], env }, { signal })).stdout;
    const source = path.resolve(__dirname, "../../tools/PreviewExpansion/PreviewExpansion.swift");
    const key = createHash("sha256").update(compiler).update(version).update(sdk).update(process.arch).update(await fs.readFile(source)).digest("hex").slice(0, 24);
    const directory = path.join(storagePath, "PreviewExpansionTools", key);
    const executable = path.join(directory, "PreviewExpansion");
    throwIfCancelled(signal);
    try { if ((await fs.stat(executable)).isFile()) return executable; } catch { /* Compile a missing helper. */ }
    const host = path.resolve(path.dirname(compiler), "../lib/swift/host");
    await fs.mkdir(directory, { recursive: true });
    const staging = await fs.mkdtemp(path.join(directory, "build-"));
    try {
        log("Compiling the Swift compiler expansion adapter…\n");
        const output = path.join(staging, "PreviewExpansion");
        await runner.run({ command: compiler, args: ["-parse-as-library", "-sdk", sdk,
            "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`,
            "-I", host, "-L", host, "-Xlinker", "-rpath", "-Xlinker", host,
            "-module-cache-path", path.join(staging, "ModuleCache"), source, "-o", output], env },
        { signal, onOutput: (_stream, text) => log(text) });
        throwIfCancelled(signal);
        await fs.rename(output, executable);
        return executable;
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
