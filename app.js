// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

async function initApp() {
  if (typeof wasm_bindgen !== 'undefined' &&
      typeof wasm_bindgen.initSync === 'function') {
    const wasmExports = wasm_bindgen.initSync({module: window.WASM_BYTES});
    AppState.wasmInstanceMemory =
        wasm_bindgen.wasm ? wasm_bindgen.wasm.memory : wasmExports.memory;
    AppState.animator = new wasm_bindgen.KanjiAnimator();
  } else if (typeof Module !== 'undefined') {
    if (!Module.KanjiAnimator) {
      await new Promise((resolve) => {
        const prev = Module.onRuntimeInitialized;
        Module.onRuntimeInitialized = () => {
          if (prev) prev();
          resolve();
        };
      });
    }
    AppState.wasmInstanceMemory = Module.wasmMemory || { buffer: Module.HEAPU8.buffer };
    AppState.animator = new Module.KanjiAnimator();
  }

  // Instantiate Renderer Plugins
  AppState.renderers = {
    canvas: new Canvas2DRenderer(),
    webgpu_cpu: new WebGPUCPURenderer(),
    webgpu_compute: new WebGPUComputeRenderer()
  };

  // Bind UI Elements and Set callbacks
  setupUI(
    // onResetCallback
    () => {
      if (AppState.activeRenderer) {
        AppState.activeRenderer.updateBuffers();
      }
    },
    // onAAChangeCallback
    (factor) => {
      AppState.antiAliasingFactor = factor;
      recreateGlyphTexture(factor);
      if (AppState.activeRenderer) {
        AppState.activeRenderer.updateBuffers();
      }
      drawStrokesToCanvas();
    }
  );

  // 2D Offscreen Canvas for Stroke Vector Rendering
  const glyphSize = 512;
  AppState.glyphCanvas = document.createElement('canvas');
  AppState.glyphCanvas.width = glyphSize;
  AppState.glyphCanvas.height = glyphSize;
  AppState.glyphCtx = AppState.glyphCanvas.getContext('2d');

  // WebGPU Support Verification
  if (!navigator.gpu) {
    initCanvasFallback();
  } else {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        throw new Error('No appropriate GPU adapter found');
      }
      AppState.device = await adapter.requestDevice();
      AppState.device.lost.then((info) => {
        console.error(`WebGPU device was lost: ${info.message}`);
      });
      AppState.device.onuncapturederror = (event) => {
        console.error('WebGPU uncaught error (onuncapturederror):', event.error.message);
      };
      AppState.device.addEventListener('uncapturederror', (event) => {
        console.error('WebGPU uncaught error (event):', event.error.message);
      });
      AppState.webgpuSupported = true;
      AppState.webgpuEnabled = true;

      if (AppState.statusBadge) {
        AppState.statusBadge.classList.add('connected');
        const textEl = AppState.statusBadge.querySelector('.status-text') || AppState.statusBadge.querySelector('#gpu-status-text');
        if (textEl) textEl.innerText = 'WebGPU (Compute)';

        AppState.statusBadge.addEventListener('click', () => {
          cycleRenderingMode();
        });
      }

      await initWebGPU();
    } catch (err) {
      console.error('WebGPU initialization error:', err);
      AppState.webgpuSupported = false;
      AppState.webgpuEnabled = false;
      if (AppState.statusBadge) {
        AppState.statusBadge.className = 'gpu-status-badge error';
        const textEl = AppState.statusBadge.querySelector('.status-text') || AppState.statusBadge.querySelector('#gpu-status-text');
        if (textEl) textEl.innerText = 'Initialization Error';
      }
      initCanvasFallback();
    }
  }

  // Parse URL parameter 'char'
  const urlParams = new URLSearchParams(window.location.search);
  let initialChar = urlParams.get('char');
  let isDefault = false;
  if (initialChar) {
    initialChar = initialChar.trim().substring(0, 1);
  }
  if (!initialChar) {
    initialChar = '愛';
    isDefault = true;
  }
  AppState.elCharInput.value = initialChar;

  // Load initial Kanji SVG and start animation
  await loadKanjiData(initialChar, isDefault);
  
  if (AppState.animator) {
    syncControlsToRust();
    setRenderingMode(AppState.renderMode);
    AppState.animator.start_animation();
    updateControlsState();
  }

  // Resize handling
  const resizeObserverInstance = new ResizeObserver(() => {
    resizeCanvas(AppState.canvas);
  });
  resizeObserverInstance.observe(AppState.canvas.parentElement);

  // Frame/Time Render Loop
  let lastTime = performance.now();
  
  function frame(now) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    let needsRedraw = false;

    if (AppState.animator) {
      const wasAnimating = AppState.animator.is_animating();
      
      const finishedIdx = AppState.animator.tick(dt);
      if (finishedIdx >= 0) {
        if (AppState.activeRenderer) {
          AppState.activeRenderer.onStrokeFinishedDrying(finishedIdx);
        }
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

    if (AppState.activeRenderer) {
      const isWebGPU = AppState.activeRenderer.mode !== 'canvas';
      const commandEncoder = (isWebGPU && AppState.device) ? AppState.device.createCommandEncoder() : null;

      AppState.activeRenderer.renderGlyph(commandEncoder);
      AppState.activeRenderer.present(commandEncoder);

      if (commandEncoder) {
        AppState.device.queue.submit([commandEncoder.finish()]);
      }
    }

    requestAnimationFrame(frame);
  }

  function initCanvasFallback() {
    AppState.webgpuEnabled = false;
    AppState.visibleCtx = AppState.canvas.getContext('2d');
    AppState.canvas.classList.add('fallback-mode');
    setRenderingMode('canvas');
  }

  function cycleRenderingMode() {
    if (!AppState.webgpuSupported) return;

    if (AppState.renderMode === 'webgpu_compute') {
      setRenderingMode('webgpu_cpu');
    } else if (AppState.renderMode === 'webgpu_cpu') {
      setRenderingMode('canvas');
    } else {
      setRenderingMode('webgpu_compute');
    }
  }

  function setRenderingMode(mode) {
    if (!AppState.webgpuSupported) {
      mode = 'canvas';
    }

    if (AppState.activeRenderer) {
      AppState.activeRenderer.destroy();
    }

    AppState.activeRenderer = AppState.renderers[mode];
    AppState.renderMode = mode;

    if (AppState.activeRenderer) {
      AppState.activeRenderer.init();
    }

    if (mode === 'canvas') {
      AppState.webgpuEnabled = false;
      resetCanvasContext('2d');
    } else {
      AppState.webgpuEnabled = true;
      resetCanvasContext('webgpu');
    }

    if (AppState.activeRenderer && AppState.statusBadge) {
      AppState.statusBadge.className = AppState.webgpuEnabled ? 'gpu-status-badge connected' : 'gpu-status-badge disabled';
      const textEl = AppState.statusBadge.querySelector('.status-text') || AppState.statusBadge.querySelector('#gpu-status-text');
      if (textEl) textEl.innerText = AppState.activeRenderer.displayName;

      if (AppState.elGlowControl) {
        AppState.elGlowControl.classList.toggle('hidden', !AppState.activeRenderer.supportsGlow);
      }
      if (AppState.elAAControl) {
        AppState.elAAControl.classList.toggle('hidden', !AppState.activeRenderer.supportsAntiAliasing);
      }

      AppState.activeRenderer.updateBuffers();
    }
    drawStrokesToCanvas();
  }

  requestAnimationFrame(frame);
}

window.addEventListener('DOMContentLoaded', initApp);
