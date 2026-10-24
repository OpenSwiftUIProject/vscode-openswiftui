"""Check macOS host sizing against an existing SwiftPM binary artifact directory."""

import argparse
import json
import platform
import subprocess
import tempfile
from pathlib import Path


def run(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    args = parser.parse_args()
    if platform.system() != "Darwin":
        parser.error("This check requires macOS and Xcode.")
    frameworks = sorted(args.artifacts.resolve().glob("*/*.xcframework/macos-*/*.framework"))
    if not any(framework.stem == "OpenSwiftUI" for framework in frameworks):
        parser.error("No macOS OpenSwiftUI framework was found in the artifact directory.")

    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="openswiftui-host-sizing-") as temporary:
        output = Path(temporary)
        executable = output / "PreviewSizing"
        command = [
            "xcrun", "--sdk", "macosx", "swiftc", "-parse-as-library",
            "-target", f"{platform.machine()}-apple-macos15.0",
            "-module-cache-path", str(output / "ModuleCache"),
        ]
        for framework in frameworks:
            directory = str(framework.parent)
            command += ["-F", directory, "-Xlinker", "-rpath", "-Xlinker", directory]
        command += [
            str(root / "templates/NativeHost/PreviewApp.swift"),
            str(root / "test/fixtures/NativeHostSizing.swift"),
            "-o", str(executable),
        ]
        run(command)
        for case in ["intrinsic", "fixed", "flexible", "empty"]:
            result = run([str(executable), case])
            records = [json.loads(line.removeprefix("PREVIEW_SIZE_RESULT:"))
                       for line in result.splitlines() if line.startswith("PREVIEW_SIZE_RESULT:")]
            if not records:
                raise RuntimeError(f"No window measurements were reported for {case}.")
            for record in records:
                print(json.dumps(record), flush=True)


if __name__ == "__main__":
    main()
