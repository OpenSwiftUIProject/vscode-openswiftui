import assert from "node:assert/strict";
import { test } from "node:test";
import { createPreviewController } from "../src/controller";
import { PreviewArtifact, PreviewBackend, PreviewSession, PreviewStartError } from "../src/backend";
import { ProcessExit } from "../src/process";
import { PreviewRequest, PreviewStatus } from "../src/types";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const request: PreviewRequest = {
    preview: {
        id: "sample", name: "Sample", previewID: "counter", folder: "/project",
        project: "/project/Preview.xcodeproj", scheme: "Preview", configuration: "Debug",
        platforms: ["macos"], arguments: [], environment: {}, buildArguments: [],
    },
    destination: { platform: "macos", name: "My Mac" }, storagePath: "/storage",
};
const artifact: PreviewArtifact = {
    appPath: "/build/Preview.app", executablePath: "/build/Preview.app/Contents/MacOS/Preview",
    bundleIdentifier: "org.openswiftuiproject.openswiftui.preview", developerDirectory: "/Xcode/Contents/Developer",
};

const defaultCase = { id: "counter", name: "Counter", fileID: "Module/Content.swift", line: 1, column: 1 };

function session() {
    const exit = deferred<ProcessExit>();
    let stops = 0;
    const value: PreviewSession = {
        exited: exit.promise,
        async stop() { stops++; exit.resolve({ code: 0, signal: null }); },
    };
    return { value, exit, get stops() { return stops; } };
}

test("a failed build keeps the previous interactive session running", async () => {
    const host = session();
    let fail = false;
    const backend: PreviewBackend = {
        async discover() { return [defaultCase]; },
        async build() { if (fail) { throw new Error("Compile failed"); } return artifact; },
        async start() { return host.value; },
    };
    const controller = createPreviewController({ log() {}, onStatus() {} }, backend);
    await controller.run(request);
    fail = true;
    await assert.rejects(controller.run(request), /Compile failed/);
    assert.equal(host.stops, 0);
    assert.equal(controller.status.state, "running");
    await controller.dispose();
});

test("a superseded build never launches and a newer run waits for its cleanup", async () => {
    const firstBuild = deferred<PreviewArtifact>();
    const entered = deferred<void>();
    let builds = 0;
    let starts = 0;
    let firstSignal: AbortSignal | undefined;
    const host = session();
    const backend: PreviewBackend = {
        async discover() { return [defaultCase]; },
        async build(_request, signal) {
            if (++builds === 1) { firstSignal = signal; entered.resolve(); return firstBuild.promise; }
            return artifact;
        },
        async start() { starts++; return host.value; },
    };
    const controller = createPreviewController({ log() {}, onStatus() {} }, backend);
    const first = controller.run(request);
    await entered.promise;
    const second = controller.run(request);
    assert.equal(firstSignal?.aborted, true);
    firstBuild.resolve(artifact);
    await Promise.all([first, second]);
    assert.equal(starts, 1);
    assert.equal(controller.status.state, "running");
    await controller.dispose();
});

test("Stop cancels an in-flight build and stops only the owned host", async () => {
    const host = session();
    const entered = deferred<void>();
    const build = deferred<PreviewArtifact>();
    let calls = 0;
    let signal: AbortSignal | undefined;
    let starts = 0;
    const backend: PreviewBackend = {
        async discover() { return [defaultCase]; },
        async build(_request, token) {
            if (++calls === 2) { signal = token; entered.resolve(); return build.promise; }
            return artifact;
        },
        async start() { starts++; return host.value; },
    };
    const controller = createPreviewController({ log() {}, onStatus() {} }, backend);
    await controller.run(request);
    const pending = controller.run(request);
    await entered.promise;
    const stopped = controller.stop();
    assert.equal(signal?.aborted, true);
    build.resolve(artifact);
    await Promise.all([pending, stopped]);
    assert.equal(starts, 1);
    assert.equal(host.stops, 1);
    assert.equal(controller.status.state, "idle");
});

