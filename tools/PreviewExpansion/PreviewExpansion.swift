import Foundation
import SwiftParser
import SwiftSyntax
import SwiftSyntaxBuilder

private struct Preview: Decodable {
    var kind: String?
    var name: String?
    var typeName: String?
    var providerType: String?
    var providerBodyEnd: Int?
    var childTypeNames: [String]?
    var line: Int
    var column: Int
    var key: String { "\(line):\(column)" }
}

private struct Input: Decodable {
    var sourceText: String
    var filePath: String
    var moduleName: String
    var expansionOutput: String
    var previews: [Preview]
    var selected: Preview
}

private struct Failure: Error, CustomStringConvertible {
    var description: String
    init(_ description: String) { self.description = description }
}

private func literal(_ value: String) -> String { StringLiteralExprSyntax(content: value).description }
private func optionalLiteral(_ value: String?) -> String { value.map(literal) ?? "nil" }
private func compact(_ text: String) -> String { text.filter { !$0.isWhitespace } }

private struct MacroSite {
    var start: Int
    var end: Int
    var endLine: Int
    var endColumn: Int
    var generic: Bool
}

private final class SourceVisitor: SyntaxVisitor {
    let locations: SourceLocationConverter
    var macros: [String: MacroSite] = [:]
    var genericDeclarations: Set<String> = []
    var scopes: [Bool] = []
    var hasSourceLocation = false
    init(tree: SourceFileSyntax, filePath: String) {
        locations = SourceLocationConverter(fileName: filePath, tree: tree)
        super.init(viewMode: .sourceAccurate)
    }
    func record(_ node: some FreestandingMacroExpansionSyntax) {
        guard node.macroName.text == "Preview" else { return }
        let start = locations.location(for: node.pound.positionAfterSkippingLeadingTrivia)
        let end = locations.location(for: node.endPositionBeforeTrailingTrivia)
        macros["\(start.line):\(start.column)"] = MacroSite(
            start: node.positionAfterSkippingLeadingTrivia.utf8Offset,
            end: node.endPositionBeforeTrailingTrivia.utf8Offset,
            endLine: end.line, endColumn: end.column, generic: scopes.contains(true)
        )
    }
    override func visit(_ node: MacroExpansionDeclSyntax) -> SyntaxVisitorContinueKind { record(node); return .visitChildren }
    override func visit(_ node: MacroExpansionExprSyntax) -> SyntaxVisitorContinueKind { record(node); return .visitChildren }
    override func visit(_ node: StringLiteralExprSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: PoundSourceLocationSyntax) -> SyntaxVisitorContinueKind { hasSourceLocation = true; return .skipChildren }
    func enter(_ keyword: TokenSyntax, generic: Bool) {
        scopes.append(generic)
        if scopes.contains(true) {
            let location = locations.location(for: keyword.positionAfterSkippingLeadingTrivia)
            genericDeclarations.insert("\(location.line):\(location.column)")
        }
    }
    override func visit(_ node: StructDeclSyntax) -> SyntaxVisitorContinueKind { enter(node.structKeyword, generic: node.genericParameterClause != nil); return .visitChildren }
    override func visitPost(_ node: StructDeclSyntax) { scopes.removeLast() }
    override func visit(_ node: ClassDeclSyntax) -> SyntaxVisitorContinueKind { enter(node.classKeyword, generic: node.genericParameterClause != nil); return .visitChildren }
    override func visitPost(_ node: ClassDeclSyntax) { scopes.removeLast() }
    override func visit(_ node: EnumDeclSyntax) -> SyntaxVisitorContinueKind { enter(node.enumKeyword, generic: node.genericParameterClause != nil); return .visitChildren }
    override func visitPost(_ node: EnumDeclSyntax) { scopes.removeLast() }
    override func visit(_ node: ActorDeclSyntax) -> SyntaxVisitorContinueKind { enter(node.actorKeyword, generic: node.genericParameterClause != nil); return .visitChildren }
    override func visitPost(_ node: ActorDeclSyntax) { scopes.removeLast() }
    override func visit(_ node: ExtensionDeclSyntax) -> SyntaxVisitorContinueKind { enter(node.extensionKeyword, generic: node.genericWhereClause != nil); return .visitChildren }
    override func visitPost(_ node: ExtensionDeclSyntax) { scopes.removeLast() }
    override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind { scopes.append(node.genericParameterClause != nil); return .visitChildren }
    override func visitPost(_ node: FunctionDeclSyntax) { scopes.removeLast() }
}

