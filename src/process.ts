import { spawn } from "node:child_process";

export interface Command {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
}

export interface ProcessExit {
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
}

export interface ManagedProcess {
    readonly pid?: number;
    readonly exit: ProcessExit | undefined;
    readonly exited: Promise<ProcessExit>;
    onOutput(listener: (stream: "stdout" | "stderr", text: string) => void): () => void;
    terminate(): Promise<void>;
}

export interface CommandOptions {
    signal?: AbortSignal;
    onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface CommandResult {
    stdout: string;
    stderr: string;
}

export interface ProcessRunner {
    spawn(command: Command): ManagedProcess;
    run(command: Command, options?: CommandOptions): Promise<CommandResult>;
}

export function cancellationError(): Error {
    const error = new Error("Preview operation cancelled.");
    error.name = "AbortError";
    return error;
}

export function throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) { throw cancellationError(); }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class ChildProcess implements ManagedProcess {
    private readonly child;
    private readonly grouped = process.platform !== "win32";
    private readonly listeners = new Set<(stream: "stdout" | "stderr", text: string) => void>();
    private readonly backlog: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
    private backlogSize = 0;
    private termination?: Promise<void>;
    private result: ProcessExit | undefined;
    readonly exited: Promise<ProcessExit>;

    constructor(command: Command) {
        this.child = spawn(command.command, command.args, {
            cwd: command.cwd,
            env: { ...process.env, ...command.env },
            shell: false,
            detached: this.grouped,
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.child.stdout.setEncoding("utf8");
        this.child.stderr.setEncoding("utf8");
        this.child.stdout.on("data", (text: string) => this.emit("stdout", text));
        this.child.stderr.on("data", (text: string) => this.emit("stderr", text));
        this.exited = new Promise(resolve => {
            const finish = (result: ProcessExit) => {
                if (this.result) { return; }
                this.result = result;
                resolve(result);
            };
            this.child.once("error", error => finish({ code: null, signal: null, error }));
            // Wait for output pipes to close so the last readiness line is not lost.
            this.child.once("close", (code, signal) => finish({ code, signal }));
        });
    }

    get pid(): number | undefined { return this.child.pid; }
    get exit(): ProcessExit | undefined { return this.result; }

    onOutput(listener: (stream: "stdout" | "stderr", text: string) => void): () => void {
        this.listeners.add(listener);
        for (const output of this.backlog) { listener(output.stream, output.text); }
        return () => { this.listeners.delete(listener); };
    }

    private emit(stream: "stdout" | "stderr", text: string): void {
        this.backlog.push({ stream, text });
        this.backlogSize += text.length;
        while (this.backlogSize > 64 * 1024 && this.backlog.length > 1) {
            this.backlogSize -= this.backlog.shift()!.text.length;
        }
        for (const listener of this.listeners) { listener(stream, text); }
    }

    terminate(): Promise<void> {
        if (!this.termination) {
            const attempt = this.terminateProcess();
            this.termination = attempt;
            void attempt.catch(() => { if (this.termination === attempt) { this.termination = undefined; } });
        }
        return this.termination;
    }

    private send(signal: NodeJS.Signals): void {
        if (!this.pid) { return; }
        try {
            if (this.grouped) { process.kill(-this.pid, signal); }
            else if (!this.result) { this.child.kill(signal); }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") { throw error; }
        }
    }

    private groupExists(): boolean {
        if (!this.pid) { return false; }
        try { process.kill(this.grouped ? -this.pid : this.pid, 0); return true; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") { return false; }
            // Darwin can deny signal 0 while an owned process is exiting. Keep
            // polling through the grace period; stop-signal failures still throw.
            if ((error as NodeJS.ErrnoException).code === "EPERM") { return true; }
            throw error;
        }
    }

    private async terminateProcess(): Promise<void> {
        if (!this.pid) { await this.exited; return; }
        this.send("SIGTERM");
        const deadline = Date.now() + 1500;
        // A build tool can exit before its compiler children. Check the process group too.
        while (this.groupExists() && Date.now() < deadline) { await delay(25); }
        if (this.groupExists()) { this.send("SIGKILL"); }
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Timed out while stopping a preview process.")), 1500);
            void this.exited.then(() => { clearTimeout(timer); resolve(); });
        });
    }
}

function failureDetail(stdout: string, stderr: string): string {
    const diagnostics = new Set<string>();
    for (const output of [stdout, stderr]) {
        for (const line of output.split(/\r?\n/)) {
            if (/(?:^|:\s)(?:fatal )?error:/i.test(line)) {
                diagnostics.add(line.trim());
                if (diagnostics.size === 4) { return [...diagnostics].join("\n").slice(0, 12000); }
            }
        }
    }
    return diagnostics.size ? [...diagnostics].join("\n").slice(0, 12000) : (stderr.trim() || stdout.trim()).slice(-12000);
}

export function createProcessRunner(spawnProcess: (command: Command) => ManagedProcess = command => new ChildProcess(command)): ProcessRunner {
    const runner: ProcessRunner = {
        spawn: spawnProcess,
        async run(command, options = {}) {
            if (options.signal) { throwIfCancelled(options.signal); }
            const child = runner.spawn(command);
            let stdout = "";
            let stderr = "";
            const unsubscribe = child.onOutput((stream, text) => {
                // Keep a bounded diagnostic tail. Xcode build output can be very large.
                if (stream === "stdout") { stdout = (stdout + text).slice(-8 * 1024 * 1024); }
                else { stderr = (stderr + text).slice(-8 * 1024 * 1024); }
                options.onOutput?.(stream, text);
            });
            let cancellation: Promise<void> | undefined;
            let rejectCancellation!: (error: Error) => void;
            const cancellationFailed = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
            const abort = () => {
                cancellation ??= child.terminate();
                void cancellation.catch(rejectCancellation);
            };
            options.signal?.addEventListener("abort", abort, { once: true });
            if (options.signal?.aborted) { abort(); }
            try {
                const exit = await Promise.race([child.exited, cancellationFailed]);
                await cancellation;
                if (options.signal) { throwIfCancelled(options.signal); }
                if (exit.error) { throw exit.error; }
                if (exit.code !== 0) {
                    const detail = failureDetail(stdout, stderr);
                    throw new Error(`${command.command} exited with ${exit.signal ?? exit.code}.${detail ? `\n${detail}` : ""}`);
                }
                return { stdout, stderr };
            } finally {
                unsubscribe();
                options.signal?.removeEventListener("abort", abort);
            }
        },
    };
    return runner;
}