test("an externally closed app updates status, without reacting to stale exits", async () => {
    const hosts = [session(), session()];
    const statuses: PreviewStatus[] = [];
    let index = 0;
    const backend: PreviewBackend = {
        async discover() { return [defaultCase]; },
        async build() { return artifact; },
        async start() { return hosts[index++]!.value; },
    };
    const controller = createPreviewController({ log() {}, onStatus(s) { statuses.push(s); } }, backend);
    await controller.run(request);
    await controller.run(request);
    assert.equal(controller.status.state, "running");
    hosts[1]!.exit.resolve({ code: 1, signal: null });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(controller.status.state, "failed");
    assert.match(statuses.at(-1)!.message, /exit/i);
    await controller.dispose();
});

test("a cancelled startup that returns late is stopped before it can become current", async () => {
    const entered = deferred<void>();
    const ready = deferred<PreviewSession>();
    const host = session();
    const backend: PreviewBackend = {
        async discover() { return [defaultCase]; },
        async build() { return artifact; },
        async start() { entered.resolve(); return ready.promise; },
    };
    const controller = createPreviewController({ log() {}, onStatus() {} }, backend);
    const running = controller.run(request);
    await entered.promise;
    const stopping = controller.stop();
    ready.resolve(host.value);
    await Promise.all([running, stopping]);
    assert.equal(host.stops, 1);
    assert.equal(controller.status.state, "idle");
});

test("a failed stop keeps the owned session available for retry", async () => {
    const exit = deferred<ProcessExit>();
    let stops = 0;
    const host: PreviewSession = {
        exited: exit.promise,
        async stop() {
            if (++stops === 1) { throw new Error("Termination failed"); }
            exit.resolve({ code: 0, signal: null });
        },
    };
    const backend: PreviewBackend = {
        async discover() { return [defaultCase]; }, async build() { return artifact; }, async start() { return host; } };
    const controller = createPreviewController({ log() {}, onStatus() {} }, backend);
    await controller.run(request);
    await assert.rejects(controller.stop(), /Termination failed/);
    assert.equal(controller.status.state, "running");
    await controller.stop();
    assert.equal(stops, 2);
    assert.equal(controller.status.state, "idle");
});

test("a replacement stop failure is not reported as a build failure", async () => {
    const exit = deferred<ProcessExit>();
    let stops = 0;
    const host: PreviewSession = {
        exited: exit.promise,
        async stop() {
            if (++stops === 1) { throw new Error("Termination failed"); }
            exit.resolve({ code: 0, signal: null });
        },
    };
    const backend: PreviewBackend = {
        async discover() { return [defaultCase]; }, async build() { return artifact; }, async start() { return host; } };
    const controller = createPreviewController({ log() {}, onStatus() {} }, backend);
    await controller.run(request);
    await assert.rejects(controller.run(request), /Termination failed/);
    assert.match(controller.status.message, /Could not stop/);
    assert.doesNotMatch(controller.status.message, /Build failed/);
    await controller.dispose();
});

test("startup cleanup failure retains the host for Stop to retry", async () => {
    const host = session();
    const backend: PreviewBackend = {
        async discover() { return [defaultCase]; },
        async build() { return artifact; },
        async start() { throw new PreviewStartError("Cleanup failed", host.value, new Error("Readiness timeout")); },
    };
    const controller = createPreviewController({ log() {}, onStatus() {} }, backend);
    await assert.rejects(controller.run(request), /Cleanup failed/);
    assert.equal(controller.status.state, "failed");
    await controller.stop();
    assert.equal(host.stops, 1);
    assert.equal(controller.status.state, "idle");
});

const compiledCases = [
    { id: "first", name: "First", fileID: "Module/Content.swift", line: 3, column: 1 },
    { id: "second", name: "Second", fileID: "Module/Content.swift", line: 8, column: 1 },
];

test("a provider selection publishes its children and picks only from that provider", async () => {
    const source = { kind: "provider" as const, filePath: "/project/Content.swift", line: 12, column: 1 };
    const children = ["Light", "Dark"].map((name, index) => ({
        ...source, id: `provider:${index}`, name, fileID: "Module/Content.swift",
    }));
    const all = [{ ...defaultCase, filePath: source.filePath }, ...children];
    const host = session();
    let published = false;
    let started: PreviewRequest | undefined;
    const backend: PreviewBackend = {
        async build() { return artifact; }, async discover() { return all; },
        async start(_artifact, selected) { started = selected; return host.value; },
    };
    const controller = createPreviewController({
        log() {}, onStatus() {},
        onPreviews(previews) { assert.deepEqual(previews, all); published = true; },
        async selectPreview(previews) {
            assert.equal(published, true);
            assert.deepEqual(previews, children);
            return children[1];
        },
    }, backend);
    await controller.run({ ...request, sourcePreview: source });
    assert.equal(started?.previewID, "provider:1");
    await controller.dispose();
});

