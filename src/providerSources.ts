import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { throwIfCancelled } from "./process";
import { discoverSourcePreviews } from "./sourcePreviews";
import { SourcePreview } from "./types";

function swiftString(value: string): string {
    const escaped = [...value].map(character => {
        if (character === '"' || character === "\\") return `\\${character}`;
        const code = character.codePointAt(0)!;
        return code < 0x20 || code === 0x2028 || code === 0x2029 ? `\\u{${code.toString(16)}}` : character;
    }).join("");
    return `"${escaped}"`;
}

/** Register providers through a source overlay; never edit the workspace file. */
export async function prepareProviderSources(
    source: SourcePreview | undefined, developerDirectory: string, storagePath: string,
    signal: AbortSignal, log: (text: string) => void,
): Promise<string | undefined> {
    throwIfCancelled(signal);
    if (!source) return undefined;
    if (!path.isAbsolute(source.filePath)) throw new Error("Provider source must use an absolute file path.");
    const contents = await fs.readFile(source.filePath);
    const previews = await discoverSourcePreviews(contents.toString("utf8"), source.filePath,
        developerDirectory, storagePath, signal, log);
    const providers = previews.filter(preview => preview.kind === "provider");
    throwIfCancelled(signal);
    if (!providers.length) return undefined;
    if (providers.some(provider => provider.hasSourceLocation)) {
        throw new Error("PreviewProvider registration does not support files with #sourceLocation directives. Use an unmapped Swift source file for Preview.");
    }

    let annotated = contents;
    for (const provider of providers.sort((left, right) => (right.providerBodyEnd ?? -1) - (left.providerBodyEnd ?? -1))) {
        const offset = provider.providerBodyEnd;
        if (offset === undefined || !provider.providerType || offset >= contents.length || contents[offset] !== 0x7d) {
            throw new Error(`The PreviewProvider ${provider.providerType ?? "declaration"} is incomplete. Add its closing brace before running Preview.`);
        }
        const prefix = contents.subarray(0, offset);
        const line = prefix.toString("utf8").split(/\r\n|\r|\n/).length;
        const column = offset - Math.max(prefix.lastIndexOf(0x0a), prefix.lastIndexOf(0x0d)) - 1;
        const childTypes = provider.childTypeNames ? `[${provider.childTypeNames.map(swiftString).join(", ")}]` : "nil";
        const registration = `\n#_OpenSwiftUIPreviewProvider(${provider.providerType}.self, filePath: ${swiftString(source.filePath)}, line: ${provider.line}, column: ${provider.column}, typeName: ${provider.typeName ? swiftString(provider.typeName) : "nil"}, childTypeNames: ${childTypes})\n`;
        const restore = `#sourceLocation(file: ${swiftString(source.filePath)}, line: ${line})\n${" ".repeat(column)}`;
        annotated = Buffer.concat([annotated.subarray(0, offset), Buffer.from(registration + restore), annotated.subarray(offset)]);
    }
    const paths = [...new Set([source.filePath, await fs.realpath(source.filePath)])];
    const key = createHash("sha256").update(JSON.stringify(paths)).update(annotated).digest("hex").slice(0, 24);
    const cache = path.join(storagePath, "ProviderSources");
    const directory = path.join(cache, key);
    const overlayPath = path.join(directory, "overlay.json");
    const annotatedPath = path.join(directory, "Source.swift");
    throwIfCancelled(signal);
    try {
        await fs.access(overlayPath);
        await fs.access(annotatedPath);
        throwIfCancelled(signal);
        return overlayPath;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

    await fs.mkdir(cache, { recursive: true });
    const temporary = await fs.mkdtemp(path.join(cache, "preparing-"));
    try {
        await fs.writeFile(path.join(temporary, "Source.swift"), annotated, { mode: 0o600 });
        await fs.writeFile(path.join(temporary, "overlay.json"), JSON.stringify({
            version: 0,
            "use-external-names": false,
            roots: paths.map(name => ({ type: "file", name, "external-contents": annotatedPath })),
        }), { mode: 0o600 });
        throwIfCancelled(signal);
        try { await fs.rename(temporary, directory); }
        catch (error) {
            if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            await fs.access(overlayPath);
            await fs.access(annotatedPath);
        }
        throwIfCancelled(signal);
        return overlayPath;
    } finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}
