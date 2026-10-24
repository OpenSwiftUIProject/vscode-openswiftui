import Foundation
import ObjectiveC
import OpenSwiftUI

@MainActor
struct OpenSwiftUIExpandedPreview {
    let name: String?
    private let body: @MainActor () -> any OpenSwiftUI.View

    init(_ name: String? = nil, body: @escaping @MainActor () -> any OpenSwiftUI.View) {
        self.name = name
        self.body = body
    }

    func makeView() -> OpenSwiftUI.AnyView { OpenSwiftUI.AnyView(body()) }
}

// The preview macro emits subclasses in the view's original declaration scope.
@MainActor
class OpenSwiftUIPreviewCase: NSObject {
    class var fileID: String { preconditionFailure("A preview must provide its source file.") }
    class var filePath: String { preconditionFailure("A preview must provide its source path.") }
    class var line: Int { preconditionFailure("A preview must provide its source line.") }
    class var column: Int { preconditionFailure("A preview must provide its source column.") }
    class var name: String? { nil }
    class var typeName: String? { nil }
    class var entries: [OpenSwiftUIPreviewEntry] {
        [OpenSwiftUIPreviewEntry(id: id, name: name, kind: "macro", typeName: typeName,
            providerType: nil, fileID: fileID, filePath: filePath, line: line, column: column,
            makeContent: { makeView() })]
    }
    class func makeView() -> OpenSwiftUI.AnyView {
        preconditionFailure("A preview must provide its view.")
    }

    class var id: String { "\(fileID):\(line):\(column)" }
}

@MainActor
struct OpenSwiftUIPreviewEntry {
    let id: String
    let name: String?
    let kind: String
    let typeName: String?
    let providerType: String?
    let fileID: String
    let filePath: String
    let line: Int
    let column: Int
    let makeContent: @MainActor () -> OpenSwiftUI.AnyView

    func makeView() -> OpenSwiftUI.AnyView { makeContent() }
}

@MainActor
enum PreviewRegistry {
    struct Metadata: Encodable {
        let id: String
        let name: String?
        let kind: String
        let typeName: String?
        let providerType: String?
        let fileID: String
        let filePath: String
        let line: Int
        let column: Int
    }

    struct Listing: Encodable {
        let version = 1
        let previews: [Metadata]
    }

    static func cases() -> [OpenSwiftUIPreviewEntry] {
        let capacity = objc_getClassList(nil, 0)
        guard capacity > 0 else { return [] }
        // An autoreleasing class-list buffer can initialize unrelated Objective-C classes.
        let classes = UnsafeMutablePointer<AnyClass>.allocate(capacity: Int(capacity))
        defer { classes.deallocate() }
        let count = min(capacity, objc_getClassList(AutoreleasingUnsafeMutablePointer(classes), capacity))
        return (0..<Int(count)).compactMap { index -> OpenSwiftUIPreviewCase.Type? in
            let candidate = classes[index]
            var superclass = class_getSuperclass(candidate)
            while let current = superclass {
                if ObjectIdentifier(current) == ObjectIdentifier(OpenSwiftUIPreviewCase.self) {
                    return candidate as? OpenSwiftUIPreviewCase.Type
                }
                superclass = class_getSuperclass(current)
            }
            return nil
        }.sorted {
            ($0.fileID, $0.line, $0.column) < ($1.fileID, $1.line, $1.column)
        }.flatMap { $0.entries }
    }

    static func listIfRequested() -> Bool {
        guard CommandLine.arguments.contains("--openswiftui-list-previews") else { return false }
        let previews = cases().map {
            Metadata(id: $0.id, name: $0.name, kind: $0.kind, typeName: $0.typeName, providerType: $0.providerType, fileID: $0.fileID, filePath: $0.filePath, line: $0.line, column: $0.column)
        }
        do {
            let data = try JSONEncoder().encode(Listing(previews: previews))
            let session = ProcessInfo.processInfo.environment["OPENSWIFTUI_PREVIEW_SESSION"] ?? "manual"
            FileHandle.standardOutput.write(Data("OPENSWIFTUI_PREVIEW_LIST:\(session):".utf8))
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
            return true
        } catch {
            FileHandle.standardError.write(Data("Could not list previews: \(error)\n".utf8))
            exit(EXIT_FAILURE)
        }
    }
}
