//
//  PreviewMacro.swift
//  OpenSwiftUIPreviewMacros
//
//  Based on OpenSwiftUI PreviewMacro at aefa4e6edc9c37a992a0cf9c6cf317fb670ed305.
//  See LICENSE for the original license.

import SwiftSyntax
import SwiftSyntaxBuilder
import SwiftSyntaxMacros

public struct PreviewMacro: DeclarationMacro {
    public static func expansion(
        of node: some FreestandingMacroExpansionSyntax,
        in context: some MacroExpansionContext
    ) throws -> [DeclSyntax] {
        var arguments = Array(node.arguments)
        let trailingClosure: ClosureExprSyntax?

        if let body = node.trailingClosure {
            trailingClosure = wrappedBody(body)
        } else if let bodyIndex = arguments.lastIndex(where: { $0.label?.text == "body" }) {
            arguments[bodyIndex].expression = ExprSyntax(wrappedBody(arguments[bodyIndex].expression))
            trailingClosure = nil
        } else {
            throw MacroExpansionErrorMessage("#Preview requires a view body")
        }

        guard let sourceLocation = context.location(
            of: node.pound,
            at: .afterLeadingTrivia,
            filePathMode: .fileID
        ) else {
            throw MacroExpansionErrorMessage("#Preview could not determine its source location")
        }

        let preview = FunctionCallExprSyntax(
            calledExpression: DeclReferenceExprSyntax(
                moduleSelector: ModuleSelectorSyntax(
                    moduleName: .identifier("DeveloperToolsSupport")
                ),
                baseName: .identifier("Preview")
            ),
            leftParen: node.leftParen,
            arguments: LabeledExprListSyntax(arguments),
            rightParen: node.rightParen,
            trailingClosure: trailingClosure,
            additionalTrailingClosures: node.additionalTrailingClosures
        )

        // Xcode matches the registry to the source-level #Preview expansion.
        // A nested platform #Preview gives the registry a different expansion
        // identity, so emit the registry from this first expansion instead.
        let registryName = context.makeUniqueName("PreviewRegistry")
        let registry: DeclSyntax =
            """
            @available(iOS 17.0, macOS 14.0, tvOS 17.0, visionOS 1.0, watchOS 10.0, *)
            struct \(registryName): DeveloperToolsSupport::PreviewRegistry {
                static var fileID: Swift::String {
                    \(sourceLocation.file)
                }
                static var line: Swift::Int {
                    \(sourceLocation.line)
                }
                static var column: Swift::Int {
                    \(sourceLocation.column)
                }

                static func makePreview() throws -> DeveloperToolsSupport::Preview {
                    \(preview)
                }
            }
            """
        let standalone = standaloneRegistry(node, context: context, sourceLocation: sourceLocation)
        return ["""
            #if OPENSWIFTUI_STANDALONE_PREVIEW
            \(standalone)
            #else
            \(registry)
            #endif
            """]
    }

