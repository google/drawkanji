# Make & WebAssembly Rust Toolchain Documentation

This document describes the compilation toolchain required to build DrawKanji
(including compiling the Rust animator state machine and geometry tessellator to
WebAssembly and packaging the KanjiVG binary trie archive) with GNU Make.

---

## 🛠️ Toolchain Components

To build this project, the following tools are installed by
[`tools/setup_toolchain.sh`](tools/setup_toolchain.sh):

### 1. GNU Make (`make`)

*   **Role**: Orchestrates the build via [`Makefile`](Makefile), downloading
    the KanjiVG SVG release archive (when `kanjivg.bin` is not already present),
    compiling the Rust WASM binary via
    [`tools/build_wasm.sh`](tools/build_wasm.sh), generating JS bindings,
    encoding the in-memory WASM payload, and deploying the web bundle via
    `make deploy DEPLOY_DIR=...`.

### 2. Rust Compiler (`rustc`) & `wasm32-unknown-unknown` Target

*   **Role**: Compiles the Rust source code (`src/`) into
    `wasm32-unknown-unknown` WebAssembly bytecode (`cdylib`).

### 3. WASM Bindgen CLI (`wasm-bindgen`)

*   **Role**: Generates the browser JavaScript bindings
    (`pkg/drawkanji_wasm_bin.js` and `pkg/drawkanji_wasm_bin_bg.wasm`) from the
    compiled WebAssembly module.

---

## 🚀 Execution & Usage

### 1. Installation

To install Make and the Rust/WASM compilation toolchain (supports Linux via
`apt-get`, rootless Linux containers, and macOS via `rustup` / GitHub Releases):

```bash
chmod +x tools/setup_toolchain.sh
./tools/setup_toolchain.sh
```

### 2. Compilation & Deployment

To build all deliverables (`pkg/drawkanji_wasm_bin.js`,
`pkg/drawkanji_wasm_bin_bg.wasm`, `pkg/drawkanji_wasm_bytes.js`, and
`kanjivg.bin`):

```bash
make
```

If `kanjivg.bin` is already present in the source root, `make` uses it directly
without downloading the KanjiVG SVG release archive.

To stage all web deliverables into a target directory:

```bash
make deploy DEPLOY_DIR=/tmp/drawkanji_webout
```

### 3. Top-Down Container Validation

To validate both build modes (building `kanjivg.bin` from the KanjiVG GitHub
release and rebuilding with a prebuilt `kanjivg.bin` in the source tree without
downloading KanjiVG) inside an isolated container in a clean temporary
workspace, and optionally install Docker (`--get-docker`) or deploy the final
build and web assets to a target directory (`--deploy <target_directory>`):

```bash
chmod +x tools/validate_top_down_build.sh
./tools/validate_top_down_build.sh [--get-docker] [--deploy <target_directory>]
```
