// swift-tools-version: 6.3

import PackageDescription

let package = Package(
    name: "DemoKit",
    platforms: [.macOS(.v15), .iOS(.v18)],
    products: [
        .library(name: "DemoKit", targets: ["DemoKit"]),
    ],
    dependencies: [
        .package(url: "https://github.com/OpenSwiftUIProject/OpenSwiftUI-spm", exact: "0.24.3"),
    ],
    targets: [
        .target(
            name: "DemoKit",
            dependencies: [.product(name: "OpenSwiftUI", package: "OpenSwiftUI-spm")]
        ),
    ]
)
