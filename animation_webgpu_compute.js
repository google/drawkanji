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

function getStrokeMeta(i) {
  const smPtr = AppState.animator.get_strokes_meta_ptr();
  const metaOffset = (smPtr / 4) + i * 4;
  const startIndex = new Uint32Array(AppState.wasmInstanceMemory.buffer)[metaOffset];
  const pointCount = new Uint32Array(AppState.wasmInstanceMemory.buffer)[metaOffset + 1];
  const lineWeight = new Float32Array(AppState.wasmInstanceMemory.buffer)[metaOffset + 2];
  return { startIndex, pointCount, lineWeight };
}

function tessellateDryStrokeCompute(i) {
  if (!AppState.device || !AppState.animator || !AppState.controlPointsBuffer) return;
  const { startIndex, pointCount, lineWeight } = getStrokeMeta(i);

  if (pointCount === 0) {
    AppState.dryStrokeComputeBuffers[i] = null;
    AppState.dryStrokeComputeVertexCounts[i] = 0;
    return;
  }

  const vertexCount = pointCount * 18;
  const buffer = AppState.device.createBuffer({
    size: vertexCount * 32,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE
  });

  const dryUniformBuffer = AppState.device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  const dryUniformData = new ArrayBuffer(48);
  const dryUintView = new Uint32Array(dryUniformData);
  const dryFloatView = new Float32Array(dryUniformData);
  dryUintView[9] = startIndex;
  dryUintView[10] = pointCount;
  dryFloatView[11] = lineWeight;
  AppState.device.queue.writeBuffer(dryUniformBuffer, 0, dryUniformData);

  const dryBindGroup = AppState.device.createBindGroup({
    layout: AppState.dryComputePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: AppState.controlPointsBuffer } },
      { binding: 2, resource: { buffer: buffer } },
      { binding: 3, resource: { buffer: dryUniformBuffer } }
    ]
  });

  const commandEncoder = AppState.device.createCommandEncoder();
  const computePass = commandEncoder.beginComputePass();
  computePass.setPipeline(AppState.dryComputePipeline);
  computePass.setBindGroup(0, dryBindGroup);
  computePass.dispatchWorkgroups(Math.ceil(pointCount / 64));
  computePass.end();
  AppState.device.queue.submit([commandEncoder.finish()]);

  if (AppState.dryStrokeComputeBuffers[i]) {
    try {
      AppState.dryStrokeComputeBuffers[i].destroy();
    } catch (e) {
      console.error(e);
    }
  }
  AppState.dryStrokeComputeBuffers[i] = buffer;
  AppState.dryStrokeComputeVertexCounts[i] = vertexCount;
}

class WebGPUComputeRenderer extends KanjiRenderPlugin {
  get mode() {
    return 'webgpu_compute';
  }

  get displayName() {
    return 'WebGPU (Compute)';
  }

  get supportsGlow() {
    return true;
  }

  get supportsAntiAliasing() {
    return true;
  }

  destroy() {
    if (AppState.controlPointsBuffer) {
      try { AppState.controlPointsBuffer.destroy(); } catch (e) {}
      AppState.controlPointsBuffer = null;
    }
    if (AppState.computeVertexBuffer) {
      try { AppState.computeVertexBuffer.destroy(); } catch (e) {}
      AppState.computeVertexBuffer = null;
    }
    if (AppState.guideStrokesComputeBuffer) {
      try { AppState.guideStrokesComputeBuffer.destroy(); } catch (e) {}
      AppState.guideStrokesComputeBuffer = null;
    }
    if (AppState.dryStrokeComputeBuffers) {
      for (let buf of AppState.dryStrokeComputeBuffers) {
        if (buf) {
          try { buf.destroy(); } catch(e) {}
        }
      }
    }
    AppState.dryStrokeComputeBuffers = [];
    AppState.dryStrokeComputeVertexCounts = [];
  }