private func expression(_ statements: CodeBlockItemListSyntax) -> ExprSyntax? {
    guard statements.count == 1, let item = statements.first else { return nil }
    return item.item.as(ExprSyntax.self) ?? item.item.as(ReturnStmtSyntax.self)?.expression
}

private func property(_ name: String, in declaration: StructDeclSyntax) -> ExprSyntax? {
    for member in declaration.memberBlock.members {
        guard let variable = member.decl.as(VariableDeclSyntax.self) else { continue }
        for binding in variable.bindings where binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text == name {
            if let value = binding.initializer?.value { return value }
            guard let accessors = binding.accessorBlock?.accessors else { continue }
            if case .getter(let statements) = accessors { return expression(statements) }
        }
    }
    return nil
}

private final class RegistryVisitor: SyntaxVisitor {
    var declarations: [StructDeclSyntax] = []
    init() { super.init(viewMode: .sourceAccurate) }
    override func visit(_ node: StructDeclSyntax) -> SyntaxVisitorContinueKind {
        if node.inheritanceClause?.inheritedTypes.contains(where: {
            ["DeveloperToolsSupport::PreviewRegistry", "DeveloperToolsSupport.PreviewRegistry"].contains(compact($0.type.description))
        }) == true { declarations.append(node) }
        return .visitChildren
    }
}

private struct CompiledPreview: Equatable {
    var expression: String
    var displayName: String?
}

private func rootDisplayName(_ call: FunctionCallExprSyntax) -> String? {
    guard let closure = call.trailingClosure ?? call.arguments.first(where: { $0.label?.text == "body" })?.expression.as(ClosureExprSyntax.self) else { return nil }
    var statements = closure.statements
    if statements.count == 2,
       let builder = statements.first?.item.as(FunctionDeclSyntax.self), builder.name.text == "__b_buildView",
       let invocation = statements.last?.item.as(ReturnStmtSyntax.self)?.expression?.as(FunctionCallExprSyntax.self),
       invocation.calledExpression.as(DeclReferenceExprSyntax.self)?.baseName.text == builder.name.text,
       let content = invocation.trailingClosure {
        statements = content.statements
    }
    guard var value = expression(statements) else { return nil }
    while let modifier = value.as(FunctionCallExprSyntax.self),
          let member = modifier.calledExpression.as(MemberAccessExprSyntax.self), let base = member.base {
        if member.declName.baseName.text == "previewDisplayName", let name = modifier.arguments.first?.expression {
            // Capture variables belong to the body closure, not the registry's metadata scope.
            if closure.signature?.capture != nil {
                guard let literal = name.as(StringLiteralExprSyntax.self),
                      literal.segments.allSatisfy({ $0.is(StringSegmentSyntax.self) }) else { return nil }
            }
            return name.trimmedDescription
        }
        value = base
    }
    return nil
}