test("a compiled provider row validates both its source and child ID", async () => {
    const source = { kind: "provider" as const, filePath: "/project/Content.swift", line: 12, column: 1 };
    const children = [0, 1].map(index => ({ ...source, id: `provider:${index}`, fileID: "Module/Content.swift" }));
    let starts = 0;
    const backend: PreviewBackend = {
        async build() { return artifact; },
        async discover() { return [...children, { ...defaultCase, filePath: source.filePath }]; },
        async start(_artifact, selected) {
            assert.equal(selected.previewID, "provider:1");
            starts++;
            return session().value;
        },
    };
    const controller = createPreviewController({
        log() {}, onStatus() {}, async selectPreview() { throw new Error("No picker for a compiled row."); },
    }, backend);
    await controller.run({ ...request, sourcePreview: source, previewID: "provider:1" });
    await assert.rejects(controller.run({ ...request, sourcePreview: source, previewID: defaultCase.id }), /not found|removed/i);
    assert.equal(starts, 1);
    await controller.dispose();
});

test("a source selection resolves its exact compiled file and location before launch", async () => {
    const host = session();
    let started: PreviewRequest | undefined;
    const backend: PreviewBackend = {
        async build() { return artifact; },
        async discover() {
            return [
                { ...compiledCases[1]!, id: "other", filePath: "/other/Content.swift" },
                { ...compiledCases[1]!, filePath: "/project/Content.swift" },
            ];
        },
        async start(_artifact, selected) { started = selected; return host.value; },
    };
    const controller = createPreviewController({
        log() {}, onStatus() {},
        async selectPreview() { throw new Error("An explicit source selection must not open another picker."); },
    }, backend);
    await controller.run({ ...request, sourcePreview: { filePath: "/project/Content.swift", line: 8, column: 1 } });
    assert.equal(started?.previewID, "second");
    await controller.dispose();
});

test("a source declaration omitted from the target cannot launch a same-name preview", async () => {
    let starts = 0;
    const backend: PreviewBackend = {
        async build() { return artifact; },
        async discover() { return [{ ...compiledCases[1]!, filePath: "/other/Content.swift" }]; },
        async start() { starts++; return session().value; },
    };
    const controller = createPreviewController({ log() {}, onStatus() {} }, backend);
    await assert.rejects(controller.run({
        ...request, sourcePreview: { name: "Second", filePath: "/project/Content.swift", line: 8, column: 1 },
    }), /not compiled.*selected.*target/i);
    assert.equal(starts, 0);
    await controller.dispose();
});

test("source validation rejects a different declaration kind or provider at the same position", async () => {
    const source = { kind: "provider" as const, providerType: "ExpectedProvider", filePath: "/project/Content.swift", line: 8, column: 1 };
    for (const replacement of [{ kind: "macro" as const }, { kind: "provider" as const, providerType: "OtherProvider" }]) {
        const backend: PreviewBackend = {
            async build() { return artifact; },
            async discover() { return [{ ...compiledCases[1]!, filePath: source.filePath, ...replacement }]; },
            async start() { throw new Error("A replaced declaration must not start."); },
        };
        const controller = createPreviewController({ log() {}, onStatus() {} }, backend);
        await assert.rejects(controller.run({ ...request, sourcePreview: source }), /not compiled/);
        await controller.dispose();
    }
});

test("source selection requires source path metadata from the current host template", async () => {
    const backend: PreviewBackend = {
        async build() { return artifact; },
        async discover() { return compiledCases; },
        async start() { throw new Error("Must not start a host with unverifiable source metadata."); },
    };
    const controller = createPreviewController({ log() {}, onStatus() {} }, backend);
    await assert.rejects(controller.run({
        ...request, sourcePreview: { filePath: "/project/Content.swift", line: 8, column: 1 },
    }), /update.*host.*template/i);
    await controller.dispose();
});

