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

const AppState = {
  animator: null,
  wasmInstanceMemory: null,
  strokePaths: [],
  strokeElements: [],
  loadedCharacter: '',
  isComposing: false,
  tipSizePercent: 80,
  drawingSpeed: 80,
  pauseBetweenStrokes: 300,
  dryLineWidth: 5.0,
  trailLength: 140,
  animTime: 0,

  controls: {
    glowIntensity: 0.0,
    zoom: 1.4,
    antiAliasing: 4
  },

  kanjiArchiveIndexDataView: null,
  kanjiArchiveContentBaseOffset: 0,
  kanjiArchiveFullBuffer: null,

  webgpuSupported: false,
  webgpuEnabled: false,
  device: null,
  context: null,
  pipeline: null,
  bindGroup: null,
  vertexBuffer: null,
  indexBuffer: null,
  uniformBuffer: null,
  uniformData: null,
  uniformFloatView: null,
  glyphTexture: null,
  glyphTextureView: null,
  presentationFormat: null,
  sampler: null,
  antiAliasingFactor: 4,
  canvas: null,
  visibleCtx: null,
  glyphCanvas: null,
  glyphCtx: null,

  renderMode: 'webgpu_compute',
  activeRenderer: null,
  renderers: {},

  computePipeline: null,
  computeBindGroup: null,
  controlPointsBuffer: null,
  computeVertexBuffer: null,
  computeUniformBuffer: null,
  computeUniformData: null,
  computeUniformFloatView: null,

  drawPipeline: null,
  drawVertexBuffer: null,
  drawUniformBuffer: null,
  drawBindGroup: null,
  guideStrokeBuffers: [],
  dryStrokeBuffers: [],
  guideStrokeVertexCounts: [],
  dryStrokeVertexCounts: [],

  guideStrokesComputeBuffer: null,
  dryStrokeComputeBuffers: [],
  dryStrokeComputeVertexCounts: [],

  statusBadge: null,
  elGlowControl: null,
  elAAControl: null,
  elCharInput: null,
  elStrokeDisplay: null,
  elAnimSpeed: null,
  elPauseDur: null,
  elTipSize: null,
  elDryLineWidth: null,
  elTrailLength: null,
  btnAnimate: null,
  btnStop: null,
  btnOneStroke: null,
  btnBackStroke: null,
  btnReset: null,
  mobileMediaQuery: null
};

function syncControlsToRust() {
  if (!AppState.animator) return;
  AppState.animator.set_controls(
    AppState.drawingSpeed,
    AppState.pauseBetweenStrokes,
    AppState.controls.glowIntensity,
    AppState.tipSizePercent,
    AppState.dryLineWidth,
    AppState.trailLength,
    AppState.controls.zoom,
    AppState.controls.antiAliasing
  );
}

function updateStrokeDisplay() {
  const currentStrokeCount = AppState.animator ? AppState.animator.current_stroke_count() : 0;
  const currentStrokeIndex = AppState.animator ? AppState.animator.current_stroke_index() : 0;
  if (currentStrokeCount === 0) {
    AppState.elStrokeDisplay.innerText = 'No strokes';
  } else {
    const displayIndex = Math.min(currentStrokeIndex + 1, currentStrokeCount);
    AppState.elStrokeDisplay.innerText = AppState.mobileMediaQuery && AppState.mobileMediaQuery.matches
      ? `${displayIndex} / ${currentStrokeCount}`
      : `Stroke ${displayIndex} / ${currentStrokeCount}`;
  }
}

function updateControlsState() {
  if (!AppState.animator) return;
  const isAnimating = AppState.animator.is_animating();
  const currentStrokeIndex = AppState.animator.current_stroke_index();
  const currentStrokeCount = AppState.animator.current_stroke_count();
  const strokeProgress = AppState.animator.stroke_progress();

  AppState.btnAnimate.disabled = isAnimating;
  AppState.btnStop.disabled = !isAnimating;
  
  const fullyDrawn = currentStrokeIndex >= currentStrokeCount || (currentStrokeIndex === currentStrokeCount - 1 && strokeProgress >= 1.0);
  AppState.btnOneStroke.disabled = isAnimating || fullyDrawn;
  
  const nothingDrawn = (currentStrokeIndex === 0 && strokeProgress === 0.0);
  AppState.btnBackStroke.disabled = isAnimating || nothingDrawn;
}