  updateBuffers() {
    this.destroy();

    if (!AppState.device || !AppState.animator) return;
    if (AppState.renderMode === 'canvas') return;

    const cpLen = AppState.animator.get_control_points_len();
    if (cpLen === 0) return;

    const cpPtr = AppState.animator.get_control_points_ptr();
    const cpFloatArray = new Float32Array(AppState.wasmInstanceMemory.buffer, cpPtr, cpLen * 4);
    const cleanCpArray = new Float32Array(cpFloatArray);
    AppState.controlPointsBuffer = AppState.device.createBuffer({
      size: cleanCpArray.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    AppState.device.queue.writeBuffer(AppState.controlPointsBuffer, 0, cleanCpArray);

    // Allocate 18 vertices per control point (6 quad + 6 joint circle quad + 6 tip circle quad), plus 144 vertices for the glow, plus maximum 250 trail points (6 vertices each)
    const maxVertices = cpLen * 18 + 144 + 250 * 6;
    AppState.computeVertexBuffer = AppState.device.createBuffer({
      size: maxVertices * 32,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE
    });

    AppState.computeBindGroup = AppState.device.createBindGroup({
      layout: AppState.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: AppState.controlPointsBuffer } },
        { binding: 2, resource: { buffer: AppState.computeVertexBuffer } },
        { binding: 3, resource: { buffer: AppState.computeUniformBuffer } }
      ]
    });