test("Run selects a compiled preview after discovery and records its resolved ID", async () => {
    const events: string[] = [];
    const host = session();
    let started: PreviewRequest | undefined;
    const backend = {
        async build() { events.push("build"); return artifact; },
        async discover() { events.push("discover"); return compiledCases; },
        async start(_artifact: PreviewArtifact, selected: PreviewRequest) { events.push("start"); started = selected; return host.value; },
    };
    const options = {
        log() {}, onStatus() {},
        async selectPreview() { events.push("select"); return compiledCases[1]; },
    };
    const controller = createPreviewController(options, backend);
    await controller.run({ ...request, preview: { ...request.preview, previewID: undefined } });
    assert.deepEqual(events, ["build", "discover", "select", "start"]);
    assert.equal(started?.previewID, "second");
    await controller.dispose();
});

test("a removed compiled selection fails instead of launching another preview", async () => {
    let starts = 0;
    const host = session();
    const backend = {
        async build() { return artifact; },
        async discover() { return compiledCases; },
        async start() { starts++; return host.value; },
    };
    const controller = createPreviewController({ log() {}, onStatus() {} }, backend);
    await assert.rejects(controller.run(request), /not found|removed/i);
    assert.equal(starts, 0);
    await controller.dispose();
});

test("discovery stops the previous host only after the replacement build succeeds", async () => {
    const host = session();
    let discoveries = 0;
    let starts = 0;
    const backend: PreviewBackend = {
        async build() { assert.equal(host.stops, 0); return artifact; },
        async discover() {
            if (++discoveries === 2) {
                assert.equal(host.stops, 1);
                throw new Error("Invalid compiled preview list");
            }
            return [defaultCase];
        },
        async start() { starts++; return host.value; },
    };
    const controller = createPreviewController({ log() {}, onStatus() {} }, backend);
    await controller.run(request);
    await assert.rejects(controller.run(request), /Invalid compiled preview list/);
    assert.equal(starts, 1);
    assert.equal(controller.status.state, "failed");
    await controller.dispose();
});

test("cancelling the compiled case picker leaves the preview stopped", async () => {
    let starts = 0;
    const backend: PreviewBackend = {
        async build() { return artifact; },
        async discover() { return compiledCases; },
        async start() { starts++; return session().value; },
    };
    const controller = createPreviewController({ log() {}, onStatus() {}, async selectPreview() { return undefined; } }, backend);
    await controller.run({ ...request, preview: { ...request.preview, previewID: undefined } });
    assert.equal(starts, 0);
    assert.equal(controller.status.state, "idle");
});

test("Stop cancels a pending compiled case picker and discards its late selection", async () => {
    const entered = deferred<void>();
    const selection = deferred<typeof compiledCases[number]>();
    let signal: AbortSignal | undefined;
    let starts = 0;
    const backend: PreviewBackend = {
        async build() { return artifact; },
        async discover() { return compiledCases; },
        async start() { starts++; return session().value; },
    };
    const controller = createPreviewController({
        log() {}, onStatus() {},
        async selectPreview(_previews, _request, token) { signal = token; entered.resolve(); return selection.promise; },
    }, backend);
    const running = controller.run({ ...request, preview: { ...request.preview, previewID: undefined } });
    await entered.promise;
    const stopping = controller.stop();
    assert.equal(signal?.aborted, true);
    selection.resolve(compiledCases[0]!);
    await Promise.all([running, stopping]);
    assert.equal(starts, 0);
    assert.equal(controller.status.state, "idle");
});

test("a superseded discovery never launches its returned preview cases", async () => {
    const entered = deferred<void>();
    const first = deferred<typeof compiledCases>();
    let discoveries = 0;
    let starts = 0;
    let signal: AbortSignal | undefined;
    const backend: PreviewBackend = {
        async build() { return artifact; },
        async discover(_artifact, _request, _id, token) {
            if (++discoveries === 1) { signal = token; entered.resolve(); return first.promise; }
            return compiledCases;
        },
        async start() { starts++; return session().value; },
    };
    const controller = createPreviewController({ log() {}, onStatus() {} }, backend);
    const selected = { ...request, previewID: "second" };
    const running = controller.run(selected);
    await entered.promise;
    const replacement = controller.run(selected);
    assert.equal(signal?.aborted, true);
    first.resolve(compiledCases);
    await Promise.all([running, replacement]);
    assert.equal(starts, 1);
    assert.equal(controller.status.request?.previewID, "second");
    await controller.dispose();
});
