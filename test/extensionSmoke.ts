import assert from "node:assert/strict";
import path from "node:path";
import * as vscode from "vscode";
import type { PreviewDefinition, PreviewStatus, SourcePreview } from "../src/types";

interface PreviewExtensionAPI {
    getStatus(): PreviewStatus;
    getPreviews(): PreviewDefinition[];
    getSourcePreviews(): SourcePreview[];
}

async function waitUntil(condition: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 60000;
    while (!condition() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(condition(), message);
}

/** This suite checks extension integration. It never builds or starts a host. */
export async function run(): Promise<void> {
    const workspace = process.env.OPENSWIFTUI_SMOKE_WORKSPACE;
    assert.ok(workspace, "The isolated smoke-test workspace is required.");
    assert.equal(vscode.env.remoteName, undefined, "Smoke tests must use the local extension host.");
    assert.equal(vscode.workspace.isTrusted, true, "This suite only covers trusted workspaces.");
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders);
    assert.equal(folders.length, 1);
    assert.equal(folders[0].uri.fsPath, workspace);
    const configurationURI = vscode.Uri.file(path.join(workspace, ".vscode", "openswiftui-previews.json"));
    const assertNoConfiguration = () => assert.rejects(async () => vscode.workspace.fs.stat(configurationURI),
        (error: unknown) => error instanceof vscode.FileSystemError && error.code === "FileNotFound",
        "Source discovery must not create a preview configuration file.");
    await assertNoConfiguration();

    const extension = vscode.extensions.getExtension<PreviewExtensionAPI>("OpenSwiftUIProject.openswiftui-preview");
    assert.ok(extension, "The preview extension was not loaded.");
    const api = await extension.activate();
    assert.equal(extension.isActive, true);
    assert.equal(api.getStatus().state, "idle");

    const commands = await vscode.commands.getCommands(true);
    for (const command of ["run", "rebuild", "stop", "configure", "logs"]) {
        assert.ok(commands.includes(`openswiftui.preview.${command}`), `Missing ${command} command.`);
    }
    assert.ok(vscode.extensions.getExtension("swiftlang.swift-vscode"), "The Swift extension dependency was not loaded.");
    const contributions = extension.packageJSON.contributes;
    assert.ok(contributions.viewsContainers.activitybar.some((container: { id: string }) => container.id === "openswiftui-preview"),
        "Preview must have its own Activity Bar entry.");
    assert.ok(contributions.views["openswiftui-preview"].some((view: { id: string }) => view.id === "openswiftui.previews"));

    assert.deepEqual(api.getPreviews(), [], "No manual target configuration should be needed at startup.");

    const sourceURI = vscode.Uri.file(path.join(workspace, "Preview.swift"));
    const document = await vscode.workspace.openTextDocument(sourceURI);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("workbench.view.extension.openswiftui-preview");
    await waitUntil(() => api.getSourcePreviews().length === 2, "Source previews did not appear without configuration.");
    assert.deepEqual(api.getSourcePreviews().map(preview => preview.name), ["First source preview", "Second source preview"],
        "The current file must expose both source previews without an app build.");
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", sourceURI);
    const previewLenses = lenses?.filter(lens => lens.command?.command === "openswiftui.preview.run") ?? [];
    assert.equal(previewLenses.length, 2, "Each source declaration must have a Run Preview CodeLens.");
    assert.deepEqual(previewLenses.map(lens => lens.range.start.line), [2, 4]);
    assert.equal(api.getStatus().state, "idle", "Listing source previews must not build or start a host.");
    await assertNoConfiguration();

    const additionalSource = [
        "", "#Preview { UnnamedView() }", "",
        'struct UnnamedView: View { var body: some View { Text("Unnamed") } }',
        'struct LegacyView: View { var body: some View { Text("Legacy") } }',
        "struct LegacyPreviews: PreviewProvider {",
        '    static var previews: some View { LegacyView().previewDisplayName("Legacy named") }',
        "}", "",
    ].join("\n");
    const edit = new vscode.WorkspaceEdit();
    edit.insert(sourceURI, document.positionAt(document.getText().length), additionalSource);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await document.save();
    await waitUntil(() => api.getSourcePreviews().length === 4, "Both macro and provider declarations must appear in the current-file panel.");
    const additionalPreviews = api.getSourcePreviews().slice(2);
    assert.deepEqual(additionalPreviews.map(preview => preview.kind), ["macro", "provider"]);
    assert.deepEqual(additionalPreviews.map(preview => preview.name ?? preview.typeName), ["UnnamedView", "Legacy named"]);
    assert.equal(additionalPreviews[1].providerType, "LegacyPreviews");
    const allLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", sourceURI);
    assert.equal(allLenses?.filter(lens => lens.command?.command === "openswiftui.preview.run").length, 4);
    await assertNoConfiguration();

    // Explicit overrides remain optional and must be reloaded when the user changes them.
    await vscode.workspace.fs.writeFile(configurationURI, Buffer.from(JSON.stringify({
        version: 1,
        previews: [{ id: "override", name: "Optional Override", project: "Host.xcodeproj", scheme: "Host", platforms: ["macos"] }],
    })));
    await waitUntil(() => api.getPreviews()[0]?.id === "override", "The configuration watcher did not load the optional override.");
    assert.equal(api.getPreviews()[0].project, path.join(workspace, "Host.xcodeproj"));
    assert.equal(api.getPreviews()[0].scheme, "Host");
    await vscode.workspace.fs.delete(configurationURI);
    await waitUntil(() => api.getPreviews().length === 0 && api.getSourcePreviews().length === 4,
        "Removing the optional override must restore source discovery without a configuration.");
    await assertNoConfiguration();

    await vscode.commands.executeCommand("openswiftui.preview.stop");
    assert.equal(api.getStatus().state, "idle", "Stopping an idle preview must remain safe.");
    console.log("OpenSwiftUI extension smoke tests passed: dedicated Activity Bar, zero-config macro/provider discovery, explicit and view-type names, four CodeLens, no implicit configuration writes, optional override watcher, and idle Stop.");
}
