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

function expand6to8(srcFloatArray) {
  const count = srcFloatArray.length / 6;
  const dst = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) {
    dst[i * 8 + 0] = srcFloatArray[i * 6 + 0];
    dst[i * 8 + 1] = srcFloatArray[i * 6 + 1];
    dst[i * 8 + 2] = 0.0;
    dst[i * 8 + 3] = 0.0;
    dst[i * 8 + 4] = srcFloatArray[i * 6 + 2];
    dst[i * 8 + 5] = srcFloatArray[i * 6 + 3];
    dst[i * 8 + 6] = srcFloatArray[i * 6 + 4];
    dst[i * 8 + 7] = srcFloatArray[i * 6 + 5];
  }
  return dst;
}

class WebGPUCPURenderer extends KanjiRenderPlugin {
  get mode() {
    return 'webgpu_cpu';
  }

  get displayName() {
    return 'WebGPU (CPU)';
  }

  get supportsGlow() {
    return true;
  }

  get supportsAntiAliasing() {
    return true;
  }

  destroy() {
    if (AppState.device) {
      for (let buf of AppState.guideStrokeBuffers) {
        if (buf) {
          try { buf.destroy(); } catch (e) {}
        }
      }
      for (let buf of AppState.dryStrokeBuffers) {
        if (buf) {
          try { buf.destroy(); } catch (e) {}
        }
      }
    }
    AppState.guideStrokeBuffers = [];
    AppState.dryStrokeBuffers = [];
    AppState.guideStrokeVertexCounts = [];
    AppState.dryStrokeVertexCounts = [];
  }

  updateBuffers() {
    this.destroy();

    if (!AppState.webgpuEnabled || !AppState.webgpuSupported || !AppState.device || !AppState.animator) return;

    const count = AppState.animator.current_stroke_count();
    for (let i = 0; i < count; i++) {
      const guideLen = AppState.animator.get_guide_stroke_len(i);
      if (guideLen > 0) {
        const guidePtr = AppState.animator.get_guide_stroke_ptr(i);
        const floatArray = expand6to8(new Float32Array(AppState.wasmInstanceMemory.buffer, guidePtr, guideLen));
        
        const buffer = AppState.device.createBuffer({
          size: floatArray.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        });
        AppState.device.queue.writeBuffer(buffer, 0, floatArray);
        
        AppState.guideStrokeBuffers.push(buffer);
        AppState.guideStrokeVertexCounts.push(guideLen / 6);
      } else {
        AppState.guideStrokeBuffers.push(null);
        AppState.guideStrokeVertexCounts.push(0);
      }

      const isDry = AppState.animator.is_stroke_dry(i);
      if (isDry) {
        AppState.animator.tessellate_dry_stroke(i);
        const dryLen = AppState.animator.get_dry_stroke_len(i);
        if (dryLen > 0) {
          const dryPtr = AppState.animator.get_dry_stroke_ptr(i);
          const floatArray = expand6to8(new Float32Array(AppState.wasmInstanceMemory.buffer, dryPtr, dryLen));
          
          const buffer = AppState.device.createBuffer({
            size: floatArray.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
          });
          AppState.device.queue.writeBuffer(buffer, 0, floatArray);
          
          AppState.dryStrokeBuffers.push(buffer);
          AppState.dryStrokeVertexCounts.push(dryLen / 6);
        } else {
          AppState.dryStrokeBuffers.push(null);
          AppState.dryStrokeVertexCounts.push(0);
        }
      } else {
        AppState.dryStrokeBuffers.push(null);
        AppState.dryStrokeVertexCounts.push(0);
      }
    }
  }

  onStrokeFinishedDrying(idx) {
    if (!AppState.webgpuEnabled || !AppState.webgpuSupported || !AppState.device || !AppState.animator) return;
    
    AppState.animator.tessellate_dry_stroke(idx);
    const dryLen = AppState.animator.get_dry_stroke_len(idx);
    if (dryLen > 0) {
      const dryPtr = AppState.animator.get_dry_stroke_ptr(idx);
      const floatArray = expand6to8(new Float32Array(AppState.wasmInstanceMemory.buffer, dryPtr, dryLen));
      
      const buffer = AppState.device.createBuffer({
        size: floatArray.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
      });
      AppState.device.queue.writeBuffer(buffer, 0, floatArray);
      
      if (AppState.dryStrokeBuffers[idx]) {
        try {
          AppState.dryStrokeBuffers[idx].destroy();
        } catch (e) {
          console.error("Error destroying dry buffer in onStrokeFinishedDrying:", e);
        }
      }
      AppState.dryStrokeBuffers[idx] = buffer;
      AppState.dryStrokeVertexCounts[idx] = dryLen / 6;
    }
  }

