import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfiguration, starterConfiguration } from "../src/config";

const valid = { version: 1, previews: [{ id: "tap", project: "Host.xcodeproj", scheme: "Host" }] };

test("resolves a preview against its own workspace folder", () => {
    const [preview] = parseConfiguration(JSON.stringify(valid), "/projects/one");
    assert.equal(preview.project, "/projects/one/Host.xcodeproj");
    assert.equal(preview.folder, "/projects/one");
    assert.equal(preview.previewID, undefined);
    assert.equal(preview.configuration, "Debug");
    assert.deepEqual(preview.platforms, ["macos", "ios-simulator"]);
});

test("rejects ambiguous project selection and duplicate IDs", () => {
    const item = valid.previews[0];
    assert.throws(() => parseConfiguration(JSON.stringify({ version: 1, previews: [{ ...item, workspace: "Host.xcworkspace" }] }), "/p"), /exactly one/);
    assert.throws(() => parseConfiguration(JSON.stringify({ version: 1, previews: [item, item] }), "/p"), /Duplicate/);
});

test("rejects unsupported platforms, versions, unsafe build overrides and host protocol variables", () => {
    for (const patch of [
        { platforms: ["linux"] },
        { platforms: [] },
        { buildArguments: ["-destination", "platform=macOS"] },
        { buildArguments: ["CONFIGURATION_BUILD_DIR=/tmp/other"] },
        { environment: { OPENSWIFTUI_PREVIEW_SESSION: "fake" } },
        { arguments: [42] },
        { arguments: ["--openswiftui-list-previews"] },
        { scheme: "" },
    ]) {
        assert.throws(() => parseConfiguration(JSON.stringify({ version: 1, previews: [{ ...valid.previews[0], ...patch }] }), "/p"));
    }
    assert.throws(() => parseConfiguration(JSON.stringify({ ...valid, version: 2 }), "/p"), /version/);
});

test("expands workspaceFolder in arguments and environment without shell expansion", () => {
    const config = { version: 1, previews: [{ ...valid.previews[0], arguments: ["${workspaceFolder}/a b", "$(touch nope)"], environment: { FIXTURES: "${workspaceFolder}/fixtures" }, buildArguments: ["CODE_SIGNING_ALLOWED=NO"] }] };
    const [preview] = parseConfiguration(JSON.stringify(config), "/work dir");
    assert.deepEqual(preview.arguments, ["/work dir/a b", "$(touch nope)"]);
    assert.equal(preview.environment.FIXTURES, "/work dir/fixtures");
});

test("reports malformed JSON and invalid paths", () => {
    assert.throws(() => parseConfiguration("{", "/p"), /Invalid preview JSON/);
    assert.throws(() => parseConfiguration(JSON.stringify({ version: 1, previews: [{ ...valid.previews[0], project: "Host.swift" }] }), "/p"), /xcodeproj/);
});

test("the starter is an empty set of optional project overrides", () => {
    assert.deepEqual(parseConfiguration(JSON.stringify(starterConfiguration), "/project"), []);
    assert.deepEqual(starterConfiguration, { version: 1, previews: [] });
});
