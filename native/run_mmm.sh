#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build"

need_pkg() {
	pkg-config --exists "$1"
}

print_missing_deps_help() {
	echo "Missing required WebKitGTK development packages for webview." >&2
	echo "Install dependencies, then rerun ./native/run_mmm.sh" >&2
	echo >&2
	if command -v pacman >/dev/null 2>&1; then
		echo "Arch Linux:" >&2
		echo "  sudo pacman -S --needed webkit2gtk-4.1 gtk3 pkgconf cmake base-devel" >&2
	elif command -v apt-get >/dev/null 2>&1; then
		echo "Debian/Ubuntu:" >&2
		echo "  sudo apt-get update" >&2
		echo "  sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev pkg-config cmake build-essential" >&2
	elif command -v dnf >/dev/null 2>&1; then
		echo "Fedora:" >&2
		echo "  sudo dnf install -y webkit2gtk4.1-devel gtk3-devel pkgconf-pkg-config cmake gcc-c++ make" >&2
	else
		echo "Install WebKitGTK + GTK3 dev packages for your distro and ensure pkg-config can find them." >&2
	fi
}

echo "[MMM native] Checking system dependencies..."
if ! command -v pkg-config >/dev/null 2>&1; then
	echo "pkg-config is required but was not found." >&2
	print_missing_deps_help
	exit 1
fi

if ! need_pkg webkit2gtk-4.1 && ! need_pkg webkit2gtk-4.0 && ! need_pkg webkitgtk-6.0; then
	print_missing_deps_help
	exit 1
fi

echo "[MMM native] Configuring CMake..."
cmake -S "$ROOT_DIR" -B "$BUILD_DIR"
echo "[MMM native] Building..."
cmake --build "$BUILD_DIR" -j

echo "[MMM native] Launching app..."
"$BUILD_DIR/native/mmm_native" "$ROOT_DIR"
