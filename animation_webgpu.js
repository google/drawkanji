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

const wgslShaders = `
struct Uniforms {
  glowIntensity: f32,
  zoom: f32,
  time: f32,
  aspectRatio: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var myTexture: texture_2d<f32>;
@group(0) @binding(2) var mySampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) localPos: vec3<f32>,
};

@vertex
fn vs_main(@location(0) pos: vec3<f32>, @location(1) uv: vec2<f32>) -> VertexOutput {
  var out: VertexOutput;
  var scaledPos = pos.xy;
  if (uniforms.aspectRatio > 1.0) {
    scaledPos.x = scaledPos.x / uniforms.aspectRatio;
  } else {
    scaledPos.y = scaledPos.y * uniforms.aspectRatio;
  }
  out.position = vec4<f32>(scaledPos * uniforms.zoom, pos.z, 1.0);
  out.uv = uv;
  out.localPos = pos;
  return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let strokeColor = textureSample(myTexture, mySampler, input.uv).rgb;
  let strokeMask = clamp(max(strokeColor.r, max(strokeColor.g, strokeColor.b)), 0.0, 1.0);
  var gradientCoord = input.uv.y + sin(input.uv.x * 3.0 + uniforms.time * 2.0) * 0.12;
  gradientCoord = clamp(gradientCoord, 0.0, 1.0);
  let themeColor = mix(vec3<f32>(0.388, 0.400, 0.945), vec3<f32>(0.659, 0.333, 0.969), gradientCoord);
  let borderDistX = 1.0 - abs(input.localPos.x);
  let borderDistY = 1.0 - abs(input.localPos.y);
  let minDist = min(borderDistX, borderDistY);
  let borderMask = 1.0 - smoothstep(0.0, 0.015, minDist);
  let gridVal = sin(input.localPos.x * 24.0) * sin(input.localPos.y * 24.0);
  let gridLine = smoothstep(0.97, 1.0, gridVal) * 0.06;
  let glassBase = vec3<f32>(0.043, 0.063, 0.110) + vec3<f32>(gridLine);
  let borderGlow = themeColor * borderMask * 1.5 * uniforms.glowIntensity;
  let glassBody = mix(glassBase, borderGlow, borderMask);
  let finalGlyphColor = strokeColor * (1.2 + uniforms.glowIntensity * 1.0);
  let finalRGB = glassBody * (1.0 - strokeMask) + finalGlyphColor;
  let finalAlpha = mix(0.72 + borderMask * 0.28, 0.96, strokeMask);
  return vec4<f32>(finalRGB, finalAlpha);
}
`;

const drawShaderCode = `
struct Uniforms {
  aspectRatio: f32,
  textureSize: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  let halfSize = uniforms.textureSize / 2.0;
  var pos = vec2<f32>(
    (input.position.x / halfSize) - 1.0,
    1.0 - (input.position.y / halfSize)
  );
  if (uniforms.aspectRatio > 0.0) {
    pos.x = pos.x / uniforms.aspectRatio;
  }
  out.position = vec4<f32>(pos, 0.0, 1.0);
  out.uv = input.uv;
  out.color = input.color;
  return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let dist = length(input.uv);
  let delta = fwidth(dist);
  let circleAlpha = 1.0 - smoothstep(1.0 - delta, 1.0, dist);
  let isCircle = select(0.0, 1.0, dist > 0.0);
  let alpha = mix(1.0, circleAlpha, isCircle);
  return vec4<f32>(input.color.rgb, input.color.a * alpha);
}
`;