    AppState.cometComputeBindGroup = AppState.device.createBindGroup({
      label: 'cometComputeBindGroup',
      layout: AppState.cometComputePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 4, resource: { buffer: AppState.trailHistoryBuffer } },
        { binding: 2, resource: { buffer: AppState.computeVertexBuffer } },
        { binding: 5, resource: { buffer: AppState.cometUniformBuffer } }
      ]
    });

    AppState.glowComputeBindGroup = AppState.device.createBindGroup({
      label: 'glowComputeBindGroup',
      layout: AppState.glowComputePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 4, resource: { buffer: AppState.trailHistoryBuffer } },
        { binding: 2, resource: { buffer: AppState.computeVertexBuffer } },
        { binding: 5, resource: { buffer: AppState.cometUniformBuffer } }
      ]
    });

    AppState.dryStrokeComputeBuffers = [];
    AppState.dryStrokeComputeVertexCounts = [];

    AppState.guideStrokesComputeBuffer = AppState.device.createBuffer({
      size: cpLen * 18 * 32,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE
    });

    const guideBindGroup = AppState.device.createBindGroup({
      layout: AppState.guideComputePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: AppState.controlPointsBuffer } },
        { binding: 2, resource: { buffer: AppState.guideStrokesComputeBuffer } }
      ]
    });

    const initEncoder = AppState.device.createCommandEncoder();
    const initPass = initEncoder.beginComputePass();
    initPass.setPipeline(AppState.guideComputePipeline);
    initPass.setBindGroup(0, guideBindGroup);
    initPass.dispatchWorkgroups(Math.ceil(cpLen / 64));
    initPass.end();
    AppState.device.queue.submit([initEncoder.finish()]);

    // Handle dry stroke buffers (check if already dry)
    const count = AppState.animator.current_stroke_count();
    for (let i = 0; i < count; i++) {
      const isDry = AppState.animator.is_stroke_dry(i);
      if (isDry) {
        tessellateDryStrokeCompute(i);
      } else {
        AppState.dryStrokeComputeBuffers.push(null);
        AppState.dryStrokeComputeVertexCounts.push(0);
      }
    }
  }

  onStrokeFinishedDrying(idx) {
    tessellateDryStrokeCompute(idx);
  }

  onStepBackward(deletedIdx) {
    if (AppState.dryStrokeComputeBuffers && AppState.dryStrokeComputeBuffers[deletedIdx]) {
      try {
        AppState.dryStrokeComputeBuffers[deletedIdx].destroy();
      } catch (e) {
        console.error("Error destroying dry compute buffer on step backward:", e);
      }
      AppState.dryStrokeComputeBuffers[deletedIdx] = null;
      AppState.dryStrokeComputeVertexCounts[deletedIdx] = 0;
    }
  }

  renderGlyph(commandEncoder = null) {
    let localEncoder = commandEncoder;
    let shouldSubmit = false;
    if (!localEncoder) {
      localEncoder = AppState.device.createCommandEncoder();
      shouldSubmit = true;
    }

    if (!AppState.animator || AppState.animator.current_stroke_count() === 0 || !AppState.computeBindGroup) return;

    const cpLen = AppState.animator.get_control_points_len();
    const currentStrokeIdx = AppState.animator.current_stroke_index();
    const strokeProgress = AppState.animator.stroke_progress();
    const isAnyDrying = AppState.animator.is_any_stroke_drying() ? 1 : 0;

    let dryingProgress = 1.0;
    if (isAnyDrying && currentStrokeIdx > 0) {
      const dryProgressPtr = AppState.animator.get_dry_progress_ptr();
      const dryProgressArray = new Float32Array(AppState.wasmInstanceMemory.buffer, dryProgressPtr, currentStrokeIdx);
      dryingProgress = dryProgressArray[currentStrokeIdx - 1];
    }

    const currentStrokeDryProgress = AppState.animator.is_single_stroke_animating() ? AppState.animator.pause_progress() : 0.0;

    const count = AppState.animator.current_stroke_count();
    let activeStart = 0;
    let activeCount = 0;
    let activeWeight = 0.0;
    if (currentStrokeIdx < count) {
      const meta = getStrokeMeta(currentStrokeIdx);
      activeStart = meta.startIndex;
      activeCount = meta.pointCount;
      activeWeight = meta.lineWeight;
    }
    let dryingWeight = 0.0;
    if (isAnyDrying && currentStrokeIdx > 0) {
      const meta = getStrokeMeta(currentStrokeIdx - 1);
      dryingWeight = meta.lineWeight;
    }

    // 1. Write uniforms and dispatch main character tessellator
    const uintView = new Uint32Array(AppState.computeUniformData);
    const floatView = AppState.computeUniformFloatView;
    uintView[0] = currentStrokeIdx;
    floatView[1] = strokeProgress;
    floatView[2] = dryingProgress;
    uintView[3] = isAnyDrying;
    floatView[4] = currentStrokeDryProgress;
    uintView[5] = activeStart;
    uintView[6] = activeCount;
    floatView[7] = activeWeight;
    floatView[8] = dryingWeight;
    AppState.device.queue.writeBuffer(AppState.computeUniformBuffer, 0, AppState.computeUniformData);

    const computePass = localEncoder.beginComputePass();
    computePass.setPipeline(AppState.computePipeline);
    computePass.setBindGroup(0, AppState.computeBindGroup);
    const workgroupCount = Math.ceil(cpLen / 64);
    computePass.dispatchWorkgroups(workgroupCount);
    computePass.end();

    // 2. Upload and dispatch comet trail tessellator
    const trailLen = AppState.animator.get_trail_len(); // number of floats
    if (trailLen > 0) {
      const trailPtr = AppState.animator.get_trail_ptr();
      const trailFloatArray = new Float32Array(AppState.wasmInstanceMemory.buffer, trailPtr, trailLen);
      const cleanTrailArray = new Float32Array(trailFloatArray);
      AppState.device.queue.writeBuffer(AppState.trailHistoryBuffer, 0, cleanTrailArray);

      const cometUintView = new Uint32Array(AppState.cometUniformData);
      const cometFloatView = AppState.cometUniformFloatView;
      cometUintView[0] = trailLen / 4; // number of points
      cometUintView[1] = cpLen;
      cometFloatView[2] = AppState.controls.zoom;
      cometFloatView[3] = AppState.antiAliasingFactor;
      cometFloatView[4] = AppState.animator.pause_progress();
      AppState.device.queue.writeBuffer(AppState.cometUniformBuffer, 0, AppState.cometUniformData);

      const cometComputePass = localEncoder.beginComputePass();
      cometComputePass.setPipeline(AppState.cometComputePipeline);
      cometComputePass.setBindGroup(0, AppState.cometComputeBindGroup);
      const cometWorkgroupCount = Math.ceil((trailLen / 4) / 64);
      cometComputePass.dispatchWorkgroups(cometWorkgroupCount);

      cometComputePass.setPipeline(AppState.glowComputePipeline);
      cometComputePass.setBindGroup(0, AppState.glowComputeBindGroup);
      cometComputePass.dispatchWorkgroups(1);
      cometComputePass.end();
    }

    // 3. Render Pass: Draw all computed vertices
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

    // Draw guide strokes
    if (AppState.guideStrokesComputeBuffer && cpLen > 0) {
      passEncoder.setVertexBuffer(0, AppState.guideStrokesComputeBuffer);
      passEncoder.draw(cpLen * 18);
    }

    // Draw completed dry strokes
    if (AppState.dryStrokeComputeBuffers) {
      for (let i = 0; i < AppState.dryStrokeComputeBuffers.length; i++) {
        const buf = AppState.dryStrokeComputeBuffers[i];
        const vCount = AppState.dryStrokeComputeVertexCounts[i];
        if (buf && vCount > 0) {
          passEncoder.setVertexBuffer(0, buf);
          passEncoder.draw(vCount);
        }
      }
    }

    // Draw active/drying stroke, trail, and glow
    if (AppState.computeVertexBuffer && cpLen > 0) {
      passEncoder.setVertexBuffer(0, AppState.computeVertexBuffer);
      let totalVertices = cpLen * 18;
      if (trailLen > 0) {
        totalVertices += 144 + (trailLen / 4) * 6;
      }
      passEncoder.draw(totalVertices);
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

const computeShaderCode = `
struct ControlPoint {
  position: vec2<f32>,
  stroke_index: u32,
  accumulated_len: f32,
};

struct ExtrudedVertex {
  position: vec2<f32>,
  uv: vec2<f32>,
  color_r: f32,
  color_g: f32,
  color_b: f32,
  color_a: f32,
};

struct ComputeUniforms {
  current_stroke_index: u32,
  stroke_progress: f32,
  drying_progress: f32,
  is_any_stroke_drying: u32,
  current_stroke_dry_progress: f32,
  active_stroke_start_index: u32,
  active_stroke_point_count: u32,
  active_stroke_line_weight: f32,
  drying_stroke_line_weight: f32,
  dry_stroke_start_index: u32,
  dry_stroke_point_count: u32,
  dry_stroke_line_weight: f32,
};

@group(0) @binding(0) var<storage, read> control_points: array<ControlPoint>;
@group(0) @binding(2) var<storage, read_write> output_vertices: array<ExtrudedVertex>;
@group(0) @binding(3) var<uniform> uniforms: ComputeUniforms;

@compute @workgroup_size(64)
fn cs_guide(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let idx = global_id.x;
  let total_points = arrayLength(&control_points);
  if (idx >= total_points) { return; }

  let out_segment_offset = idx * 18u;
  let out_circle_offset = idx * 18u + 6u;

  let pA = control_points[idx];
  let stroke_idx = pA.stroke_index;

  let c_guide = vec4<f32>(1.0, 1.0, 1.0, 0.08);
  let width = 4.0;

  var segment_written = false;
  if (idx < total_points - 1u) {
    let pB = control_points[idx + 1u];
    if (pB.stroke_index == stroke_idx) {
      write_segment_vertices(out_segment_offset, pA.position, pB.position, width, c_guide);
      segment_written = true;
    }
  }

  if (!segment_written) {
    write_collapsed_vertices(out_segment_offset, 6u);
  }

  write_circle(out_circle_offset, pA.position, width / 2.0, c_guide);
  
  let out_tip_offset = idx * 18u + 12u;
  write_collapsed_vertices(out_tip_offset, 6u);
}

@compute @workgroup_size(64)
fn cs_dry_stroke(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let local_idx = global_id.x;
  if (local_idx >= uniforms.dry_stroke_point_count) {
    return;
  }
  let idx = uniforms.dry_stroke_start_index + local_idx;

  let out_segment_offset = local_idx * 18u;
  let out_circle_offset = local_idx * 18u + 6u;

  let pA = control_points[idx];
  let stroke_idx = pA.stroke_index;

  let c_blue = vec4<f32>(56.0/255.0, 189.0/255.0, 248.0/255.0, 1.0);
  let width = uniforms.dry_stroke_line_weight;

  var segment_written = false;
  if (local_idx < uniforms.dry_stroke_point_count - 1u) {
    let pB = control_points[idx + 1u];
    if (pB.stroke_index == stroke_idx) {
      write_segment_vertices(out_segment_offset, pA.position, pB.position, width, c_blue);
      segment_written = true;
    }
  }

  if (!segment_written) {
    write_collapsed_vertices(out_segment_offset, 6u);
  }

  write_circle(out_circle_offset, pA.position, width / 2.0, c_blue);

  let out_tip_offset = local_idx * 18u + 12u;
  write_collapsed_vertices(out_tip_offset, 6u);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let idx = global_id.x;
  let total_points = arrayLength(&control_points);
  
  if (idx >= total_points) {
    return;
  }

  let out_segment_offset = idx * 18u;
  let out_circle_offset = idx * 18u + 6u;
  let out_tip_offset = idx * 18u + 12u;

  let pA = control_points[idx];
  let stroke_idx = pA.stroke_index;

  let c_yellow = vec4<f32>(250.0/255.0, 204.0/255.0, 21.0/255.0, 1.0);
  let c_blue = vec4<f32>(56.0/255.0, 189.0/255.0, 248.0/255.0, 1.0);

  var is_visible = false;
  var col = vec4<f32>(0.0);
  var width = 0.0;

  var is_partial = false;
  var partial_target_pos = vec2<f32>(0.0);

  if (stroke_idx == uniforms.current_stroke_index) {
    width = uniforms.active_stroke_line_weight;
    if (uniforms.stroke_progress > 0.0) {
      let stroke_start_pt = control_points[uniforms.active_stroke_start_index];
      let stroke_end_pt = control_points[uniforms.active_stroke_start_index + uniforms.active_stroke_point_count - 1u];
      let total_len = stroke_end_pt.accumulated_len;
      let target_len = total_len * uniforms.stroke_progress;

      if (pA.accumulated_len <= target_len) {
        is_visible = true;
        col = mix(c_yellow, c_blue, uniforms.current_stroke_dry_progress);
        width = mix(uniforms.active_stroke_line_weight * (8.0 / 6.5), uniforms.active_stroke_line_weight, uniforms.current_stroke_dry_progress);
      }
    }
  } else if (uniforms.is_any_stroke_drying != 0u && stroke_idx == uniforms.current_stroke_index - 1u) {
    is_visible = true;
    col = mix(c_yellow, c_blue, uniforms.drying_progress);
    width = mix(uniforms.drying_stroke_line_weight * (8.0 / 6.5), uniforms.drying_stroke_line_weight, uniforms.drying_progress);
  }

  // --- 1. SEGMENT QUAD Extrusion ---
  var segment_written = false;
  if (is_visible && idx < total_points - 1u) {
    let pB = control_points[idx + 1u];
    if (pB.stroke_index == stroke_idx) {
      if (stroke_idx == uniforms.current_stroke_index) {
        let stroke_start_pt = control_points[uniforms.active_stroke_start_index];
        let stroke_end_pt = control_points[uniforms.active_stroke_start_index + uniforms.active_stroke_point_count - 1u];
        let total_len = stroke_end_pt.accumulated_len;
        let target_len = total_len * uniforms.stroke_progress;

        if (pB.accumulated_len <= target_len) {
          write_segment_vertices(out_segment_offset, pA.position, pB.position, width, col);
          segment_written = true;
        } else if (pA.accumulated_len < target_len) {
          is_partial = true;
          let seg_len = pB.accumulated_len - pA.accumulated_len;
          var t = 0.0;
          if (seg_len > 0.0) {
            t = (target_len - pA.accumulated_len) / seg_len;
          }
          partial_target_pos = mix(pA.position, pB.position, t);
          write_segment_vertices(out_segment_offset, pA.position, partial_target_pos, width, col);
          segment_written = true;
        }
      } else {
        write_segment_vertices(out_segment_offset, pA.position, pB.position, width, col);
        segment_written = true;
      }
    }
  }

  if (!segment_written) {
    write_collapsed_vertices(out_segment_offset, 6u);
  }

  // --- 2. JOINT/CAP CIRCLE (at P_A) ---
  if (is_visible) {
    write_circle(out_circle_offset, pA.position, width / 2.0, col);
  } else {
    write_collapsed_vertices(out_circle_offset, 6u);
  }

  // --- 3. ACTIVE TIP CAP (at P'_B) ---
  if (is_partial) {
    write_circle(out_tip_offset, partial_target_pos, width / 2.0, col);
  } else {
    write_collapsed_vertices(out_tip_offset, 6u);
  }
}

fn write_segment_vertices(offset: u32, p1: vec2<f32>, p2: vec2<f32>, width: f32, col: vec4<f32>) {
  let dir = p2 - p1;
  let len = length(dir);
  var normal = vec2<f32>(0.0, 0.0);
  if (len > 0.0) {
    normal = vec2<f32>(-dir.y, dir.x) / len;
  }
  let r = width / 2.0;

  let l1 = p1 + normal * r;
  let r1 = p1 - normal * r;
  let l2 = p2 + normal * r;
  let r2 = p2 - normal * r;

  let uv_zero = vec2<f32>(0.0, 0.0);
  write_vertex(offset + 0u, l1, uv_zero, col);
  write_vertex(offset + 1u, r1, uv_zero, col);
  write_vertex(offset + 2u, l2, uv_zero, col);
  write_vertex(offset + 3u, r1, uv_zero, col);
  write_vertex(offset + 4u, r2, uv_zero, col);
  write_vertex(offset + 5u, l2, uv_zero, col);
}

fn write_circle(offset: u32, center: vec2<f32>, radius: f32, col: vec4<f32>) {
  if (radius <= 0.0) {
    write_collapsed_vertices(offset, 6u);
    return;
  }
  let pad = 1.5;
  let box_r = radius + pad;
  let uv_scale = box_r / radius;

  let p_tl = center + vec2<f32>(-box_r, -box_r);
  let p_bl = center + vec2<f32>(-box_r,  box_r);
  let p_tr = center + vec2<f32>( box_r, -box_r);
  let p_br = center + vec2<f32>( box_r,  box_r);

  let uv_tl = vec2<f32>(-uv_scale, -uv_scale);
  let uv_bl = vec2<f32>(-uv_scale,  uv_scale);
  let uv_tr = vec2<f32>( uv_scale, -uv_scale);
  let uv_br = vec2<f32>( uv_scale,  uv_scale);

  write_vertex(offset + 0u, p_tl, uv_tl, col);
  write_vertex(offset + 1u, p_bl, uv_bl, col);
  write_vertex(offset + 2u, p_tr, uv_tr, col);
  write_vertex(offset + 3u, p_tr, uv_tr, col);
  write_vertex(offset + 4u, p_bl, uv_bl, col);
  write_vertex(offset + 5u, p_br, uv_br, col);
}

fn write_collapsed_vertices(offset: u32, count: u32) {
  for (var i = 0u; i < count; i = i + 1u) {
    output_vertices[offset + i].position = vec2<f32>(0.0, 0.0);
    output_vertices[offset + i].uv = vec2<f32>(0.0, 0.0);
    output_vertices[offset + i].color_r = 0.0;
    output_vertices[offset + i].color_g = 0.0;
    output_vertices[offset + i].color_b = 0.0;
    output_vertices[offset + i].color_a = 0.0;
  }
}

fn write_vertex(index: u32, pos: vec2<f32>, uv: vec2<f32>, col: vec4<f32>) {
  output_vertices[index].position = pos;
  output_vertices[index].uv = uv;
  output_vertices[index].color_r = col.r;
  output_vertices[index].color_g = col.g;
  output_vertices[index].color_b = col.b;
  output_vertices[index].color_a = col.a;
}

struct TrailPoint {
  position: vec2<f32>,
  age: f32,
  radius: f32,
};

struct CometUniforms {
  trail_length: u32,
  control_points_count: u32,
  zoom: f32,
  anti_aliasing: f32,
  pause_progress: f32,
};

@group(0) @binding(4) var<storage, read> trail_history: array<TrailPoint>;
@group(0) @binding(5) var<uniform> comet_uniforms: CometUniforms;

@compute @workgroup_size(64)
fn cs_comet(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let idx = global_id.x;
  if (idx >= comet_uniforms.trail_length) {
    return;
  }

  let pt = trail_history[idx];

  let padding = 45.0 * comet_uniforms.anti_aliasing;
  let draw_size = (512.0 * comet_uniforms.anti_aliasing) - padding * 2.0;
  let scale = draw_size / 109.0;
  let center = vec2<f32>(padding) + pt.position * scale;
  let radius = pt.radius * scale;

  var start_vertex_offset = comet_uniforms.control_points_count * 18u;
  if (idx == comet_uniforms.trail_length - 1u) {
    start_vertex_offset = start_vertex_offset + idx * 6u + 144u;
  } else {
    start_vertex_offset = start_vertex_offset + idx * 6u;
  }

  let trail_alpha = (1.0 - comet_uniforms.pause_progress) * (1.0 - comet_uniforms.pause_progress);
  let c_red = vec4<f32>(239.0/255.0, 68.0/255.0, 68.0/255.0, trail_alpha);
  let c_yellow = vec4<f32>(250.0/255.0, 204.0/255.0, 21.0/255.0, trail_alpha);
  let col = mix(c_yellow, c_red, pt.age);

  write_circle(start_vertex_offset, center, radius, col);
}

@compute @workgroup_size(16)
fn cs_glow(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let idx = global_id.x;
  if (idx >= 16u) {
    return;
  }

  var start_offset = comet_uniforms.control_points_count * 18u;
  if (comet_uniforms.trail_length > 0u) {
    start_offset = start_offset + (comet_uniforms.trail_length - 1u) * 6u;
  }
  start_offset = start_offset + idx * 9u;

  if (comet_uniforms.trail_length == 0u) {
    for (var j = 0u; j < 9u; j = j + 1u) {
      write_vertex(start_offset + j, vec2<f32>(0.0), vec2<f32>(0.0), vec4<f32>(0.0));
    }
    return;
  }

  let tip_idx = comet_uniforms.trail_length - 1u;
  let pt = trail_history[tip_idx];

  let padding = 45.0 * comet_uniforms.anti_aliasing;
  let draw_size = (512.0 * comet_uniforms.anti_aliasing) - padding * 2.0;
  let scale = draw_size / 109.0;

  let center = vec2<f32>(padding) + pt.position * scale;
  let tip_radius = pt.radius * scale;
  let r_mid = tip_radius * 4.5 * 0.5;
  let r_outer = tip_radius * 4.5;

  let glow_alpha = 1.0 - comet_uniforms.pause_progress;
  let a_center = glow_alpha;
  let a_mid = glow_alpha * 0.25;
  let a_outer = 0.0;

  let col = vec4<f32>(250.0/255.0, 204.0/255.0, 21.0/255.0, 1.0);

  let PI = 3.14159265359;
  let angle = (f32(idx) / 16.0) * PI * 2.0;
  let angle_next = (f32(idx + 1u) / 16.0) * PI * 2.0;

  let cos_val = cos(angle);
  let sin_val = sin(angle);
  let cos_next = cos(angle_next);
  let sin_next = sin(angle_next);

  let mid_start = center + vec2<f32>(cos_val, sin_val) * r_mid;
  let mid_end = center + vec2<f32>(cos_next, sin_next) * r_mid;
  let outer_start = center + vec2<f32>(cos_val, sin_val) * r_outer;
  let outer_end = center + vec2<f32>(cos_next, sin_next) * r_outer;

  let uv_zero = vec2<f32>(0.0, 0.0);
  // 1. Inner triangle: center, mid_start, mid_end
  write_vertex(start_offset + 0u, center, uv_zero, vec4<f32>(col.rgb, a_center));
  write_vertex(start_offset + 1u, mid_start, uv_zero, vec4<f32>(col.rgb, a_mid));
  write_vertex(start_offset + 2u, mid_end, uv_zero, vec4<f32>(col.rgb, a_mid));

  // 2. Outer triangle A: mid_start, outer_start, outer_end
  write_vertex(start_offset + 3u, mid_start, uv_zero, vec4<f32>(col.rgb, a_mid));
  write_vertex(start_offset + 4u, outer_start, uv_zero, vec4<f32>(col.rgb, a_outer));
  write_vertex(start_offset + 5u, outer_end, uv_zero, vec4<f32>(col.rgb, a_outer));

  // 3. Outer triangle B: mid_start, outer_end, mid_end
  write_vertex(start_offset + 6u, mid_start, uv_zero, vec4<f32>(col.rgb, a_mid));
  write_vertex(start_offset + 7u, outer_end, uv_zero, vec4<f32>(col.rgb, a_outer));
  write_vertex(start_offset + 8u, mid_end, uv_zero, vec4<f32>(col.rgb, a_mid));
}
`;