  onStepBackward(deletedIdx) {
    if (AppState.dryStrokeBuffers && AppState.dryStrokeBuffers[deletedIdx]) {
      try {
        AppState.dryStrokeBuffers[deletedIdx].destroy();
      } catch (e) {
        console.error("Error destroying dry buffer on step backward:", e);
      }
      AppState.dryStrokeBuffers[deletedIdx] = null;
      AppState.dryStrokeVertexCounts[deletedIdx] = 0;
    }
  }

  renderGlyph(commandEncoder = null) {
    let localEncoder = commandEncoder;
    let shouldSubmit = false;
    if (!localEncoder) {
      localEncoder = AppState.device.createCommandEncoder();
      shouldSubmit = true;
    }

    if (!AppState.animator || AppState.animator.current_stroke_count() === 0) return;

    const aspectArray = new Float32Array([1.0, 512.0 * AppState.antiAliasingFactor, 0, 0]);
    AppState.device.queue.writeBuffer(AppState.drawUniformBuffer, 0, aspectArray);

    const passEncoder = localEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: AppState.glyphTextureView,
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    });

    passEncoder.setPipeline(AppState.drawPipeline);
    passEncoder.setBindGroup(0, AppState.drawBindGroup);

    const totalStrokes = AppState.animator.current_stroke_count();
    const currentStrokeIdx = AppState.animator.current_stroke_index();

    for (let i = currentStrokeIdx; i < totalStrokes; i++) {
      const buf = AppState.guideStrokeBuffers[i];
      const count = AppState.guideStrokeVertexCounts[i];
      if (buf && count > 0) {
        passEncoder.setVertexBuffer(0, buf);
        passEncoder.draw(count);
      }
    }

    for (let i = 0; i < currentStrokeIdx; i++) {
      if (i === currentStrokeIdx - 1 && AppState.animator.is_any_stroke_drying()) {
        continue;
      }
      const buf = AppState.dryStrokeBuffers[i];
      const count = AppState.dryStrokeVertexCounts[i];
      if (buf && count > 0) {
        passEncoder.setVertexBuffer(0, buf);
        passEncoder.draw(count);
      }
    }

    const ptr = AppState.animator.get_vertices_ptr();
    const len = AppState.animator.get_vertices_len();
    if (len > 0) {
      const floatArray = expand6to8(new Float32Array(AppState.wasmInstanceMemory.buffer, ptr, len));
      AppState.device.queue.writeBuffer(AppState.drawVertexBuffer, 0, floatArray);

      passEncoder.setVertexBuffer(0, AppState.drawVertexBuffer);
      passEncoder.draw(len / 6);
    }

    passEncoder.end();

    if (shouldSubmit) {
      AppState.device.queue.submit([localEncoder.finish()]);
    }
  }

  present(commandEncoder = null) {
    if (!AppState.device || !AppState.context || !AppState.pipeline || !AppState.bindGroup) return;

    let localEncoder = commandEncoder;
    let shouldSubmit = false;
    if (!localEncoder) {
      localEncoder = AppState.device.createCommandEncoder();
      shouldSubmit = true;
    }

    AppState.uniformFloatView[0] = AppState.controls.glowIntensity;
    AppState.uniformFloatView[1] = AppState.controls.zoom;
    AppState.uniformFloatView[2] = AppState.animTime;
    AppState.uniformFloatView[3] = AppState.canvas.width / AppState.canvas.height;

    AppState.device.queue.writeBuffer(AppState.uniformBuffer, 0, AppState.uniformData);

    const textureView = AppState.context.getCurrentTexture().createView();

    const renderPassDescriptor = {
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0.0392, g: 0.0549, b: 0.0902, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    };

    const passEncoder = localEncoder.beginRenderPass(renderPassDescriptor);
    passEncoder.setPipeline(AppState.pipeline);
    passEncoder.setBindGroup(0, AppState.bindGroup);
    passEncoder.setVertexBuffer(0, AppState.vertexBuffer);
    passEncoder.setIndexBuffer(AppState.indexBuffer, 'uint16');
    passEncoder.drawIndexed(6);
    passEncoder.end();

    if (shouldSubmit) {
      AppState.device.queue.submit([localEncoder.finish()]);
    }
  }
}