async function initWebGPU() {
  const canvas = AppState.canvas;
  AppState.context = canvas.getContext('webgpu');
  AppState.presentationFormat = navigator.gpu.getPreferredCanvasFormat();

  resizeCanvas(canvas);

  AppState.context.configure({
    device: AppState.device,
    format: AppState.presentationFormat,
    alphaMode: 'premultiplied'
  });

  const glyphSize = 512;
  AppState.glyphTexture = AppState.device.createTexture({
    size: [glyphSize * AppState.antiAliasingFactor, glyphSize * AppState.antiAliasingFactor, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
  });
  AppState.glyphTextureView = AppState.glyphTexture.createView();

  AppState.sampler = AppState.device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear'
  });

  const vertexData = new Float32Array([
    -0.85,  0.85, 0.0,  0.0, 0.0,
    -0.85, -0.85, 0.0,  0.0, 1.0,
     0.85,  0.85, 0.0,  1.0, 0.0,
     0.85, -0.85, 0.0,  1.0, 1.0,
  ]);

  AppState.vertexBuffer = AppState.device.createBuffer({
    size: vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX,
    mappedAtCreation: true
  });
  new Float32Array(AppState.vertexBuffer.getMappedRange()).set(vertexData);
  AppState.vertexBuffer.unmap();

  const indexData = new Uint16Array([
    0, 1, 2,
    2, 1, 3
  ]);

  AppState.indexBuffer = AppState.device.createBuffer({
    size: indexData.byteLength,
    usage: GPUBufferUsage.INDEX,
    mappedAtCreation: true
  });
  new Uint16Array(AppState.indexBuffer.getMappedRange()).set(indexData);
  AppState.indexBuffer.unmap();

  const uniformBufferSize = 16;
  AppState.uniformBuffer = AppState.device.createBuffer({
    size: uniformBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  AppState.uniformData = new ArrayBuffer(uniformBufferSize);
  AppState.uniformFloatView = new Float32Array(AppState.uniformData);

  const shaderModule = AppState.device.createShaderModule({
    code: wgslShaders
  });

  AppState.pipeline = AppState.device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: 20,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x2' }
          ]
        }
      ]
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [
        {
          format: AppState.presentationFormat,
          blend: {
            color: {
              srcFactor: 'src-alpha',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add'
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add'
            }
          }
        }
      ]
    },
    primitive: {
      topology: 'triangle-list',
      cullMode: 'none'
    }
  });

  AppState.bindGroup = AppState.device.createBindGroup({
    layout: AppState.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: AppState.uniformBuffer } },
      { binding: 1, resource: AppState.glyphTextureView },
      { binding: 2, resource: AppState.sampler }
    ]
  });

  AppState.drawVertexBuffer = AppState.device.createBuffer({
    size: 50000 * 32,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
  });

  AppState.drawUniformBuffer = AppState.device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  const drawShaderModule = AppState.device.createShaderModule({
    code: drawShaderCode
  });

  AppState.drawPipeline = AppState.device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: drawShaderModule,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
            { shaderLocation: 2, offset: 16, format: 'float32x4' }
          ]
        }
      ]
    },
    fragment: {
      module: drawShaderModule,
      entryPoint: 'fs_main',
      targets: [
        {
          format: 'rgba8unorm',
          blend: {
            color: {
              srcFactor: 'src-alpha',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add'
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add'
            }
          }
        }
      ]
    },
    primitive: {
      topology: 'triangle-list',
      cullMode: 'none'
    }
  });

  AppState.drawBindGroup = AppState.device.createBindGroup({
    layout: AppState.drawPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: AppState.drawUniformBuffer } }
    ]
  });

  const computeShaderModule = AppState.device.createShaderModule({
    code: computeShaderCode
  });

  computeShaderModule.getCompilationInfo().then((info) => {
    for (const msg of info.messages) {
      const logFn = msg.type === 'error' ? console.error : (msg.type === 'warning' ? console.warn : console.log);
      logFn(`Compute WGSL [${msg.type}] at line ${msg.lineNum}:${msg.linePos} - ${msg.message}`);
    }
  });

  AppState.computePipeline = AppState.device.createComputePipeline({
    label: 'mainComputePipeline',
    layout: 'auto',
    compute: {
      module: computeShaderModule,
      entryPoint: 'cs_main'
    }
  });

  AppState.cometComputePipeline = AppState.device.createComputePipeline({
    label: 'cometComputePipeline',
    layout: 'auto',
    compute: {
      module: computeShaderModule,
      entryPoint: 'cs_comet'
    }
  });

  AppState.glowComputePipeline = AppState.device.createComputePipeline({
    label: 'glowComputePipeline',
    layout: 'auto',
    compute: {
      module: computeShaderModule,
      entryPoint: 'cs_glow'
    }
  });

  AppState.guideComputePipeline = AppState.device.createComputePipeline({
    label: 'guideComputePipeline',
    layout: 'auto',
    compute: {
      module: computeShaderModule,
      entryPoint: 'cs_guide'
    }
  });

  AppState.dryComputePipeline = AppState.device.createComputePipeline({
    label: 'dryComputePipeline',
    layout: 'auto',
    compute: {
      module: computeShaderModule,
      entryPoint: 'cs_dry_stroke'
    }
  });

  // Pre-allocate Compute Uniform Buffer (48 bytes)
  AppState.computeUniformBuffer = AppState.device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  AppState.computeUniformData = new ArrayBuffer(48);
  AppState.computeUniformFloatView = new Float32Array(AppState.computeUniformData);

  // Pre-allocate Dry Uniform Buffer (48 bytes)
  AppState.dryUniformBuffer = AppState.device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  // Pre-allocate Comet Uniform Buffer (32 bytes: trail_length, control_points_count, zoom, anti_aliasing, pause_progress, and padding)
  AppState.cometUniformBuffer = AppState.device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  AppState.cometUniformData = new ArrayBuffer(32);
  AppState.cometUniformFloatView = new Float32Array(AppState.cometUniformData);

  // Pre-allocate Trail History Buffer (max 250 trail points, each 16 bytes: x, y, age, radius)
  AppState.trailHistoryBuffer = AppState.device.createBuffer({
    size: 250 * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
}

function recreateGlyphTexture(factor) {
  if (!AppState.device) return;
  AppState.antiAliasingFactor = factor;
  if (AppState.glyphTexture) {
    try {
      AppState.glyphTexture.destroy();
    } catch (e) {
      console.error(e);
    }
  }
  const glyphSize = 512;
  AppState.glyphTexture = AppState.device.createTexture({
    size: [glyphSize * AppState.antiAliasingFactor, glyphSize * AppState.antiAliasingFactor, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
  });
  AppState.glyphTextureView = AppState.glyphTexture.createView();
  AppState.bindGroup = AppState.device.createBindGroup({
    layout: AppState.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: AppState.uniformBuffer } },
      { binding: 1, resource: AppState.glyphTextureView },
      { binding: 2, resource: AppState.sampler }
    ]
  });
}

function resetCanvasContext(type) {
  const oldCanvas = document.getElementById('gpu-canvas');
  const newCanvas = oldCanvas.cloneNode(true);
  
  if (type === 'webgpu') {
    newCanvas.classList.remove('fallback-mode');
  } else {
    newCanvas.classList.add('fallback-mode');
  }
  
  oldCanvas.parentNode.replaceChild(newCanvas, oldCanvas);
  AppState.canvas = newCanvas;
  
  resizeCanvas(AppState.canvas);
  
  if (type === 'webgpu') {
    AppState.context = AppState.canvas.getContext('webgpu');
    AppState.context.configure({
      device: AppState.device,
      format: AppState.presentationFormat,
      alphaMode: 'premultiplied'
    });
    AppState.visibleCtx = null;
  } else {
    AppState.visibleCtx = AppState.canvas.getContext('2d');
    AppState.context = null;
  }
}

function resizeCanvas(canvas) {
  const devicePixelRatio = window.devicePixelRatio || 1;
  const targetWidth = canvas.clientWidth * devicePixelRatio;
  const targetHeight = canvas.clientHeight * devicePixelRatio;
  
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
}
