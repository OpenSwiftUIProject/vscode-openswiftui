import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createProcessRunner, ProcessRunner, throwIfCancelled } from "./process";
import { SourcePreview } from "./types";

/** Parse the current buffer without compiling the app or evaluating conditional branches. */
export async function discoverSourcePreviews(
    source: string, filePath: string, developerDirectory: string | undefined,
    storagePath: string, signal: AbortSignal, log: (text: string) => void,
): Promise<SourcePreview[]> {
    throwIfCancelled(signal);
    const runner = createProcessRunner();
    const directory = developerDirectory ?? (await runner.run({
        command: "/usr/bin/xcode-select", args: ["-p"],
    }, { signal })).stdout.trim();
    if (!path.isAbsolute(directory)) { throw new Error("Select a full Xcode installation or set developerDirectory."); }
    const executable = await prepareParser(directory, storagePath, runner, signal, log);
    throwIfCancelled(signal);
    const temporary = await fs.mkdtemp(path.join(storagePath, "PreviewDiscovery", "source-"));
    try {
        const input = path.join(temporary, "Source.swift");
        await fs.writeFile(input, source, { encoding: "utf8", mode: 0o600 });
        throwIfCancelled(signal);
        const result = await runner.run({
            command: executable, args: [input, filePath], env: { DEVELOPER_DIR: directory },
        }, { signal });
        let previews: unknown;
        try { previews = JSON.parse(result.stdout); }
        catch { throw new Error("The Swift parser returned invalid preview metadata."); }
        if (!Array.isArray(previews) || !previews.every(value => isSourcePreview(value, filePath))) {
            throw new Error("The Swift parser returned invalid preview metadata.");
        }
        return previews;
    } finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}

function isSourcePreview(value: unknown, filePath: string): value is SourcePreview {
    if (!value || typeof value !== "object") { return false; }
    const item = value as Record<string, unknown>;
    return item.filePath === filePath && (item.name === undefined || typeof item.name === "string")
        && (item.kind === undefined || item.kind === "macro" || item.kind === "provider")
        && (item.typeName === undefined || typeof item.typeName === "string" && item.typeName.length > 0)
        && (item.providerType === undefined || typeof item.providerType === "string" && item.providerType.length > 0)
        && (item.kind !== "provider" || typeof item.providerType === "string")
        && (item.providerBodyEnd === undefined || Number.isSafeInteger(item.providerBodyEnd) && (item.providerBodyEnd as number) >= 0)
        && (item.childTypeNames === undefined || Array.isArray(item.childTypeNames) && item.childTypeNames.length > 0
            && item.childTypeNames.every(name => typeof name === "string" && name.length > 0))
        && (item.hasSourceLocation === undefined || item.hasSourceLocation === true)
        && Number.isSafeInteger(item.line) && (item.line as number) > 0
        && Number.isSafeInteger(item.column) && (item.column as number) > 0;
}

async function prepareParser(
    developerDirectory: string, storagePath: string, runner: ProcessRunner,
    signal: AbortSignal, log: (text: string) => void,
): Promise<string> {
    const env = { DEVELOPER_DIR: developerDirectory };
    const compiler = (await runner.run({ command: "/usr/bin/xcrun", args: ["--find", "swiftc"], env }, { signal })).stdout.trim();
    if (!path.isAbsolute(compiler)) { throw new Error("Xcode did not return a Swift compiler path."); }
    const version = (await runner.run({ command: compiler, args: ["--version"], env }, { signal })).stdout;
    const sdk = (await runner.run({ command: "/usr/bin/xcrun", args: ["--sdk", "macosx", "--show-sdk-path"], env }, { signal })).stdout.trim();
    if (!path.isAbsolute(sdk)) { throw new Error("Xcode did not return a macOS SDK path."); }
    const source = path.resolve(__dirname, "../../tools/PreviewDiscovery/PreviewDiscovery.swift");
    const contents = await fs.readFile(source);
    const key = createHash("sha256").update(compiler).update(version).update(sdk).update(process.arch).update(contents).digest("hex").slice(0, 24);
    const directory = path.join(storagePath, "PreviewDiscovery", key);
    const executable = path.join(directory, "PreviewDiscovery");
    throwIfCancelled(signal);
    try { if ((await fs.stat(executable)).isFile()) { return executable; } } catch { /* Compile a missing parser. */ }

    const host = path.resolve(path.dirname(compiler), "../lib/swift/host");
    try {
        await fs.access(path.join(host, "libSwiftSyntax.dylib"));
        await fs.access(path.join(host, "libSwiftParser.dylib"));
    } catch { throw new Error("The selected Xcode must include host SwiftSyntax and SwiftParser libraries to discover preview declarations."); }
    await fs.mkdir(directory, { recursive: true });
    const temporary = await fs.mkdtemp(path.join(directory, "build-"));
    try {
        log("Compiling the Swift source preview parser for the selected Xcode…\n");
        const output = path.join(temporary, path.basename(executable));
        await runner.run({
            command: compiler,
            args: ["-parse-as-library", "-sdk", sdk,
                "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`,
                "-I", host, "-L", host, "-Xlinker", "-rpath", "-Xlinker", host,
                "-module-cache-path", path.join(temporary, "ModuleCache"), source, "-o", output],
            env,
        }, { signal, onOutput: (_stream, text) => log(text) });
        throwIfCancelled(signal);
        await fs.rename(output, executable);
        return executable;
    } finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}
