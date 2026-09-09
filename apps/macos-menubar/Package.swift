// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CodexMultiAuthQuota",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "CodexMultiAuthQuota", targets: ["CodexMultiAuthQuota"]),
    ],
    targets: [
        .executableTarget(name: "CodexMultiAuthQuota"),
        .testTarget(
            name: "CodexMultiAuthQuotaTests",
            dependencies: ["CodexMultiAuthQuota"]
        ),
    ]
)
