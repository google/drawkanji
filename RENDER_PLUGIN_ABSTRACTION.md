# Kanji Renderer Plugin Abstraction Specification

## 1. Vision & Architecture Goals

The primary goal of this refactoring is to decouple the core application engine (`app.js`, `animation_common.js`, `web_support.js`) and the Rust WebAssembly animator (`lib.rs`, `tessellator.rs`) from specific rendering technologies (Canvas 2D, WebGPU CPU Mesh Buffers, WebGPU GPU Compute). 

By establishing a **Plugin Architecture**, the core engine and the WASM animator become 100% agnostic to which rendering technique is active. Adding new renderers in the future (e.g., WebGL2, WebGPU Raytracing, SDF Shader Vector FX) can be accomplished simply by implementing the `KanjiRenderPlugin` interface without modifying the core animation loop, WASM animator state flags, or UI dispatcher logic.

---

## 2. Encapsulation Principles (Zero Engine & Animator Flags)

To guarantee complete separation of concerns and eliminate state leakage:

1. **Elimination of Animator Tessellation Flags**:
   - The `tessellation_enabled` flag and WASM functions `enable_tessellation()` / `disable_tessellation()` are completely removed from Rust (`src/lib.rs` & `src/tessellator.rs`).
   - The WASM `KanjiAnimator` operates deterministically. On `tick()`, it updates timing state and precomputed mesh structures unconditionally.
   - The WASM module has zero knowledge of which renderer is active or whether tessellation is performed on CPU vs GPU.

2. **Event-Driven Plugin Contract**:
   - The engine triggers uniform event hooks on the active renderer (`onStrokeFinishedDrying(idx)`, `updateBuffers()`, `onStepBackward(deletedIdx)`).
   - Renderers that require CPU vertex meshes (e.g. `WebGPUCPURenderer`) invoke WASM mesh getters during these event hooks.
   - Renderers that do not require CPU vertex meshes (e.g. `Canvas2DRenderer` or `WebGPUComputeRenderer`) implement these methods as no-ops or execute their own technique (e.g. GPU compute shader dispatches).

3. **Rendering Pipeline & Resource Ownership**:
   - Each plugin owns and manages its specific resources (e.g. CPU vertex buffers vs GPU compute storage buffers vs 2D canvas context state).

---

## 3. Audit of Existing Abstraction Leaks

A comprehensive audit of the codebase revealed several places where renderer-specific logic was hardcoded or exposed through global state:

1. **Frame Loop Branching (`animation_common.js`)**:
   `drawStrokesToCanvas()` explicitly branches on `AppState.renderMode === 'webgpu_compute'` vs `'webgpu_cpu'` vs `'canvas'`.
2. **Event Dispatch Branching (`app.js`)**:
   `handleFinishedDryingStroke()` branches on `renderMode` to delegate to `handleFinishedDryingStrokeCPU()` or `handleFinishedDryingStrokeCompute()`.
3. **Redundant GPU Resource Allocations (`app.js`, `web_support.js`)**:
   Resetting, resizing, or changing line weights calls both `updateStrokeGPUBuffers()` and `updateStrokeComputeBuffers()`, allocating GPU resources for inactive renderers.
4. **Direct Global Buffer Deallocations (`web_support.js`)**:
   `stepBackward()` manually inspects and destroys both `AppState.dryStrokeBuffers` and `AppState.dryStrokeComputeBuffers`.
5. **UI Capability & Mode Branching (`app.js`)**:
   Glow intensity and Anti-Aliasing UI control visibility, Rust tessellation toggles, and status badge text are directly driven by string comparisons on `renderMode`.

---

## 4. The `KanjiRenderPlugin` Interface Specification

The `KanjiRenderPlugin` abstract base class defines a strict contract that encapsulates 100% of renderer state, pipeline setup, event handling, buffer management, and multi-pass frame rendering.

```javascript
/**
 * Abstract Base Class defining the contract for all Kanji Rendering Plugins.
 * Guarantees 100% encapsulation for Canvas2D, WebGPU-CPU, WebGPU-Compute, and future renderers.
 */
export class KanjiRenderPlugin {
  /**
   * Unique renderer identifier ('canvas', 'webgpu_cpu', 'webgpu_compute', etc.).
   * @type {string}
   */
  get mode() {
    return 'base';
  }

  /**
   * Human-readable display string for top-right UI status badge.
   * @type {string}
   */
  get displayName() {
    return 'Unknown';
  }

  /**
   * Indicates whether this renderer supports Glow Intensity slider controls.
   * @type {boolean}
   */
  get supportsGlow() {
    return true;
  }

  /**
   * Indicates whether this renderer supports Anti-Aliasing controls.
   * @type {boolean}
   */
  get supportsAntiAliasing() {
    return true;
  }

  /**
   * Initializes pipelines, bind group layouts, shaders, or 2D offscreen canvas contexts.
   * @returns {Promise<void>}
   */
  async init() {}

  /**
   * Cleans up GPU buffers, pipeline instances, textures, or contexts when switching away or resetting.
   */
  destroy() {}

  /**
   * Uploads/tessellates static & guide stroke buffers on character load, line weight change, or reset.
   */
  updateBuffers() {}

  /**
   * Triggered when a stroke finishes drying during animation tick.
   * @param {number} idx - Index of the completed stroke.
   */
  onStrokeFinishedDrying(idx) {}

  /**
   * Triggered when stepping backward in animation to remove a dry stroke.
   * Cleans up GPU resources associated with the deleted stroke index.
   * @param {number} deletedIdx - Index of the deleted stroke.
   */
  onStepBackward(deletedIdx) {}

  /**
   * Handles canvas resize or anti-aliasing factor change events.
   * @param {number} width - Offscreen width.
   * @param {number} height - Offscreen height.
   * @param {number} aaFactor - Anti-aliasing scaling factor.
   */
  onResize(width, height, aaFactor) {}

  /**
   * Pass 1: Renders or computes stroke geometry onto the offscreen glyph texture or canvas.
   * @param {GPUCommandEncoder|null} [commandEncoder=null]
   */
  renderGlyph(commandEncoder = null) {}

  /**
   * Pass 2: Presents the offscreen glyph texture/canvas to the visible screen canvas.
   * @param {GPUCommandEncoder|null} [commandEncoder=null]
   */
  present(commandEncoder = null) {}
}
```