private func compiledExpressions(_ dump: String, fileID: String) throws -> [String: CompiledPreview] {
    let lines = dump.components(separatedBy: .newlines)
    var index = 0
    var result: [String: CompiledPreview] = [:]
    while index < lines.count {
        guard lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("@__swiftmacro_"),
              index + 1 < lines.count, lines[index + 1].trimmingCharacters(in: .whitespaces) == "------------------------------" else { index += 1; continue }
        index += 2
        let start = index
        var tree: SourceFileSyntax?
        while index < lines.count {
            if lines[index].trimmingCharacters(in: .whitespaces) == "------------------------------" {
                let candidate = Parser.parse(source: lines[start..<index].joined(separator: "\n"))
                // The delimiter can also occur inside a multiline string or comment.
                if !candidate.hasError { tree = candidate; break }
            }
            index += 1
        }
        guard let tree else { throw Failure("The compiler macro expansion output is incomplete. Rebuild the project.") }
        index += 1
        let visitor = RegistryVisitor(); visitor.walk(tree)
        for declaration in visitor.declarations {
            guard property("fileID", in: declaration)?.as(StringLiteralExprSyntax.self)?.representedLiteralValue == fileID else { continue }
            guard let line = property("line", in: declaration)?.as(IntegerLiteralExprSyntax.self)?.literal.text,
                  let column = property("column", in: declaration)?.as(IntegerLiteralExprSyntax.self)?.literal.text,
                  Int(line) != nil, Int(column) != nil else { throw Failure("The compiled Preview registry has invalid source coordinates.") }
            let methods = declaration.memberBlock.members.compactMap { $0.decl.as(FunctionDeclSyntax.self) }.filter { $0.name.text == "makePreview" }
            guard methods.count == 1, let body = methods[0].body,
                  var call = expression(body.statements)?.as(FunctionCallExprSyntax.self),
                  ["DeveloperToolsSupport::Preview", "DeveloperToolsSupport.Preview"].contains(compact(call.calledExpression.description)) else {
                throw Failure("The compiled Preview registry uses an unsupported makePreview body.")
            }
            guard !call.arguments.contains(where: { $0.label?.text == "traits" }), call.additionalTrailingClosures.isEmpty else {
                throw Failure("Compiled Preview traits and additional trailing closures are not supported by the native host.")
            }
            call.calledExpression = ExprSyntax("OpenSwiftUIExpandedPreview")
            let key = "\(line):\(column)"
            let rewritten = CompiledPreview(expression: call.trimmedDescription, displayName: rootDisplayName(call))
            if let existing = result[key], existing != rewritten { throw Failure("The compiler produced ambiguous Preview expansions at \(key).") }
            result[key] = rewritten
        }
    }
    return result
}

private func metadata(_ preview: Preview, fileID: String, filePath: String) -> String {
    """
    override class var fileID: String { \(literal(fileID)) }
    override class var filePath: String { \(literal(filePath)) }
    override class var line: Int { \(preview.line) }
    override class var column: Int { \(preview.column) }
    override class var typeName: String? { \(optionalLiteral(preview.typeName)) }
    """
}

private func macroAdapter(_ preview: Preview, compiled: CompiledPreview, fileID: String, filePath: String) -> String {
    """
    @MainActor final class _OpenSwiftUIExpanded_\(preview.line)_\(preview.column): OpenSwiftUIPreviewCase {
        \(metadata(preview, fileID: fileID, filePath: filePath))
        override class var entries: [OpenSwiftUIPreviewEntry] {
            let captured = \(compiled.expression)
            return [OpenSwiftUIPreviewEntry(id: id, name: captured.name ?? (\(compiled.displayName ?? optionalLiteral(preview.name))) ?? typeName,
                kind: "macro", typeName: typeName, providerType: nil,
                fileID: fileID, filePath: filePath, line: line, column: column,
                makeContent: { captured.makeView() })]
        }
    }
    """
}

private func providerAdapter(_ preview: Preview, fileID: String, filePath: String) throws -> String {
    guard let provider = preview.providerType else { throw Failure("The PreviewProvider type is missing.") }
    let children = preview.childTypeNames.map { "[" + $0.map(literal).joined(separator: ", ") + "]" } ?? "nil"
    return """
    @MainActor final class _OpenSwiftUIProvider_\(preview.line)_\(preview.column): OpenSwiftUIPreviewCase {
        \(metadata(preview, fileID: fileID, filePath: filePath))
        override class var entries: [OpenSwiftUIPreviewEntry] {
            let previews = \(provider)._allPreviews
            let childTypeNames: [String]? = \(children)
            return previews.enumerated().map { index, preview in
                let fallback: String? = childTypeNames?.count == previews.count
                    ? childTypeNames?[index] : (previews.count == 1 ? typeName : nil)
                let contentType = ["Element", "_VariadicView.Children.Element"].contains(preview.contentType) ? fallback : preview.contentType
                return OpenSwiftUIPreviewEntry(id: "\\(id):provider:\\(preview.id)", name: preview.displayName ?? contentType,
                    kind: "provider", typeName: contentType, providerType: \(literal(provider)),
                    fileID: fileID, filePath: filePath, line: line, column: column,
                    makeContent: { preview.content })
            }
        }
    }
    """
}

