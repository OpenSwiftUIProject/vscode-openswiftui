import assert from "node:assert/strict";
import { test } from "node:test";
import { createProcessRunner } from "../src/process";

test("process execution preserves literal arguments without a shell", async () => {
    const runner = createProcessRunner();
    const literals = ["a b", "$(echo unsafe)", "`literal`", "$HOME", "a;echo unsafe"];
    const result = await runner.run({
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...literals],
    });
    assert.deepEqual(JSON.parse(result.stdout), literals);
});

test("a failed executable reports the spawn error", async () => {
    await assert.rejects(createProcessRunner().run({ command: "/nonexistent/openswiftui-preview-test", args: [] }), /ENOENT/);
});

test("termination waits through EPERM from a process-group existence check", { skip: process.platform === "win32", timeout: 5000 }, async context => {
    const child = createProcessRunner().spawn({ command: process.execPath, args: ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"] });
    await new Promise<void>(resolve => child.onOutput(() => resolve()));
    const kill = process.kill.bind(process);
    let probed = false;
    context.mock.method(process, "kill", (pid: number, signal?: number | NodeJS.Signals) => {
        if (pid === -child.pid! && signal === 0 && !probed) {
            probed = true;
            throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        }
        return kill(pid, signal);
    });
    try {
        await child.terminate();
        assert.equal(probed, true);
        assert.equal((await child.exited).signal, "SIGTERM");
    } finally {
        if (!child.exit) { try { kill(child.pid!, "SIGKILL"); } catch {} }
        await child.exited;
    }
});

test("termination still reports permission errors when sending a stop signal", { skip: process.platform === "win32", timeout: 5000 }, async context => {
    const child = createProcessRunner().spawn({ command: process.execPath, args: ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"] });
    await new Promise<void>(resolve => child.onOutput(() => resolve()));
    const kill = process.kill.bind(process);
    context.mock.method(process, "kill", (pid: number, signal?: number | NodeJS.Signals) => {
        if (pid === -child.pid! && signal === "SIGTERM") throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        return kill(pid, signal);
    });
    try { await assert.rejects(child.terminate(), /EPERM/); }
    finally { kill(child.pid!, "SIGKILL"); await child.exited; }
});

test("a termination failure rejects the command without waiting forever for exit", { timeout: 1000 }, async () => {
    const controller = new AbortController();
    const runner = createProcessRunner(() => ({
        exit: undefined,
        exited: new Promise(() => {}),
        onOutput() { return () => {}; },
        async terminate() { throw new Error("Cannot terminate"); },
    }));
    const pending = runner.run({ command: "fake", args: [] }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /Cannot terminate/);
});

test("cancellation terminates compiler descendants, including those that ignore SIGTERM", { skip: process.platform === "win32", timeout: 8000 }, async () => {
    const runner = createProcessRunner();
    const controller = new AbortController();
    let grandchild = 0;
    const childScript = "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);";
    const parentScript = `
        const { spawn } = require('node:child_process');
        process.on('SIGTERM', () => {});
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'pipe', 'ignore'] });
        child.stdout.once('data', () => process.stdout.write(String(child.pid) + '\\n'));
        setInterval(() => {}, 1000);
    `;
    await assert.rejects(runner.run({ command: process.execPath, args: ["-e", parentScript] }, {
        signal: controller.signal,
        onOutput(stream, text) {
            if (stream === "stdout") { grandchild = Number(text.trim()); controller.abort(); }
        },
    }), error => error instanceof Error && error.name === "AbortError");
    assert.ok(grandchild > 0);
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt++) {
        try { process.kill(grandchild, 0); await new Promise(resolve => setTimeout(resolve, 25)); }
        catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); alive = false; }
    }
    assert.equal(alive, false, "The compiler child must not outlive cancellation.");
});

test("failed builds report compiler errors from stdout ahead of stderr warnings and build summaries", async () => {
    const runner = createProcessRunner();
    const diagnostic = "/project/Content.swift:4:2: error: no macro named 'Preview'";
    await assert.rejects(runner.run({
        command: process.execPath,
        args: ["-e", `
            process.stdout.write(${JSON.stringify(diagnostic)} + '\\n' + 'Build progress\\n'.repeat(1500));
            process.stderr.write('xcodebuild: WARNING: Using the first matching destination\\n** BUILD FAILED **\\nSwiftEmitModule normal arm64\\n');
            process.exitCode = 65;
        `],
    }), error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(diagnostic), "The compiler diagnostic must survive the trailing build output.");
        assert.ok(!error.message.includes("Using the first matching destination"));
        assert.ok(!error.message.includes("SwiftEmitModule"));
        return true;
    });
});
