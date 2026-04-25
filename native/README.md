# MMM Native Host (C++)

This app runs MMM inside a native webview and exposes `window.mmmHost` for high-performance filesystem/config operations.

## Features
- Native desktop shell via `webview`.
- `mmmHost.invoke(action, payload)` bridge compatible with `ui/MJSI.js`.
- Threaded backend pools for async IO-heavy work.
- Native config persistence in:
  - `~/.config/mmm/config_kv.json`
  - `~/.config/mmm/config_structured.json`
- Native filesystem state persistence in:
  - `~/.local/share/mmm/state/filesystem_snapshot.json`
- Live watcher emits `fs.changed` events back to JS.

## Build (Linux)

Install required system packages first.

Arch Linux:

```bash
sudo pacman -S --needed webkit2gtk-4.1 gtk3 pkgconf cmake base-devel
```

Debian/Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev pkg-config cmake build-essential
```

Fedora:

```bash
sudo dnf install -y webkit2gtk4.1-devel gtk3-devel pkgconf-pkg-config cmake gcc-c++ make
```

```bash
cmake -S . -B build
cmake --build build -j
```

## Run

From the project root:

```bash
./build/native/mmm_native /home/sm/Desktop/MMM
```

Or use the helper launcher:

```bash
./native/run_mmm.sh
```

If no argument is passed, the current working directory is used as workspace root.

## Bridge Actions Implemented
- `config.getAll`
- `config.set`
- `config.remove`
- `config.writeStructured`
- `fs.snapshot`
- `fs.seed`
- `fs.applyOperation`

## Notes
- Current JS runtime still applies local mutations first, then `fs.applyOperation` persists/propagates native state.
- `FsService` maps virtual `/Home/...` to the real user home folder and scans recursively with depth and entry limits.
- Watcher interval is 3 seconds and emits full snapshot updates.
- If you see `Couldn't find any known WebKitGTK API`, the WebKitGTK development package is missing; install the distro packages above.
