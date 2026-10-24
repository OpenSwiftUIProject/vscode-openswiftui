import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createPreviewController } from "../src/controller";
import { resolvePreviewTargets } from "../src/projects";
import { discoverSourcePreviews } from "../src/sourcePreviews";
import { Destination, PreviewCase } from "../src/types";

/** Opt-in integration test: builds and launches an unchanged app or package. */
async function main(): Promise<void> {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: { simulator: { type: "string" }, storage: { type: "string" } },
    });
    if (positionals.length !== 2) {
        throw new Error("Usage: npm run test:automatic -- <folder> <Swift source> [--simulator <UDID>] [--storage <directory>]");
    }
    const folder = path.resolve(positionals[0]!);
    const filePath = path.resolve(folder, positionals[1]!);
    const storagePath = path.resolve(values.storage ?? path.join(".test-output", "Automatic Integration"));
    await mkdir(storagePath, { recursive: true });
    const source = await readFile(filePath, "utf8");
    const configurationPath = path.join(folder, ".vscode", "openswiftui-previews.json");
    const configuration = await readFile(configurationPath, "utf8").catch(() => undefined);
    assert.equal(configuration, undefined, "Use a project without a manual preview configuration.");
    const log = (text: string) => process.stdout.write(text);
    const signal = new AbortController().signal;
    const previews = await discoverSourcePreviews(source, filePath, process.env.DEVELOPER_DIR, storagePath, signal, log);
    assert.ok(previews.length > 0, "The test source must contain a preview declaration.");
    const targets = await resolvePreviewTargets(previews[0]!, [folder], {
        developerDirectory: process.env.DEVELOPER_DIR, storagePath, signal, log,
    });
    assert.equal(targets.length, 1, "Use a fixture with one owning target.");
    const target = targets[0]!;
    assert.ok(target.origin, "The fixture must use automatic project or package discovery.");
    const projectFile = target.origin.kind === "package"
        ? path.join(target.origin.packagePath, "Package.swift")
        : path.join(target.origin.projectPath, "project.pbxproj");
    const hash = async () => createHash("sha256").update(await readFile(projectFile)).digest("hex");
    const projectHash = await hash();
    const lockfile = target.origin.kind === "package"
        ? path.join(target.origin.packagePath, "Package.resolved")
        : target.origin.workspacePath
            ? path.join(target.origin.workspacePath, "xcshareddata/swiftpm/Package.resolved")
            : path.join(target.origin.projectPath, "project.xcworkspace/xcshareddata/swiftpm/Package.resolved");
    const lockContents = await readFile(lockfile, "utf8").catch(() => undefined);
    const destinations: Destination[] = values.simulator
        ? [{ platform: "ios-simulator", name: values.simulator, udid: values.simulator }]
        : [{ platform: "macos", name: "This Mac" }];
    let compiled: PreviewCase[] = [];
    const controller = createPreviewController({
        log,
        onStatus(status) { log(`\nINTEGRATION_STATE:${status.state}\n`); },
        onPreviews(previews) { compiled = previews; },
        async selectPreview(previews) { return previews[0]; },
    });
    try {
        for (const destination of destinations) {
            for (const preview of previews) {
                await controller.run({ preview: target, destination, storagePath, sourcePreview: preview });
                assert.equal(controller.status.state, "running");
                assert.equal(controller.status.request?.sourcePreview?.line, preview.line);
                assert.ok(controller.status.request?.previewID);
                const firstID = controller.status.request?.previewID;
                const children = compiled.filter(item => item.filePath === preview.filePath &&
                    item.line === preview.line && item.column === preview.column);
                await controller.stop();
                assert.equal(controller.status.state, "idle");
                for (const child of children) {
                    log(`INTEGRATION_CASE:${JSON.stringify(child)}\n`);
                    if (child.id === firstID) continue;
                    await controller.run({ preview: target, destination, storagePath, sourcePreview: preview, previewID: child.id });
                    assert.equal(controller.status.state, "running");
                    assert.equal(controller.status.request?.previewID, child.id);
                    await controller.stop();
                    assert.equal(controller.status.state, "idle");
                }
            }
        }
    } finally {
        await controller.dispose();
        assert.equal(await readFile(filePath, "utf8"), source, "Preview must preserve the original Swift file.");
        assert.equal(await hash(), projectHash, "Preview must preserve the original project or package manifest.");
        assert.equal(await readFile(lockfile, "utf8").catch(() => undefined), lockContents,
            "Preview must preserve the project's dependency lockfile.");
        assert.equal(await readFile(configurationPath, "utf8").catch(() => undefined), configuration,
            "Automatic preview must not write user configuration.");
    }
    log(`\nAutomatic preview integration passed: ${previews.length} declaration(s), original source/project unchanged.\n`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