private struct Edit { var start: Int; var end: Int; var text: String }

private func transform(_ input: Input) throws -> String {
    let tree = Parser.parse(source: input.sourceText)
    guard !tree.hasError else { throw Failure("The selected Swift source is incomplete or contains syntax errors.") }
    let visitor = SourceVisitor(tree: tree, filePath: input.filePath); visitor.walk(tree)
    guard !visitor.hasSourceLocation else { throw Failure("Compiled Preview adapters do not support files with #sourceLocation directives.") }
    guard let selected = input.previews.first(where: { $0.key == input.selected.key && ($0.kind ?? "macro") == (input.selected.kind ?? "macro") && $0.providerType == input.selected.providerType }) else {
        throw Failure("The selected Preview declaration changed. Select it again.")
    }
    let fileID = input.moduleName + "/" + URL(fileURLWithPath: input.filePath).lastPathComponent
    let compiled = try compiledExpressions(input.expansionOutput, fileID: fileID)
    if selected.kind != "provider" && compiled[selected.key] == nil {
        throw Failure("The selected Preview has no compiled expansion in \(input.moduleName). Rebuild or select an active declaration.")
    }
    var edits: [Edit] = []
    func restore(line: Int, column: Int) -> String {
        "\n#sourceLocation(file: \(literal(input.filePath)), line: \(line))\n" + String(repeating: " ", count: max(0, column - 1))
    }
    let bytes = Array(input.sourceText.utf8)
    for preview in input.previews {
        if preview.kind == "provider" {
            guard !visitor.genericDeclarations.contains(preview.key) else { throw Failure("PreviewProvider declarations inside generic types are not supported.") }
            guard let offset = preview.providerBodyEnd, bytes.indices.contains(offset), bytes[offset] == 0x7d else { throw Failure("The PreviewProvider is incomplete. Add its closing brace before running Preview.") }
            let location = visitor.locations.location(for: AbsolutePosition(utf8Offset: offset))
            edits.append(Edit(start: offset, end: offset,
                text: "\n" + (try providerAdapter(preview, fileID: fileID, filePath: input.filePath)) + restore(line: location.line, column: location.column)))
        } else if let expansion = compiled[preview.key] {
            guard let site = visitor.macros[preview.key] else { throw Failure("A compiled Preview no longer matches its source declaration.") }
            guard !site.generic else { throw Failure("Preview declarations inside generic types are not supported.") }
            edits.append(Edit(start: site.start, end: site.end,
                text: macroAdapter(preview, compiled: expansion, fileID: fileID, filePath: input.filePath) + restore(line: site.endLine, column: site.endColumn)))
        }
    }
    var transformed = bytes
    var lastStart = bytes.count + 1
    for edit in edits.sorted(by: { $0.start > $1.start }) {
        guard edit.end <= lastStart else { throw Failure("Nested Preview expansions overlap and cannot be adapted safely.") }
        transformed.replaceSubrange(edit.start..<edit.end, with: edit.text.utf8)
        lastStart = edit.start
    }
    return String(decoding: transformed, as: UTF8.self)
}

@main
private enum PreviewExpansion {
    static func main() {
        do {
            guard CommandLine.arguments.count == 2 else { throw Failure("Usage: PreviewExpansion <input-json>") }
            let input = try JSONDecoder().decode(Input.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
            let output = try JSONEncoder().encode(["source": transform(input)])
            FileHandle.standardOutput.write(output)
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(EXIT_FAILURE)
        }
    }
}
