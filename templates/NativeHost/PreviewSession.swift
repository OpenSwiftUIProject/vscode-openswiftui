import Foundation
import OpenSwiftUI

@MainActor
enum PreviewSession {
    private static var didReportReady = false

    static func makeContent() -> OpenSwiftUI.AnyView {
        let cases = PreviewRegistry.cases()
        let requestedID = ProcessInfo.processInfo.environment["OPENSWIFTUI_PREVIEW_ID"]
        guard let selected = requestedID.flatMap({ id in cases.first { $0.id == id } })
            ?? (requestedID == nil && cases.count == 1 ? cases.first : nil) else {
            let message = "Select a compiled #Preview case. Requested ID: \(requestedID ?? "none"). Available: \(cases.map { $0.id }.joined(separator: ", "))\n"
            FileHandle.standardError.write(Data(message.utf8))
            exit(EXIT_FAILURE)
        }
        return selected.makeView()
    }

    static func reportReady() {
        guard !didReportReady else { return }
        didReportReady = true
        let session = ProcessInfo.processInfo.environment["OPENSWIFTUI_PREVIEW_SESSION"] ?? "manual"
        FileHandle.standardOutput.write(Data("OPENSWIFTUI_PREVIEW_READY:\(session)\n".utf8))
    }
}
