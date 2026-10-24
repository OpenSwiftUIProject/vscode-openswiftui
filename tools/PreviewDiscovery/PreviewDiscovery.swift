import Foundation
import SwiftParser
import SwiftSyntax

private struct SourcePreview: Encodable {
    let kind: String
    let name: String?
    let typeName: String?
    let providerType: String?
    let providerBodyEnd: Int?
    let childTypeNames: [String]?
    let hasSourceLocation: Bool?
    let filePath: String
    let line: Int
    let column: Int
}

private struct ViewMetadata {
    var name: String?
    var typeName: String?
}

private func singleExpression(_ statements: CodeBlockItemListSyntax) -> ExprSyntax? {
    let expressions = statements.compactMap { item -> ExprSyntax? in
        if let expression = item.item.as(ExprSyntax.self) { return expression }
        return item.item.as(ReturnStmtSyntax.self)?.expression
    }
    return expressions.count == 1 ? expressions[0] : nil
}

private func qualifiedName(_ expression: ExprSyntax) -> String? {
    if let name = expression.as(DeclReferenceExprSyntax.self) { return name.baseName.text }
    if let member = expression.as(MemberAccessExprSyntax.self), let base = member.base,
       let prefix = qualifiedName(base) { return "\(prefix).\(member.declName.baseName.text)" }
    if let generic = expression.as(GenericSpecializationExprSyntax.self) { return qualifiedName(generic.expression) }
    return nil
}

private func isTypeName(_ name: String) -> Bool {
    name.split(separator: ".").last?.replacingOccurrences(of: "`", with: "").first?.isUppercase == true
}

private func viewMetadata(_ original: ExprSyntax?) -> ViewMetadata {
    var result = ViewMetadata()
    var expression = original
    var hasDisplayName = false
    while let current = expression {
        if let call = current.as(FunctionCallExprSyntax.self) {
            if let name = qualifiedName(call.calledExpression), isTypeName(name) {
                result.typeName = name
                break
            }
            if let member = call.calledExpression.as(MemberAccessExprSyntax.self), let base = member.base {
                let name = member.declName.baseName.text
                if name == "init", let type = qualifiedName(base), isTypeName(type) {
                    result.typeName = type
                    break
                }
                if name == "previewDisplayName", !hasDisplayName {
                    hasDisplayName = true
                    result.name = call.arguments.first?.expression.as(StringLiteralExprSyntax.self)?.representedLiteralValue
                }
                expression = base
                continue
            }
        } else if let member = current.as(MemberAccessExprSyntax.self), let base = member.base,
                  let name = qualifiedName(base), isTypeName(name) {
            result.typeName = name
        } else if let tuple = current.as(TupleExprSyntax.self), tuple.elements.count == 1 {
            expression = tuple.elements.first?.expression
            continue
        }
        break
    }
    return result
}

private func linearViewTypes(_ statements: CodeBlockItemListSyntax) -> [String]? {
    var result: [String] = []
    for item in statements {
        guard var expression = item.item.as(ExprSyntax.self) ?? item.item.as(ReturnStmtSyntax.self)?.expression else { return nil }
        while let call = expression.as(FunctionCallExprSyntax.self),
              let member = call.calledExpression.as(MemberAccessExprSyntax.self), let base = member.base,
              member.declName.baseName.text != "init", qualifiedName(call.calledExpression).map(isTypeName) != true {
            expression = base
        }
        guard let type = viewMetadata(expression).typeName else { return nil }
        let leaf = type.split(separator: ".").last.map(String.init)
        if leaf == "Group" {
            guard let call = expression.as(FunctionCallExprSyntax.self),
                  let body = call.trailingClosure ?? call.arguments.compactMap({ $0.expression.as(ClosureExprSyntax.self) }).first,
                  let nested = linearViewTypes(body.statements) else { return nil }
            result.append(contentsOf: nested)
        } else {
            guard !["ForEach", "AnyView", "ModifiedContent"].contains(leaf) else { return nil }
            result.append(type)
        }
    }
    return result.isEmpty ? nil : result
}

private func previewsStatements(_ members: MemberBlockSyntax) -> CodeBlockItemListSyntax? {
    for member in members.members {
        guard let variable = member.decl.as(VariableDeclSyntax.self),
              variable.modifiers.contains(where: { ["static", "class"].contains($0.name.text) }) else { continue }
        for binding in variable.bindings where binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text == "previews" {
            if let initializer = binding.initializer {
                return CodeBlockItemListSyntax([CodeBlockItemSyntax(item: .expr(initializer.value))])
            }
            guard let accessors = binding.accessorBlock?.accessors else { continue }
            switch accessors {
            case .getter(let statements): return statements
            case .accessors(let declarations):
                if let getter = declarations.first(where: { $0.accessorSpecifier.text == "get" }), let body = getter.body {
                    return body.statements
                }
            }
        }
    }
    return nil
}

private final class PreviewVisitor: SyntaxVisitor {
    private let filePath: String
    private let locations: SourceLocationConverter
    private var macros: [SourcePreview] = []
    private var scope: [String] = []
    private var declarations: [String: MemberBlockSyntax] = [:]
    private var providers: [(type: String, keyword: TokenSyntax, members: MemberBlockSyntax)] = []
    private var hasSourceLocation = false

