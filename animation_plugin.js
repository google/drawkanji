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

/**
 * Abstract Base Class defining the contract for all Kanji Rendering Plugins.
 * Guarantees 100% encapsulation for Canvas2D, WebGPU-CPU, WebGPU-Compute, and future renderers.
 */
class KanjiRenderPlugin {
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
