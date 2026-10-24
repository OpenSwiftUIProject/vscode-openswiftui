export type PreviewPlatform = "macos" | "ios-simulator";

export interface AutomaticPreviewOrigin {
    kind: "automatic";
    projectPath: string;
    targetID: string;
    workspacePath?: string;
}

export interface PackagePreviewOrigin {
    kind: "package";
    packagePath: string;
    targetName: string;
    productName: string;
    moduleName: string;
}

/** Paths are absolute after configuration loading. Commands never use a shell. */
export interface PreviewDefinition {
    origin?: AutomaticPreviewOrigin | PackagePreviewOrigin;
    id: string;
    name: string;
    previewID?: string;
    folder: string;
    project?: string;
    workspace?: string;
    scheme: string;
    configuration: string;
    target?: string;
    platforms: PreviewPlatform[];
    arguments: string[];
    environment: Record<string, string>;
    buildArguments: string[];
    developerDirectory?: string;
}

export type Destination =
    | { platform: "macos"; name: string }
    | { platform: "ios-simulator"; name: string; udid: string };

export interface PreviewRequest {
    preview: PreviewDefinition;
    destination: Destination;
    storagePath: string;
    previewID?: string;
    sourcePreview?: SourcePreview;
}

export interface SourcePreview {
    kind?: "macro" | "provider";
    name?: string;
    typeName?: string;
    providerType?: string;
    providerBodyEnd?: number;
    childTypeNames?: string[];
    hasSourceLocation?: true;
    filePath: string;
    line: number;
    column: number;
}

export interface PreviewCase {
    kind?: "macro" | "provider";
    id: string;
    name?: string;
    typeName?: string;
    providerType?: string;
    fileID: string;
    filePath?: string;
    line: number;
    column: number;
}

export type PreviewState = "idle" | "building" | "discovering" | "selecting" | "starting" | "running" | "stopping" | "failed";

export interface PreviewStatus {
    state: PreviewState;
    message: string;
    request?: PreviewRequest;
}

export interface PreviewController {
    readonly status: PreviewStatus;
    run(request: PreviewRequest): Promise<void>;
    stop(): Promise<void>;
    dispose(): Promise<void>;
}

export interface ControllerOptions {
    log(message: string): void;
    onStatus(status: PreviewStatus): void;
    readyTimeoutMs?: number;
    onPreviews?(previews: PreviewCase[], request: PreviewRequest): void;
    selectPreview?(previews: PreviewCase[], request: PreviewRequest, signal: AbortSignal): Promise<PreviewCase | undefined>;
}
