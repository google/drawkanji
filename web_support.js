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

function setupUI(onResetCallback, onAAChangeCallback) {
  // Query references and store in AppState
  AppState.statusBadge = document.getElementById('gpu-status');
  AppState.canvas = document.getElementById('gpu-canvas');
  AppState.elGlowControl = document.getElementById('glow-intensity-control');
  AppState.elAAControl = document.getElementById('anti-aliasing-control');
  AppState.elCharInput = document.getElementById('char-input');
  AppState.elStrokeDisplay = document.getElementById('stroke-display');
  AppState.elAnimSpeed = document.getElementById('anim-speed');
  AppState.elPauseDur = document.getElementById('pause-dur');
  AppState.valAnimSpeed = document.getElementById('anim-speed-val');
  AppState.valPauseDur = document.getElementById('pause-dur-val');

  AppState.btnAnimate = document.getElementById('btn-animate');
  AppState.btnStop = document.getElementById('btn-stop');
  AppState.btnOneStroke = document.getElementById('btn-one-stroke');
  AppState.btnBackStroke = document.getElementById('btn-back-stroke');
  AppState.btnReset = document.getElementById('btn-reset');

  const elGlow = document.getElementById('glow-intensity');
  const elTipSize = document.getElementById('tip-size');
  const elLineWeight = document.getElementById('line-weight');
  const elTrailLength = document.getElementById('trail-length');
  const elZoom = document.getElementById('zoom');
  const elAntiAliasing = document.getElementById('anti-aliasing');
  
  const valGlow = document.getElementById('glow-intensity-val');
  const valTipSize = document.getElementById('tip-size-val');
  const valLineWeight = document.getElementById('line-weight-val');
  const valTrailLength = document.getElementById('trail-length-val');
  const valZoom = document.getElementById('zoom-val');
  const valAntiAliasing = document.getElementById('anti-aliasing-val');

  AppState.mobileMediaQuery = window.matchMedia('(max-width: 1024px)');

  // Bind controls
  elGlow?.addEventListener('input', (e) => {
    AppState.controls.glowIntensity = parseFloat(e.target.value);
    valGlow.innerText = AppState.controls.glowIntensity.toFixed(1);
    syncControlsToRust();
  });
  elZoom?.addEventListener('input', (e) => {
    AppState.controls.zoom = parseFloat(e.target.value);
    valZoom.innerText = AppState.controls.zoom.toFixed(1);
    syncControlsToRust();
  });

  const aaFactors = [1, 4, 8, 16];
  const aaLabels = ["None", "4x", "8x", "16x"];
  elAntiAliasing?.addEventListener('input', (e) => {
    const idx = parseInt(e.target.value);
    const factor = aaFactors[idx];
    AppState.controls.antiAliasing = factor;
    valAntiAliasing.innerText = aaLabels[idx];
    syncControlsToRust();
    
    if (onAAChangeCallback) {
      onAAChangeCallback(factor);
    }
  });

  elTipSize?.addEventListener('input', (e) => {
    AppState.tipSizePercent = parseInt(e.target.value);
    valTipSize.innerText = AppState.tipSizePercent + '%';
    syncControlsToRust();
    drawStrokesToCanvas();
  });

  elLineWeight?.addEventListener('input', (e) => {
    AppState.dryLineWidth = parseFloat(e.target.value);
    valLineWeight.innerText = AppState.dryLineWidth.toFixed(1);
    syncControlsToRust();
    if (onResetCallback) {
      onResetCallback();
    }
    drawStrokesToCanvas();
  });

  elTrailLength?.addEventListener('input', (e) => {
    AppState.trailLength = parseInt(e.target.value);
    valTrailLength.innerText = AppState.trailLength;
    syncControlsToRust();
    drawStrokesToCanvas();
  });

  AppState.elAnimSpeed?.addEventListener('input', (e) => {
    AppState.drawingSpeed = parseInt(e.target.value);
    AppState.valAnimSpeed.innerText = AppState.drawingSpeed + '/s';
    syncControlsToRust();
  });

  AppState.elPauseDur?.addEventListener('input', (e) => {
    AppState.pauseBetweenStrokes = parseInt(e.target.value);
    AppState.valPauseDur.innerText = AppState.pauseBetweenStrokes + 'ms';
    syncControlsToRust();
  });

  function handleInput(val) {
    const trimmed = val.trim();
    if (trimmed.length > 0) {
      const singleChar = trimmed.substring(0, 1);
      AppState.elCharInput.value = singleChar;
      stopAnimation();
      loadKanjiData(singleChar);
    } else {
      stopAnimation();
      loadKanjiData('');
    }
  }

  AppState.elCharInput?.addEventListener('compositionstart', () => {
    AppState.isComposing = true;
  });

  AppState.elCharInput?.addEventListener('compositionend', (e) => {
    AppState.isComposing = false;
    setTimeout(() => {
      handleInput(AppState.elCharInput.value);
    }, 0);
  });

  AppState.elCharInput?.addEventListener('input', (e) => {
    if (AppState.isComposing) return;
    handleInput(e.target.value);
  });

  function startAnimation() {
    if (!AppState.animator) return;
    syncControlsToRust();

    const logo = document.querySelector('.logo-area .jp-logo');
    if (logo) {
      const star = logo.querySelector('.sparkle-star');
      if (star) {
        star.classList.remove('animate');
      }
    }

    const isRestart = AppState.animator.current_stroke_index() >= AppState.animator.current_stroke_count();
    AppState.animator.start_animation();
    if (isRestart && onResetCallback) {
      onResetCallback();
    }
    updateControlsState();
  }

  function stopAnimation() {
    if (!AppState.animator) return;
    AppState.animator.stop_animation();
    updateControlsState();
  }

  function stepForward() {
    if (!AppState.animator) return;
    syncControlsToRust();
    AppState.animator.step_forward();
    updateControlsState();
  }

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

  AppState.btnAnimate?.addEventListener('click', startAnimation);
  const btnShare = document.querySelector('.logo-area .jp-logo');
  if (btnShare) {
    btnShare.addEventListener('click', handleShare);
  }
  AppState.btnStop?.addEventListener('click', stopAnimation);
  AppState.btnOneStroke?.addEventListener('click', stepForward);
  AppState.btnBackStroke?.addEventListener('click', stepBackward);

  AppState.btnReset?.addEventListener('click', () => {
    stopAnimation();
    
    elGlow.value = 0.0;
    AppState.controls.glowIntensity = 0.0;
    valGlow.innerText = '0.0';
    
    elZoom.value = 1.4;
    AppState.controls.zoom = 1.4;
    valZoom.innerText = '1.4';

    elAntiAliasing.value = 1;
    AppState.controls.antiAliasing = 4;
    valAntiAliasing.innerText = '4x';
    
    if (onAAChangeCallback) {
      onAAChangeCallback(4);
    }

    elTipSize.value = 80;
    AppState.tipSizePercent = 80;
    valTipSize.innerText = '80%';

    elLineWeight.value = 5.0;
    AppState.dryLineWidth = 5.0;
    valLineWeight.innerText = '5.0';

    elTrailLength.value = 140;
    AppState.trailLength = 140;
    valTrailLength.innerText = '140';

    AppState.elAnimSpeed.value = 80;
    AppState.drawingSpeed = 80;
    AppState.valAnimSpeed.innerText = '80/s';

    AppState.elPauseDur.value = 300;
    AppState.pauseBetweenStrokes = 300;
    AppState.valPauseDur.innerText = '300ms';
    
    if (AppState.animator) {
      AppState.animator.reset_animation();
    }
    syncControlsToRust();
    if (onResetCallback) {
      onResetCallback();
    }
    
    updateStrokeDisplay();
    drawStrokesToCanvas();
    updateControlsState();
  });

  AppState.mobileMediaQuery.addEventListener?.('change', updateStrokeDisplay);
}

