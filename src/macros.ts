import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ProcessRunner, throwIfCancelled } from "./process";

export async function preparePreviewMacros(
    developerDirectory: string, storagePath: string, runner: ProcessRunner,
    signal: AbortSignal, log: (message: string) => void,
): Promise<string> {
    const env = { DEVELOPER_DIR: developerDirectory };
    const compiler = (await runner.run({ command: "/usr/bin/xcrun", args: ["--find", "swiftc"], env }, { signal })).stdout.trim();
    if (!path.isAbsolute(compiler)) { throw new Error("Xcode did not return a Swift compiler path."); }
    const version = (await runner.run({ command: compiler, args: ["--version"], env }, { signal })).stdout;
    const sdk = (await runner.run({ command: "/usr/bin/xcrun", args: ["--sdk", "macosx", "--show-sdk-path"], env }, { signal })).stdout.trim();
    if (!path.isAbsolute(sdk)) { throw new Error("Xcode did not return a macOS SDK path."); }
    const source = path.resolve(__dirname, "../../tools/PreviewMacros/PreviewMacro.swift");
    const contents = await fs.readFile(source);
    const key = createHash("sha256").update(compiler).update(version).update(sdk).update(process.arch).update(contents).digest("hex").slice(0, 24);
    const directory = path.join(storagePath, "PreviewMacros", key);
    const library = path.join(directory, "libOpenSwiftUIPreviewMacros.dylib");
    throwIfCancelled(signal);
    try { if ((await fs.stat(library)).isFile()) { return library; } } catch { /* Build the missing plugin. */ }

    const host = path.resolve(path.dirname(compiler), "../lib/swift/host");
    try { await fs.access(path.join(host, "libSwiftSyntax.dylib")); }
    catch { throw new Error("The selected Xcode must include host SwiftSyntax libraries to compile #Preview support."); }
    await fs.mkdir(directory, { recursive: true });
    const temporary = await fs.mkdtemp(path.join(directory, "build-"));
    try {
        log("Compiling the #Preview macro plugin for the selected Xcode…\n");
        const output = path.join(temporary, path.basename(library));
        await runner.run({
            command: compiler,
            args: ["-emit-library", "-parse-as-library", "-module-name", "OpenSwiftUIPreviewMacros",
                "-sdk", sdk, "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`,
                "-I", host, "-L", host, "-Xlinker", "-rpath", "-Xlinker", host,
                source, "-o", output],
            env,
        }, { signal, onOutput: (_stream, text) => log(text) });
        throwIfCancelled(signal);
        await fs.rename(output, library);
        return library;
    } finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}