---

## 5. Concrete Renderer Implementations

### 5.1 `Canvas2DRenderer` (`animation_canvas.js`)
- **Properties**:
  - `mode`: `'canvas'`
  - `displayName`: `'2D Fallback'`
  - `supportsGlow`: `false`
  - `supportsAntiAliasing`: `false`
- **Behavior**:
  - `renderGlyph()`: Draws background, guide strokes, completed colored strokes, active path animated dashes, tip history, and radial glow using native 2D Canvas API onto `AppState.glyphCanvas`.
  - `present()`: Scales and blits `AppState.glyphCanvas` to `AppState.visibleCtx`.
  - `init()`, `destroy()`, `updateBuffers()`, `onStrokeFinishedDrying()`, `onStepBackward()`, `onResize()`: Default no-op implementations (no GPU state or tessellation needed).

### 5.2 `WebGPUCPURenderer` (`animation_webgpu_cpu.js`)
- **Properties**:
  - `mode`: `'webgpu_cpu'`
  - `displayName`: `'WebGPU (CPU)'`
  - `supportsGlow`: `true`
  - `supportsAntiAliasing`: `true`
- **Behavior**:
  - `updateBuffers()`: Copies precomputed guide stroke meshes from WASM memory (`get_guide_stroke_ptr`) into WebGPU vertex buffers (`guideStrokeBuffers`).
  - `onStrokeFinishedDrying(idx)`: Calls `AppState.animator.tessellate_dry_stroke(idx)` to build CPU mesh, reads dry stroke vertices from WASM memory for stroke `idx`, and uploads to `dryStrokeBuffers[idx]`.
  - `onStepBackward(deletedIdx)`: Destroys `dryStrokeBuffers[deletedIdx]`.
  - `renderGlyph(commandEncoder)`: Reads `AppState.animator.get_vertices_ptr()` for the active stroke mesh, uploads to `drawVertexBuffer`, and encodes a render pass into `glyphTextureView` drawing guide buffers, dry stroke buffers, and active vertex buffers.
  - `present(commandEncoder)`: Encodes a screen render pass drawing `glyphTextureView` onto full-screen quad using screen glassmorphism shader (`AppState.pipeline`).

### 5.3 `WebGPUComputeRenderer` (`animation_webgpu_compute.js`)
- **Properties**:
  - `mode`: `'webgpu_compute'`
  - `displayName`: `'WebGPU (Compute)'`
  - `supportsGlow`: `true`
  - `supportsAntiAliasing`: `true`
- **Behavior**:
  - `updateBuffers()`: Uploads control points to storage buffer, dispatches `cs_guide` compute pass, and dispatches dry compute passes for already dry strokes.
  - `onStrokeFinishedDrying(idx)`: Dispatches `cs_dry_stroke` compute shader to generate dry mesh directly in a VRAM storage buffer.
  - `onStepBackward(deletedIdx)`: Destroys `dryStrokeComputeBuffers[deletedIdx]`.
  - `renderGlyph(commandEncoder)`: Dispatches `cs_main` & comet compute passes to generate vertex geometry in VRAM, then encodes render pass drawing generated storage buffers into `glyphTextureView`.
  - `present(commandEncoder)`: Encodes screen pass sampling `glyphTextureView` onto screen quad using WebGPU presentation pipeline.

---

## 6. Zero-Leak Engine Integration

### 6.1 Main Frame Loop (`app.js`)
The frame loop eliminates all `renderMode` string checks and tessellation flags:

