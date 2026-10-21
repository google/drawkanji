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

const TWO_PI = Math.PI * 2;
const TRAIL_FLOATS_PER_POINT = 4;
const TRAIL_OFF_X = 0;
const TRAIL_OFF_Y = 1;
const TRAIL_OFF_T = 2;
const TRAIL_OFF_R = 3;
const GLOW_RADIUS_MULTIPLIER = 4.5;

function lerpColor(c1, c2, t) {
  const r = Math.round(c1.r + (c2.r - c1.r) * t);
  const g = Math.round(c1.g + (c2.g - c1.g) * t);
  const b = Math.round(c1.b + (c2.b - c1.b) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function lerpColorRGBA(c1, c2, t, alpha) {
  const r = Math.round(c1.r + (c2.r - c1.r) * t);
  const g = Math.round(c1.g + (c2.g - c1.g) * t);
  const b = Math.round(c1.b + (c2.b - c1.b) * t);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

class Canvas2DRenderer extends KanjiRenderPlugin {
  get mode() {
    return 'canvas';
  }

  get displayName() {
    return '2D Fallback';
  }

  get supportsGlow() {
    return false;
  }

  get supportsAntiAliasing() {
    return false;
  }

  renderGlyph(commandEncoder = null) {
    if (!AppState.animator) return;

    const currentStrokeIndex = AppState.animator.current_stroke_index();
    const strokeProgress = AppState.animator.stroke_progress();
    const isSingleStrokeAnimating = AppState.animator.is_single_stroke_animating();

    const activeStrokeWidth = AppState.dryLineWidth * (8.0 / 6.5);

    const glyphSize = 512;
    AppState.glyphCtx.fillStyle = '#000000';
    AppState.glyphCtx.fillRect(0, 0, glyphSize, glyphSize);

    if (AppState.strokePaths.length === 0) return;

    AppState.glyphCtx.save();
    const padding = 45;
    const drawSize = glyphSize - padding * 2;
    
    AppState.glyphCtx.translate(padding, padding);
    AppState.glyphCtx.scale(drawSize / 109, drawSize / 109);

    AppState.glyphCtx.lineCap = 'round';
    AppState.glyphCtx.lineJoin = 'round';

    // 1. Draw future/guide strokes
    AppState.glyphCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    AppState.glyphCtx.lineWidth = 4;
    const futureStart = currentStrokeIndex;
    for (let i = futureStart; i < AppState.strokePaths.length; i++) {
      AppState.glyphCtx.stroke(new Path2D(AppState.strokePaths[i]));
    }

    // 2. Draw completed strokes
    const cYellow = { r: 250, g: 204, b: 21 };
    const cBlue = { r: 56, g: 189, b: 248 };

    const dryProgressPtr = AppState.animator.get_dry_progress_ptr();
    const dryProgressLen = AppState.animator.get_dry_progress_len();
    const dryProgresses = new Float32Array(AppState.wasmInstanceMemory.buffer, dryProgressPtr, dryProgressLen);

    for (let i = 0; i < currentStrokeIndex; i++) {
      const dryProgress = dryProgresses[i];
      AppState.glyphCtx.strokeStyle = lerpColor(cYellow, cBlue, dryProgress);
      AppState.glyphCtx.lineWidth = activeStrokeWidth - (activeStrokeWidth - AppState.dryLineWidth) * dryProgress;
      AppState.glyphCtx.stroke(new Path2D(AppState.strokePaths[i]));
    }

    // 3. Draw active stroke segment and tip
    if (currentStrokeIndex < AppState.strokePaths.length && strokeProgress > 0) {
      const pathEl = AppState.strokeElements[currentStrokeIndex];
      const totalLength = pathEl.getTotalLength();
      const currentLength = totalLength * strokeProgress;
      const diameter = activeStrokeWidth * (AppState.tipSizePercent / 100);
      const radius = diameter / 2;

      const pauseProgress = AppState.animator.pause_progress();
      const dryProg = isSingleStrokeAnimating ? pauseProgress : 0.0;
      const col = lerpColor(cYellow, cBlue, dryProg);
      AppState.glyphCtx.strokeStyle = col;
      AppState.glyphCtx.lineWidth = activeStrokeWidth - (activeStrokeWidth - AppState.dryLineWidth) * dryProg;
      
      AppState.glyphCtx.save();
      AppState.glyphCtx.beginPath();
      AppState.glyphCtx.setLineDash([currentLength, totalLength]);
      AppState.glyphCtx.stroke(new Path2D(AppState.strokePaths[currentStrokeIndex]));
      AppState.glyphCtx.restore();

      const cRed = { r: 239, g: 68, b: 68 };

      const trailPtr = AppState.animator.get_trail_ptr();
      const trailLen = AppState.animator.get_trail_len();
      const trailFloats = new Float32Array(AppState.wasmInstanceMemory.buffer, trailPtr, trailLen);
      const L = trailLen / TRAIL_FLOATS_PER_POINT;

      if (L > 1) {
        const trailAlpha = Math.pow(1.0 - pauseProgress, 2);
        for (let i = 0; i < L - 1; i++) {
          const idx = i * TRAIL_FLOATS_PER_POINT;
          const pt_x = trailFloats[idx + TRAIL_OFF_X];
          const pt_y = trailFloats[idx + TRAIL_OFF_Y];
          const t = trailFloats[idx + TRAIL_OFF_T];
          const r = trailFloats[idx + TRAIL_OFF_R];
          
          AppState.glyphCtx.fillStyle = lerpColorRGBA(cYellow, cRed, t, trailAlpha);
          AppState.glyphCtx.beginPath();
          AppState.glyphCtx.arc(pt_x, pt_y, r, 0, TWO_PI);
          AppState.glyphCtx.fill();
        }
      }

      const tipPt_x = AppState.animator.active_tip_x();
      const tipPt_y = AppState.animator.active_tip_y();
      const tipRadius = L > 0 ? radius * (0.35 + 0.65 * (1.0 - pauseProgress)) : radius;
      const glowRadius = tipRadius * GLOW_RADIUS_MULTIPLIER;
      const glowAlpha = 1.0 - pauseProgress;

      if (glowRadius > 0 && glowAlpha > 0) {
        const grad = AppState.glyphCtx.createRadialGradient(tipPt_x, tipPt_y, 0, tipPt_x, tipPt_y, glowRadius);
        grad.addColorStop(0.0, `rgba(250, 204, 21, ${1.0 * glowAlpha})`);
        grad.addColorStop(0.25, `rgba(250, 204, 21, ${0.5625 * glowAlpha})`);
        grad.addColorStop(0.5, `rgba(250, 204, 21, ${0.25 * glowAlpha})`);
        grad.addColorStop(0.75, `rgba(250, 204, 21, ${0.0625 * glowAlpha})`);
        grad.addColorStop(1.0, `rgba(250, 204, 21, 0.0)`);

        AppState.glyphCtx.fillStyle = grad;
        AppState.glyphCtx.beginPath();
        AppState.glyphCtx.arc(tipPt_x, tipPt_y, glowRadius, 0, TWO_PI);
        AppState.glyphCtx.fill();
      }

      if (L > 0) {
        const idx = (L - 1) * TRAIL_FLOATS_PER_POINT;
        const pt_x = trailFloats[idx + TRAIL_OFF_X];
        const pt_y = trailFloats[idx + TRAIL_OFF_Y];
        let t = 1.0 * (1.0 - pauseProgress);
        const tipAlpha = Math.pow(1.0 - pauseProgress, 2);
        AppState.glyphCtx.fillStyle = lerpColorRGBA(cYellow, cRed, t, tipAlpha);
        AppState.glyphCtx.beginPath();
        AppState.glyphCtx.arc(pt_x, pt_y, tipRadius, 0, TWO_PI);
        AppState.glyphCtx.fill();
      } else {
        AppState.glyphCtx.fillStyle = '#ef4444';
        AppState.glyphCtx.beginPath();
        AppState.glyphCtx.arc(tipPt_x, tipPt_y, radius, 0, TWO_PI);
        AppState.glyphCtx.fill();
      }
    }

    AppState.glyphCtx.restore();
  }

  present(commandEncoder = null) {
    if (AppState.visibleCtx) {
      AppState.visibleCtx.clearRect(0, 0, AppState.canvas.width, AppState.canvas.height);
      const scaleFactor = AppState.controls.zoom * 0.85;
      AppState.visibleCtx.translate(AppState.canvas.width / 2, AppState.canvas.height / 2);
      AppState.visibleCtx.scale(scaleFactor, scaleFactor);
      AppState.visibleCtx.drawImage(AppState.glyphCanvas, -AppState.canvas.width / 2, -AppState.canvas.height / 2, AppState.canvas.width, AppState.canvas.height);
      AppState.visibleCtx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
}
