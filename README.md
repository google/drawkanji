# Kanji Stroke Order Visualizer (WebGPU / Canvas)

A high-performance, real-time Japanese Kanji stroke order animator featuring a modern glassmorphic dark UI, dual rendering pipelines (WebGPU with glowing shaders + HTML5 Canvas fallback), and an interactive control panel.

---

## 🛠️ Project Structure

The project splits rendering and DOM orchestration into a modular, cache-busted subsystem structure:

*   **[index.html](index.html)**: Main HTML5 UI page and DOM structure.
*   **[styles.css](styles.css)**: Glassmorphic UI design stylesheet.
*   **[app.js](app.js)**: Main entry point, renderer plugin initialization, and
    animation frame loop.
*   **[animation_common.js](animation_common.js)**: Global state object
    (`AppState`), SVG loader, and shared layout updates.
*   **[animation_archive.js](animation_archive.js)**: Binary trie archive
    unpacker and parser for `kanjivg.bin`.
*   **[animation_webgpu.js](animation_webgpu.js)**: WebGPU context setups, WGSL
    shader codes, pipeline structures, and VRAM vertex buffers.
*   **[animation_canvas.js](animation_canvas.js)**: Canvas 2D fallback rendering
    routines.
*   **[web_support.js](web_support.js)**: UI slider listeners, playback
    controller click hooks, and sharing handlers.
*   **[src/](src/) (Rust)**: Source files for the animation timing engine and
    stroke extrusion geometry calculations.
*   **[tools/](tools/)**: Build helpers (`build_kanjivg_archive.py`,
    `encode_wasm_bytes.py`, `build_wasm.sh`), toolchain installer
    (`setup_toolchain.sh`), and end-to-end container validation script
    (`validate_top_down_build.sh`).

---

## 🔨 Building with Make

From the `drawkanji` directory (after installing dependencies with
`./tools/setup_toolchain.sh`):

### 1. Build All Deliverables

```bash
make
```

> **Generated Artifacts**:
> - WebAssembly runtime & JS bindings: `pkg/drawkanji_wasm_bin.js`,
>   `pkg/drawkanji_wasm_bin_bg.wasm`
> - In-memory WASM bytes module: `pkg/drawkanji_wasm_bytes.js`
> - KanjiVG binary trie archive: `kanjivg.bin` (if `kanjivg.bin` is already
>   present in the directory, `make` reuses it without re-downloading the
>   KanjiVG release zip)

### 2. Build and Deploy to a Target Directory

To build and stage all web-facing files (`*.html`, `*.css`, `*.js`, `pkg/*`,
and `kanjivg/kanjivg.bin`) into a deployment directory:

```bash
make deploy DEPLOY_DIR=/tmp/drawkanji_webout
```

---

## ⚡ Serving Locally

WebGPU requires a secure context (such as `http://localhost/` or
`http://127.0.0.1/`):

```bash
make deploy DEPLOY_DIR=/tmp/drawkanji_webout
python3 -m http.server 8000 \
  --directory /tmp/drawkanji_webout \
  --bind 127.0.0.1
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000) in your browser.

---

## 🎨 Rendering Details

For a detailed look at the math behind polyline stroke extrusion into triangle
meshes, or the dual-pass WebGPU composite shader pipelines, please check
**[RENDER_GUIDE.md](RENDER_GUIDE.md)**.

---

## 🔒 Security & Disclaimer

Eligibility for the [Google Open Source Software Vulnerability Rewards Program](https://bughunters.google.com/open-source-security) is determined by the [Google Open Source Software Vulnerability Reward Program Rules](https://bughunters.google.com/about/rules/open-source/google-open-source-software-vulnerability-reward-program-rules).

This project is intended for demonstration purposes only. It is not intended for use in a production environment.