    private static func standaloneRegistry(
        _ node: some FreestandingMacroExpansionSyntax,
        context: some MacroExpansionContext,
        sourceLocation: AbstractSourceLocation
    ) -> DeclSyntax {
        if node.arguments.contains(where: { $0.label?.text == "traits" }) {
            return "#error(\"Standalone OpenSwiftUI previews do not support preview traits yet. Remove the traits argument.\")"
        }
        if context.lexicalContext.contains(where: { syntax in
            if let declaration = syntax.as(StructDeclSyntax.self) { return declaration.genericParameterClause != nil }
            if let declaration = syntax.as(ClassDeclSyntax.self) { return declaration.genericParameterClause != nil }
            if let declaration = syntax.as(EnumDeclSyntax.self) { return declaration.genericParameterClause != nil }
            return false
        }) {
            return "#error(\"Standalone OpenSwiftUI previews cannot be declared inside a generic type.\")"
        }
        let body = node.trailingClosure.map(ExprSyntax.init)
            ?? node.arguments.last(where: { $0.label?.text == "body" })!.expression
        let content: ClosureExprSyntax
        if var closure = body.as(ClosureExprSyntax.self) {
            let statements = ClosureExprSyntax(statements: closure.statements)
            closure.statements = CodeBlockItemListSyntax([
                CodeBlockItemSyntax(item: .expr("OpenSwiftUI::AnyView(OpenSwiftUI::Group \(statements))"))
            ])
            content = closure
        } else {
            let expression: ExprSyntax = "{ OpenSwiftUI::AnyView((\(body))()) }"
            content = expression.cast(ClosureExprSyntax.self)
        }
        let name = node.arguments.first(where: { $0.label == nil })?.expression ?? ExprSyntax("nil")
        let displayName = rootDisplayName(body) ?? ExprSyntax("nil")
        let typeName = inferredViewType(body).map { ExprSyntax(StringLiteralExprSyntax(content: $0)) } ?? ExprSyntax("nil")
        guard let filePath = context.location(of: node.pound, at: .afterLeadingTrivia, filePathMode: .filePath)?.file else {
            return "#error(\"#Preview could not determine its source path\")"
        }
        let registryName = context.makeUniqueName("OpenSwiftUIPreviewCase")
        return """
            @MainActor
            final class \(registryName): OpenSwiftUIPreviewCase {
                override class var fileID: Swift::String { \(sourceLocation.file) }
                override class var filePath: Swift::String { \(filePath) }
                override class var line: Swift::Int { return #line }
                override class var column: Swift::Int { return #column }
                override class var name: Swift::String? { (\(name)) ?? (\(displayName)) ?? typeName }
                override class var typeName: Swift::String? { \(typeName) }
                override class func makeView() -> OpenSwiftUI::AnyView {
                    (\(content))()
                }
            }
            """
    }

    private static func rootDisplayName(_ body: ExprSyntax) -> ExprSyntax? {
        var expression = body
        var hasCaptures = false
        if let closure = body.as(ClosureExprSyntax.self) {
            guard closure.statements.count == 1, let item = closure.statements.first else { return nil }
            hasCaptures = closure.signature?.capture != nil
            if let value = item.item.as(ExprSyntax.self) { expression = value }
            else if let statement = item.item.as(ReturnStmtSyntax.self), let value = statement.expression { expression = value }
            else { return nil }
        }
        while let call = expression.as(FunctionCallExprSyntax.self),
              let member = call.calledExpression.as(MemberAccessExprSyntax.self), let base = member.base {
            if member.declName.baseName.text == "previewDisplayName", let value = call.arguments.first?.expression {
                if hasCaptures {
                    guard let literal = value.as(StringLiteralExprSyntax.self),
                          literal.segments.allSatisfy({ $0.is(StringSegmentSyntax.self) }) else { return nil }
                }
                return value
            }
            expression = base
        }
        return nil
    }

    private static func inferredViewType(_ body: ExprSyntax) -> String? {
        if let closure = body.as(ClosureExprSyntax.self) {
            guard closure.statements.count == 1, let item = closure.statements.first else { return nil }
            if let expression = item.item.as(ExprSyntax.self) { return inferredViewType(expression) }
            if let statement = item.item.as(ReturnStmtSyntax.self), let expression = statement.expression { return inferredViewType(expression) }
            return nil
        }
        if let call = body.as(FunctionCallExprSyntax.self) {
            if let member = call.calledExpression.as(MemberAccessExprSyntax.self), let base = member.base,
               base.is(FunctionCallExprSyntax.self) || base.is(MemberAccessExprSyntax.self) {
                return inferredViewType(base)
            }
            let name = call.calledExpression.trimmedDescription
            let leaf = name.split(separator: ".").last.map(String.init) ?? name
            if leaf == "Group", let content = call.trailingClosure { return inferredViewType(ExprSyntax(content)) }
            guard leaf.first?.isUppercase == true, !["AnyView", "ModifiedContent", "Group"].contains(leaf) else { return nil }
            return name
        }
        if let member = body.as(MemberAccessExprSyntax.self), let base = member.base {
            if let reference = base.as(DeclReferenceExprSyntax.self), reference.baseName.text.first?.isUppercase == true {
                return reference.baseName.text
            }
            return inferredViewType(base)
        }
        return nil
    }

    private static func wrappedBody(_ body: ExprSyntax) -> ClosureExprSyntax {
        guard let closure = body.as(ClosureExprSyntax.self) else {
            // A referenced body returns an existential View, so erase its
            // result to a concrete root before creating the hosting controller.
            let wrappedBody: ExprSyntax = """
                {
                    OpenSwiftUI::AnyView((\(body))())
                        ._previewVC()
                }
                """
            return wrappedBody.as(ClosureExprSyntax.self)!
        }
        return wrappedBody(closure)
    }

