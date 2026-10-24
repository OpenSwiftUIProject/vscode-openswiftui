import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { createPreviewBackend, PreviewBackend, PreviewSession, PreviewStartError } from "./backend";
import { throwIfCancelled } from "./process";
import { ControllerOptions, PreviewCase, PreviewController, PreviewRequest, PreviewStatus, SourcePreview } from "./types";

async function compiledSourcePreviews(previews: PreviewCase[], source: SourcePreview): Promise<PreviewCase[]> {
    if (previews.every(preview => !preview.filePath)) {
        throw new Error("Update the native host templates to select previews from source. The compiled host does not report source paths.");
    }
    const canonical = async (file: string) => realpath(file).catch(() => path.resolve(file));
    const sourcePath = await canonical(source.filePath);
    const matches: PreviewCase[] = [];
    for (const preview of previews) {
        if ((preview.kind ?? "macro") === (source.kind ?? "macro") &&
            (!source.providerType || preview.providerType === source.providerType) &&
            preview.filePath && preview.line === source.line && preview.column === source.column &&
            await canonical(preview.filePath) === sourcePath) matches.push(preview);
    }
    if (!matches.length || (source.kind !== "provider" && matches.length !== 1)) {
        throw new Error(`The selected preview at ${source.filePath}:${source.line}:${source.column} was not compiled uniquely into the selected app target. Check target membership and conditional compilation, then select it again.`);
    }
    return matches;
}

export function createPreviewController(options: ControllerOptions, backend: PreviewBackend = createPreviewBackend(options.log)): PreviewController {
    return new SessionController(options, backend);
}

class SessionController implements PreviewController {
    private currentStatus: PreviewStatus = { state: "idle", message: "Preview stopped." };
    private generation = 0;
    private operation?: AbortController;
    private tail: Promise<void> = Promise.resolve();
    private active?: { session: PreviewSession; request: PreviewRequest };
    private readonly closing = new Set<PreviewSession>();
    private disposed = false;

    constructor(private readonly options: ControllerOptions, private readonly backend: PreviewBackend) {}

    get status(): PreviewStatus { return this.currentStatus; }

    private update(status: PreviewStatus): void {
        this.currentStatus = status;
        this.options.onStatus(status);
    }

    run(request: PreviewRequest): Promise<void> {
        if (this.disposed) { return Promise.reject(new Error("Preview controller has been disposed.")); }
        const generation = ++this.generation;
        this.operation?.abort();
        const operation = new AbortController();
        this.operation = operation;
        const current = () => generation === this.generation && !operation.signal.aborted && !this.disposed;
        const job = this.tail.then(async () => {
            if (!current()) { return; }
            this.update({ state: "building", message: `Building ${request.preview.name}…`, request });
            let stage: "build" | "stop" | "discover" | "select" | "start" = "build";
            let selectedRequest = request;
            try {
                const artifact = await this.backend.build(request, operation.signal);
                if (!current()) { return; }
                // Preserve the existing interactive host until the replacement build succeeds.
                stage = "stop";
                await this.stopActive();
                if (!current()) { return; }
                stage = "discover";
                this.update({ state: "discovering", message: `Finding compiled previews in ${request.preview.name}…`, request });
                const previews = await this.backend.discover(artifact, request, randomUUID(), operation.signal, this.options.readyTimeoutMs ?? 30000);
                if (!current()) return;
                if (!previews.length) throw new Error("The selected app contains no compiled previews. Include the view source files and preview macro shim in the host target.");
                this.options.onPreviews?.(previews, request);
                const candidates = request.sourcePreview ? await compiledSourcePreviews(previews, request.sourcePreview) : previews;
                const requestedID = request.previewID ?? (request.sourcePreview ? undefined : request.preview.previewID);
                let selected = requestedID ? candidates.find(preview => preview.id === requestedID)
                    : request.sourcePreview && candidates.length === 1 ? candidates[0] : undefined;
                if (!current()) return;
                if (requestedID && !selected) throw new Error(`The selected preview was removed or its ID was not found: ${requestedID}. Run Preview to select another.`);
                if (!selected) {
                    stage = "select";
                    this.update({ state: "selecting", message: "Select a compiled preview.", request });
                    if (!this.options.selectPreview) throw new Error("A compiled preview selection is required.");
                    selected = await this.options.selectPreview(candidates, request, operation.signal);
                    if (!current()) return;
                    if (!selected) {
                        this.update({ state: "idle", message: "Preview selection cancelled." });
                        return;
                    }
                    if (!candidates.some(preview => preview.id === selected!.id)) throw new Error("The selected preview is not part of the current source selection.");
                }
                selectedRequest = { ...request, previewID: selected.id };
                stage = "start";
                this.update({ state: "starting", message: `Starting ${selected.name ?? selected.typeName ?? selected.fileID}…`, request: selectedRequest });
                const session = await this.backend.start(artifact, selectedRequest, randomUUID(), operation.signal, this.options.readyTimeoutMs ?? 30000);
                this.trackSession(session, selectedRequest);
                if (!current()) { await this.stopActive(); return; }
                throwIfCancelled(operation.signal);
                this.update({ state: "running", message: `${selected.name ?? selected.typeName ?? selected.fileID} is running on ${request.destination.name}.`, request: selectedRequest });
            } catch (error) {
                if (error instanceof PreviewStartError) { this.trackSession(error.session, selectedRequest); }
                if (!current()) { return; }
                const message = error instanceof Error ? error.message : String(error);
                this.options.log(`${message}\n`);
                if (this.active) {
                    const reason = stage === "build" ? "Build failed; the previous preview is still running"
                        : stage === "stop" ? "Could not stop the previous preview; it is still running"
                        : "Preview preparation failed and the host could not be stopped. Retry Stop Preview";
                    this.update({ state: stage === "build" || stage === "stop" ? "running" : "failed", message: `${reason}. ${message}`, request: this.active.request });
                } else {
                    this.update({ state: "failed", message, request });
                }
                throw error;
            } finally {
                if (this.operation === operation) { this.operation = undefined; }
            }
        });
        this.tail = job.catch(() => {});
        return job;
    }

    stop(): Promise<void> {
        const generation = ++this.generation;
        this.operation?.abort();
        this.operation = undefined;
        this.update({ state: "stopping", message: "Stopping preview…", request: this.active?.request });
        const job = this.tail.then(async () => {
            try {
                await this.stopActive();
                if (generation === this.generation) { this.update({ state: "idle", message: "Preview stopped." }); }
            } catch (error) {
                if (generation === this.generation) {
                    this.update({ state: this.active ? "running" : "failed", message: `Could not stop preview: ${String(error)}`, request: this.active?.request });
                }
                throw error;
            }
        });
        this.tail = job.catch(() => {});
        return job;
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        await this.stop();
    }

    private trackSession(session: PreviewSession, request: PreviewRequest): void {
        const active = { session, request };
        this.active = active;
        void session.exited.then(exit => {
            if (this.active !== active) { return; }
            this.active = undefined;
            if (this.operation || this.disposed || this.closing.has(session)) { return; }
            this.update({
                state: exit.code === 0 && !exit.error ? "idle" : "failed",
                message: exit.error ? `Preview host failed: ${exit.error.message}` : `Preview host exited (${exit.signal ?? exit.code}).`, request,
            });
        });
    }

    private async stopActive(): Promise<void> {
        const active = this.active;
        if (!active) { return; }
        this.closing.add(active.session);
        try {
            await active.session.stop();
            if (this.active === active) { this.active = undefined; }
        } finally {
            this.closing.delete(active.session);
        }
    }
}