```javascript
function frame(now) {
  const dt = (now - lastTime) / 1000;
  lastTime = now;

  let needsRedraw = false;
  if (AppState.animator) {
    const finishedIdx = AppState.animator.tick(dt);
    if (finishedIdx >= 0) {
      AppState.activeRenderer.onStrokeFinishedDrying(finishedIdx);
      needsRedraw = true;
    }
    AppState.animTime = AppState.animator.anim_time();

    if (wasAnimating && !AppState.animator.is_animating() && !AppState.animator.is_single_stroke_animating()) {
      triggerSparkleAnimation();
    }

    if (AppState.animator.is_animating() || AppState.animator.is_any_stroke_drying() || AppState.animator.stroke_progress() > 0.0) {
      needsRedraw = true;
    }

    if (needsRedraw) {
      drawStrokesToCanvas();
    }
    
    updateStrokeDisplay();
    updateControlsState();
  }

  const isWebGPU = AppState.activeRenderer.mode !== 'canvas';
  const commandEncoder = isWebGPU ? AppState.device.createCommandEncoder() : null;

  AppState.activeRenderer.renderGlyph(commandEncoder);
  AppState.activeRenderer.present(commandEncoder);

  if (isWebGPU && commandEncoder) {
    AppState.device.queue.submit([commandEncoder.finish()]);
  }

  requestAnimationFrame(frame);
}
```

### 6.2 Renderer Plugin Lifecycle Switcher (`app.js`)
Switching renderers cleanly tears down previous state, invokes `init()` on the new renderer, and queries plugin getters for UI capability toggles:

```javascript
export function setRenderingMode(mode) {
  if (!AppState.webgpuSupported) {
    mode = 'canvas';
  }

  if (AppState.activeRenderer) {
    AppState.activeRenderer.destroy();
  }

  AppState.activeRenderer = AppState.renderers[mode];
  AppState.renderMode = mode;

  AppState.activeRenderer.init();

  if (mode === 'canvas') {
    AppState.webgpuEnabled = false;
    resetCanvasContext('2d');
  } else {
    AppState.webgpuEnabled = true;
    resetCanvasContext('webgpu');
  }

  // Update UI badge & control visibilities dynamically from plugin contract
  AppState.statusBadge.className = AppState.webgpuEnabled ? 'gpu-status-badge connected' : 'gpu-status-badge disabled';
  AppState.statusBadge.querySelector('.status-text').innerText = AppState.activeRenderer.displayName;

  if (AppState.elGlowControl) {
    AppState.elGlowControl.classList.toggle('hidden', !AppState.activeRenderer.supportsGlow);
  }
  if (AppState.elAAControl) {
    AppState.elAAControl.classList.toggle('hidden', !AppState.activeRenderer.supportsAntiAliasing);
  }

  AppState.activeRenderer.updateBuffers();
  drawStrokesToCanvas();
}
```

### 6.3 Unified Drawing Proxy (`animation_common.js`)
```javascript
export function drawStrokesToCanvas(commandEncoder = null) {
  if (AppState.activeRenderer) {
    AppState.activeRenderer.renderGlyph(commandEncoder);
  }
}
```

### 6.4 Unified Step-Backward Handler (`web_support.js`)
```javascript
function stepBackward() {
  if (!AppState.animator) return;
  const deletedIdx = AppState.animator.step_backward();
  if (deletedIdx >= 0 && AppState.activeRenderer) {
    AppState.activeRenderer.onStepBackward(deletedIdx);
  }
  drawStrokesToCanvas();
  updateStrokeDisplay();
  updateControlsState();
}
```

---

## 7. Implementation Action Plan

| Step | File | Description |
| :--- | :--- | :--- |
| **1** | `src/lib.rs` & `src/tessellator.rs` | Remove `tessellation_enabled` flag and `enable_tessellation()` / `disable_tessellation()` functions from WASM animator. Run `./build.sh`. |
| **2** | `animation_plugin.js` | Create the base `KanjiRenderPlugin` class. |
| **3** | `animation_canvas.js` | Refactor into `Canvas2DRenderer` class extending `KanjiRenderPlugin`. |
| **4** | `animation_webgpu_cpu.js` | Refactor into `WebGPUCPURenderer` class extending `KanjiRenderPlugin`. Call WASM CPU mesh functions on `onStrokeFinishedDrying()` and `renderGlyph()`. |
| **5** | `animation_webgpu_compute.js` | Refactor into `WebGPUComputeRenderer` class extending `KanjiRenderPlugin`. Dispatches WGSL compute shaders on `onStrokeFinishedDrying()` and `renderGlyph()`. |
| **6** | `animation_common.js` | Add `AppState.activeRenderer` and `AppState.renderers` map; update `drawStrokesToCanvas()`. |
| **7** | `app.js` | Instantiates renderers, wire `setRenderingMode` and `frame()` to use `AppState.activeRenderer`. |
| **8** | `web_support.js` | Update `stepBackward` to call `AppState.activeRenderer.onStepBackward(deletedIdx)`. |

---

## 8. Verification Strategy

1. **Feature Parity Test**: Verify all 3 modes (`webgpu_compute`, `webgpu_cpu`, `canvas`) render guide strokes, wet strokes, dry strokes, tip glow, and comet trails identically to current behavior.
2. **Renderer Switch Test**: Cycle between renderers dynamically and verify zero memory leaks, GPU error logs, or leftover visual artifacts.
3. **Interactive Control Test**: Verify step-forward, step-backward (undo), and stroke animation restart behave correctly across all renderers.