function drawStrokesToCanvas(commandEncoder = null) {
  if (AppState.activeRenderer) {
    AppState.activeRenderer.renderGlyph(commandEncoder);
  }
}

let loadRequestId = 0;

async function loadKanjiSVG(char) {
  if (char === AppState.loadedCharacter) {
    return;
  }
  AppState.loadedCharacter = char;

  loadRequestId++;
  const myRequestId = loadRequestId;

  if (!char) {
    AppState.strokePaths = [];
    AppState.strokeElements = [];
    if (AppState.animator) AppState.animator.clear_strokes();
    updateStrokeDisplay();
    drawStrokesToCanvas();
    updateControlsState();
    return;
  }

  const codePoint = char.codePointAt(0);
  const hexStr = codePoint.toString(16).padStart(5, '0');

  const urlParams = new URLSearchParams(window.location.search);
  const useCdn = urlParams.get('cdn') !== 'no';

  try {
    let svgText = null;
    if (useCdn) {
      try {
        const cdnUrl = `https://cdn.jsdelivr.net/gh/KanjiVG/kanjivg/kanji/${hexStr}.svg`;
        const res = await fetch(cdnUrl);
        if (res.ok) {
          svgText = await res.text();
        }
      } catch (cdnErr) {
        console.warn(`CDN fetch failed for character '${char}' (${hexStr}), falling back to local archive:`, cdnErr);
      }
    } else {
      console.log(`URL param 'cdn=no' active: skipping CDN lookup for '${char}'.`);
    }

    if (!svgText) {
      console.log(`Loading character '${char}' (${hexStr}) from local archive fallback...`);
      svgText = await fetchSVGFromArchive(hexStr);
    }

    if (myRequestId !== loadRequestId) return;
    let cleanSvgText = svgText.replace(/<!DOCTYPE[\s\S]*?(?=<svg)/gi, '');
    if (!/xmlns:kvg\s*=/i.test(cleanSvgText)) {
      cleanSvgText = cleanSvgText.replace(/<svg\s/i, '<svg xmlns:kvg="http://kanjivg.tagaini.net" ');
    }
    
    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(cleanSvgText, 'image/svg+xml');
    
    const parserError = svgDoc.querySelector('parsererror');
    if (parserError) {
      throw new Error(`XML Parser Error: ${parserError.textContent}`);
    }
    
    const paths = Array.from(svgDoc.querySelectorAll('path'));
    if (paths.length === 0) {
      throw new Error(`Empty strokes list for character '${char}'`);
    }

    const svgHelper = document.getElementById('svg-helper');
    svgHelper.innerHTML = '';

    AppState.strokePaths = [];
    AppState.strokeElements = [];
    if (AppState.animator) AppState.animator.clear_strokes();

    const svgNS = "http://www.w3.org/2000/svg";
    for (let i = 0; i < paths.length; i++) {
      const d = paths[i].getAttribute('d');
      AppState.strokePaths.push(d);
      if (AppState.animator) AppState.animator.add_stroke_path(d);

      const pathEl = document.createElementNS(svgNS, 'path');
      pathEl.setAttribute('d', d);
      svgHelper.appendChild(pathEl);
      AppState.strokeElements.push(pathEl);
    }

    if (AppState.animator) {
      AppState.animator.setup_completed_strokes_buffer();
    }

    syncControlsToRust();
    if (myRequestId !== loadRequestId) return;
    if (AppState.activeRenderer) {
      AppState.activeRenderer.updateBuffers();
    }

    updateStrokeDisplay();
    drawStrokesToCanvas();
  } catch (err) {
    if (myRequestId !== loadRequestId) return;
    showToast(`Kanji Database Error: ${err.message}`);
    AppState.strokePaths = [];
    AppState.strokeElements = [];
    if (AppState.animator) AppState.animator.clear_strokes();
    updateStrokeDisplay();
    drawStrokesToCanvas();
  }
  updateControlsState();
}