    var previews: [SourcePreview] {
        let providers = providers.map { provider in
            let statements = previewsStatements(provider.members) ?? declarations[provider.type].flatMap(previewsStatements)
            let metadata = viewMetadata(statements.flatMap(singleExpression))
            let childTypes = statements.flatMap(linearViewTypes)
            let typeName = childTypes?.count == 1 ? childTypes?.first
                : ["Group", "ForEach", "AnyView", "ModifiedContent"].contains(metadata.typeName?.split(separator: ".").last.map(String.init))
                    ? nil : metadata.typeName
            let location = locations.location(for: provider.keyword.positionAfterSkippingLeadingTrivia)
            return SourcePreview(
                kind: "provider", name: metadata.name, typeName: typeName,
                providerType: provider.type,
                providerBodyEnd: provider.members.rightBrace.presence == .present
                    ? provider.members.rightBrace.positionAfterSkippingLeadingTrivia.utf8Offset : nil,
                childTypeNames: childTypes,
                hasSourceLocation: hasSourceLocation ? true : nil,
                filePath: filePath, line: location.line, column: location.column
            )
        }
        return (macros + providers).sorted { ($0.line, $0.column) < ($1.line, $1.column) }
    }

    init(filePath: String, tree: SourceFileSyntax) {
        self.filePath = filePath
        locations = SourceLocationConverter(fileName: filePath, tree: tree)
        super.init(viewMode: .sourceAccurate)
    }

    override func visit(_ node: MacroExpansionDeclSyntax) -> SyntaxVisitorContinueKind {
        record(name: node.macroName, pound: node.pound, arguments: node.arguments, body: node.trailingClosure)
        return .visitChildren
    }

    override func visit(_ node: MacroExpansionExprSyntax) -> SyntaxVisitorContinueKind {
        record(name: node.macroName, pound: node.pound, arguments: node.arguments, body: node.trailingClosure)
        return .visitChildren
    }

    override func visit(_ node: StringLiteralExprSyntax) -> SyntaxVisitorContinueKind {
        .skipChildren
    }

    override func visit(_ node: PoundSourceLocationSyntax) -> SyntaxVisitorContinueKind {
        hasSourceLocation = true
        return .skipChildren
    }

    override func visit(_ node: StructDeclSyntax) -> SyntaxVisitorContinueKind {
        enter(name: node.name.text, keyword: node.structKeyword, inheritance: node.inheritanceClause, members: node.memberBlock)
        return .visitChildren
    }
    override func visitPost(_ node: StructDeclSyntax) { scope.removeLast() }

    override func visit(_ node: ClassDeclSyntax) -> SyntaxVisitorContinueKind {
        enter(name: node.name.text, keyword: node.classKeyword, inheritance: node.inheritanceClause, members: node.memberBlock)
        return .visitChildren
    }
    override func visitPost(_ node: ClassDeclSyntax) { scope.removeLast() }

    override func visit(_ node: EnumDeclSyntax) -> SyntaxVisitorContinueKind {
        enter(name: node.name.text, keyword: node.enumKeyword, inheritance: node.inheritanceClause, members: node.memberBlock)
        return .visitChildren
    }
    override func visitPost(_ node: EnumDeclSyntax) { scope.removeLast() }

    override func visit(_ node: ActorDeclSyntax) -> SyntaxVisitorContinueKind {
        enter(name: node.name.text, keyword: node.actorKeyword, inheritance: node.inheritanceClause, members: node.memberBlock)
        return .visitChildren
    }
    override func visitPost(_ node: ActorDeclSyntax) { scope.removeLast() }

    override func visit(_ node: ExtensionDeclSyntax) -> SyntaxVisitorContinueKind {
        enter(name: node.extendedType.trimmedDescription, keyword: node.extensionKeyword,
              inheritance: node.inheritanceClause, members: node.memberBlock, extension: true)
        return .visitChildren
    }
    override func visitPost(_ node: ExtensionDeclSyntax) { scope.removeLast() }

    private func enter(name: String, keyword: TokenSyntax, inheritance: InheritanceClauseSyntax?,
                       members: MemberBlockSyntax, extension isExtension: Bool = false) {
        scope.append(name)
        let type = scope.joined(separator: ".")
        if !isExtension { declarations[type] = members }
        if inheritance?.inheritedTypes.contains(where: {
            $0.type.as(IdentifierTypeSyntax.self)?.name.text == "PreviewProvider"
                || $0.type.as(MemberTypeSyntax.self)?.name.text == "PreviewProvider"
        }) == true {
            providers.append((type, keyword, members))
        }
    }

    private func record(name: TokenSyntax, pound: TokenSyntax, arguments: LabeledExprListSyntax, body: ClosureExprSyntax?) {
        guard name.text == "Preview", pound.presence == .present else { return }
        let location = locations.location(for: pound.positionAfterSkippingLeadingTrivia)
        let label = arguments.first(where: { $0.label == nil })?
            .expression.as(StringLiteralExprSyntax.self)?.representedLiteralValue
        let closure = body ?? arguments.compactMap { $0.expression.as(ClosureExprSyntax.self) }.first
        let metadata = viewMetadata(closure.flatMap { singleExpression($0.statements) })
        macros.append(SourcePreview(
            kind: "macro", name: label ?? metadata.name, typeName: metadata.typeName,
            providerType: nil, providerBodyEnd: nil,
            childTypeNames: nil, hasSourceLocation: nil,
            filePath: filePath,
            line: location.line,
            column: location.column
        ))
    }
}

@main
private enum PreviewDiscovery {
    static func main() {
        guard CommandLine.arguments.count == 3 else {
            fail("Usage: PreviewDiscovery <source-buffer-file> <original-source-path>")
        }
        do {
            let source = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
            let tree = Parser.parse(source: source)
            let visitor = PreviewVisitor(filePath: CommandLine.arguments[2], tree: tree)
            visitor.walk(tree)
            let output = try JSONEncoder().encode(visitor.previews)
            FileHandle.standardOutput.write(output)
            FileHandle.standardOutput.write(Data("\n".utf8))
        } catch {
            fail("Could not discover source previews: \(error)")
        }
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("\(message)\n".utf8))
        exit(EXIT_FAILURE)
    }
}
