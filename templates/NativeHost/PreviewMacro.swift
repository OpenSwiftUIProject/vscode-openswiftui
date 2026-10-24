#if OPENSWIFTUI_STANDALONE_PREVIEW
import DeveloperToolsSupport
import OpenSwiftUI
import OpenSwiftUICore

// A local declaration selects the standalone plugin without replacing the package plugin.
@freestanding(declaration)
macro Preview(
    _ name: String? = nil,
    @OpenSwiftUICore.ViewBuilder body: @escaping @MainActor () -> any OpenSwiftUICore.View
) = #externalMacro(module: "OpenSwiftUIPreviewMacros", type: "PreviewMacro")

@freestanding(declaration)
macro Preview(
    _ name: String? = nil,
    traits: DeveloperToolsSupport.PreviewTrait<DeveloperToolsSupport.Preview.ViewTraits>,
    _ additionalTraits: DeveloperToolsSupport.PreviewTrait<DeveloperToolsSupport.Preview.ViewTraits>...,
    @OpenSwiftUICore.ViewBuilder body: @escaping @MainActor () -> any OpenSwiftUICore.View
) = #externalMacro(module: "OpenSwiftUIPreviewMacros", type: "PreviewMacro")
// Inserted into a provider's own scope in an isolated compiler source overlay.
@freestanding(declaration, names: arbitrary)
macro _OpenSwiftUIPreviewProvider(
    _ provider: Any.Type,
    filePath: String,
    line: Int,
    column: Int,
    typeName: String? = nil,
    childTypeNames: [String]? = nil
) = #externalMacro(module: "OpenSwiftUIPreviewMacros", type: "PreviewProviderMacro")
#endif