    private static func wrappedBody(_ body: ClosureExprSyntax) -> ClosureExprSyntax {
        let content = ClosureExprSyntax(statements: body.statements)
        let group = FunctionCallExprSyntax(
            callee: DeclReferenceExprSyntax(
                moduleSelector: ModuleSelectorSyntax(moduleName: .identifier("OpenSwiftUI")),
                baseName: .identifier("Group")
            ),
            trailingClosure: content
        )
        let previewVC = FunctionCallExprSyntax(
            callee: MemberAccessExprSyntax(
                base: group,
                period: .periodToken(leadingTrivia: .newline),
                declName: DeclReferenceExprSyntax(baseName: .identifier("_previewVC"))
            )
        )
        var wrappedBody = body
        wrappedBody.statements = CodeBlockItemListSyntax([
            CodeBlockItemSyntax(item: .expr(ExprSyntax(previewVC)))
        ])
        return wrappedBody.formatted().cast(ClosureExprSyntax.self)
    }
}


public struct PreviewProviderMacro: DeclarationMacro {
    public static func expansion(
        of node: some FreestandingMacroExpansionSyntax,
        in context: some MacroExpansionContext
    ) throws -> [DeclSyntax] {
        guard let provider = node.arguments.first(where: { $0.label == nil })?.expression,
              let filePath = node.arguments.first(where: { $0.label?.text == "filePath" })?.expression,
              let line = node.arguments.first(where: { $0.label?.text == "line" })?.expression,
              let column = node.arguments.first(where: { $0.label?.text == "column" })?.expression,
              let location = context.location(of: node.pound, at: .afterLeadingTrivia, filePathMode: .fileID) else {
            throw MacroExpansionErrorMessage("PreviewProvider registration requires its original source location")
        }
        if context.lexicalContext.contains(where: { syntax in
            if let declaration = syntax.as(StructDeclSyntax.self) { return declaration.genericParameterClause != nil }
            if let declaration = syntax.as(ClassDeclSyntax.self) { return declaration.genericParameterClause != nil }
            if let declaration = syntax.as(EnumDeclSyntax.self) { return declaration.genericParameterClause != nil }
            if let declaration = syntax.as(ActorDeclSyntax.self) { return declaration.genericParameterClause != nil }
            return false
        }) {
            throw MacroExpansionErrorMessage("Standalone PreviewProvider declarations cannot be inside a generic type")
        }
        let fallback = node.arguments.first(where: { $0.label?.text == "typeName" })?.expression ?? ExprSyntax("nil")
        let childFallbacks = node.arguments.first(where: { $0.label?.text == "childTypeNames" })?.expression ?? ExprSyntax("nil")
        let typeExpression = provider.trimmedDescription
        let providerType = typeExpression.hasSuffix(".self") ? String(typeExpression.dropLast(5)) : typeExpression
        let registryName = context.makeUniqueName("OpenSwiftUIProviderPreviewCase")
        return ["""
            @MainActor
            final class \(registryName): OpenSwiftUIPreviewCase {
                override class var fileID: Swift::String { \(location.file) }
                override class var filePath: Swift::String { \(filePath) }
                override class var line: Swift::Int { \(line) }
                override class var column: Swift::Int { \(column) }
                override class var entries: [OpenSwiftUIPreviewEntry] {
                    let previews = (\(provider))._allPreviews
                    let childTypeNames: [Swift::String]? = \(childFallbacks)
                    return previews.enumerated().map { index, preview in
                        let fallback: Swift::String? = childTypeNames?.count == previews.count
                            ? childTypeNames?[index] : (previews.count == 1 ? \(fallback) : nil)
                        let typeName: Swift::String? = ["Element", "_VariadicView.Children.Element"].contains(preview.contentType)
                            ? fallback : preview.contentType
                        return OpenSwiftUIPreviewEntry(
                            id: "\\(id):provider:\\(preview.id)", name: preview.displayName ?? typeName,
                            kind: "provider", typeName: typeName, providerType: \(literal: providerType),
                            fileID: fileID, filePath: filePath, line: line, column: column,
                            makeContent: { preview.content }
                        )
                    }
                }
            }
            """]
    }
}