function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.innerText = message;
  toast.classList.add('show');
  
  if (toast.timeoutId) {
    clearTimeout(toast.timeoutId);
  }
  
  toast.timeoutId = setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

function triggerSparkleAnimation() {
  const logo = document.querySelector('.logo-area .jp-logo');
  if (logo) {
    const star = logo.querySelector('.sparkle-star');
    if (star) {
      star.classList.remove('animate');
      void star.offsetWidth;
      star.classList.add('animate');
    }
  }
}

function handleShare(event) {
  event.preventDefault();
  
  const char = AppState.loadedCharacter || '愛';
  const shareUrl = `${window.location.origin}${window.location.pathname}?openExternalBrowser=1&char=${encodeURIComponent(char)}`;
  const shareTitle = `Kanji Stroke Order: ${char}`;
  const shareText = `Watch the stroke order animation for "${char}".`;

  if (navigator.share) {
    navigator.share({
      title: shareTitle,
      text: shareText,
      url: shareUrl
    })
    .catch((err) => {
      if (err && err.name === 'AbortError') {
        return;
      }
      fallbackCopyToClipboard(shareUrl);
    });
  } else {
    fallbackCopyToClipboard(shareUrl);
  }
}

function fallbackCopyToClipboard(url) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => {
        showToast("Copied to clipboard!");
        triggerSparkleAnimation();
      })
      .catch(() => {
        window.location.href = url;
      });
  } else {
    window.location.href = url;
  }
}

async function loadKanjiData(char, isDefault = false) {
  const logoSpan = document.querySelector('.logo-area .jp-logo');
  if (char) {
    document.title = isDefault ? 'Kanji Stroke Order' : `Kanji Stroke Order: ${char}`;
    if (logoSpan) {
      logoSpan.href = `?openExternalBrowser=1&char=${encodeURIComponent(char)}`;
    }
  } else {
    document.title = 'Kanji Stroke Order';
    if (logoSpan) {
      logoSpan.href = '#';
    }
  }
  await loadKanjiSVG(char);
}
