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

pub mod parser;
pub mod choreographer;
pub mod tessellator;

use wasm_bindgen::prelude::*;

#[derive(Clone, Copy, Debug)]
pub struct AnimationControls {
    pub speed: f32,
    pub pause_dur_ms: f32,
    pub glow_intensity: f32,
    pub tip_size_percent: f32,
    pub line_weight: f32,
    pub trail_length: usize,
    pub zoom: f32,
    pub anti_aliasing: u32,
}

#[wasm_bindgen]
pub struct KanjiAnimator {
    strokes: Vec<parser::Stroke>,
    controls: AnimationControls,
    choreographer: choreographer::Choreographer,
    tessellator: tessellator::Tessellator,
}

#[wasm_bindgen]
impl KanjiAnimator {
    #[wasm_bindgen(constructor)]
    pub fn new() -> KanjiAnimator {
        KanjiAnimator {
            strokes: Vec::new(),
            controls: AnimationControls {
                speed: 80.0,
                pause_dur_ms: 300.0,
                glow_intensity: 0.0,
                tip_size_percent: 80.0,
                line_weight: 5.0,
                trail_length: 140,
                zoom: 1.4,
                anti_aliasing: 1,
            },
            choreographer: choreographer::Choreographer::new(),
            tessellator: tessellator::Tessellator::new(),
        }
    }

    fn invalidate_caches(&mut self) {
        self.tessellator.precompute_stroke_geometries(&self.strokes, &self.controls);
        self.tessellator.rebuild_flat_control_points(&self.strokes, &self.controls);
    }

    pub fn get_control_points_ptr(&self) -> *const tessellator::WasmControlPoint {
        self.tessellator.flat_control_points.as_ptr()
    }

    pub fn get_control_points_len(&self) -> usize {
        self.tessellator.flat_control_points.len()
    }

    pub fn get_strokes_meta_ptr(&self) -> *const tessellator::WasmStrokeMeta {
        self.tessellator.flat_strokes_meta.as_ptr()
    }

    pub fn get_strokes_meta_len(&self) -> usize {
        self.tessellator.flat_strokes_meta.len()
    }

    pub fn set_controls(
        &mut self,
        speed: f32,
        pause_dur_ms: f32,
        glow_intensity: f32,
        tip_size_percent: f32,
        line_weight: f32,
        trail_length: usize,
        zoom: f32,
        anti_aliasing: u32,
    ) {
        let needs_invalidate = self.controls.line_weight != line_weight 
            || self.controls.anti_aliasing != anti_aliasing;

        self.controls.speed = speed;
        self.controls.pause_dur_ms = pause_dur_ms;
        self.controls.glow_intensity = glow_intensity;
        self.controls.tip_size_percent = tip_size_percent;
        self.controls.line_weight = line_weight;
        self.controls.trail_length = trail_length;
        self.controls.zoom = zoom;
        self.controls.anti_aliasing = anti_aliasing;

        if needs_invalidate {
            self.invalidate_caches();
        }
    }

    pub fn add_stroke_path(&mut self, d: &str) {
        let polys = parser::parse_to_polylines(d);
        let mut cleaned_polys = Vec::new();
        for p in polys {
            let mut cleaned = parser::clean_polyline(&p);
            if !cleaned.is_empty() {
                parser::compute_polyline_lengths(&mut cleaned);
                cleaned_polys.push(cleaned);
            }
        }
        self.strokes.push(parser::Stroke {
            path_d: d.to_string(),
            polylines: cleaned_polys,
        });
    }

    pub fn clear_strokes(&mut self) {
        self.strokes.clear();
        self.tessellator.clear_tessellation_buffers();
        self.reset_animation();
    }

    pub fn setup_completed_strokes_buffer(&mut self) {
        self.choreographer.stroke_completion_times = vec![None; self.strokes.len()];
        self.choreographer.dry_progress_buffer = vec![1.0; self.strokes.len()];
        self.tessellator.precompute_stroke_geometries(&self.strokes, &self.controls);
        self.tessellator.rebuild_flat_control_points(&self.strokes, &self.controls);
    }

    pub fn reset_animation(&mut self) {
        self.choreographer.reset(self.strokes.len());
        self.tessellator.vertex_buffer.clear();
        for i in 0..self.tessellator.dry_stroke_cache.len() {
            self.tessellator.dry_stroke_cache[i] = None;
        }
    }

    pub fn precompute_stroke_geometries(&mut self) {
        self.tessellator.precompute_stroke_geometries(&self.strokes, &self.controls);
        self.tessellator.rebuild_flat_control_points(&self.strokes, &self.controls);
    }

    pub fn get_guide_stroke_ptr(&self, idx: usize) -> *const f32 {
        if idx >= self.tessellator.guide_stroke_cache.len() {
            return std::ptr::null();
        }
        self.tessellator.guide_stroke_cache[idx].as_ref().map(|v| v.as_ptr()).unwrap_or(std::ptr::null())
    }

    pub fn get_guide_stroke_len(&self, idx: usize) -> usize {
        if idx >= self.tessellator.guide_stroke_cache.len() {
            return 0;
        }
        self.tessellator.guide_stroke_cache[idx].as_ref().map(|v| v.len()).unwrap_or(0)
    }

    pub fn get_dry_stroke_ptr(&self, idx: usize) -> *const f32 {
        if idx >= self.tessellator.dry_stroke_cache.len() {
            return std::ptr::null();
        }
        self.tessellator.dry_stroke_cache[idx].as_ref().map(|v| v.as_ptr()).unwrap_or(std::ptr::null())
    }

    pub fn get_dry_stroke_len(&self, idx: usize) -> usize {
        if idx >= self.tessellator.dry_stroke_cache.len() {
            return 0;
        }
        self.tessellator.dry_stroke_cache[idx].as_ref().map(|v| v.len()).unwrap_or(0)
    }

    pub fn tick(&mut self, dt: f32) -> i32 {
        let needs_rebuild = self.choreographer.tick(dt, &self.strokes, &self.controls);
        if needs_rebuild {
            self.tessellator.rebuild_vertex_buffer(&self.strokes, &self.controls, &self.choreographer);
        }

        let mut finished_idx = -1;
        for i in 0..self.strokes.len() {
            if i < self.choreographer.stroke_completion_times.len() {
                if let Some(t_comp) = self.choreographer.stroke_completion_times[i] {
                    let elapsed_ms = (self.choreographer.anim_time - t_comp) * 1000.0;
                    if elapsed_ms >= self.controls.pause_dur_ms {
                        if i < self.tessellator.dry_stroke_cache.len() && self.tessellator.dry_stroke_cache[i].is_none() {
                            self.tessellator.tessellate_dry_stroke(i, &self.strokes, &self.controls);
                            finished_idx = i as i32;
                            break;
                        }
                    }
                }
            }
        }
        finished_idx
    }

    pub fn start_animation(&mut self) {
        if self.choreographer.current_stroke_index >= self.strokes.len() {
            self.reset_animation();
        }
        self.choreographer.start_animation(self.strokes.len());
    }

    pub fn stop_animation(&mut self) {
        self.choreographer.stop_animation();
    }

    pub fn step_forward(&mut self) {
        self.choreographer.step_forward(&self.strokes);
        self.tessellator.rebuild_vertex_buffer(&self.strokes, &self.controls, &self.choreographer);
    }

    pub fn step_backward(&mut self) -> i32 {
        let deleted_idx = self.choreographer.step_backward(&self.strokes);
        if deleted_idx >= 0 {
            let idx = deleted_idx as usize;
            if idx < self.tessellator.dry_stroke_cache.len() {
                self.tessellator.dry_stroke_cache[idx] = None;
            }
        }
        self.tessellator.rebuild_vertex_buffer(&self.strokes, &self.controls, &self.choreographer);
        deleted_idx
    }

    pub fn is_stroke_dry(&self, idx: usize) -> bool {
        if idx >= self.strokes.len() {
            return false;
        }
        if idx < self.choreographer.dry_progress_buffer.len() {
            self.choreographer.dry_progress_buffer[idx] >= 1.0 && self.choreographer.stroke_completion_times[idx].is_some()
        } else {
            false
        }
    }

    pub fn tessellate_dry_stroke(&mut self, idx: usize) {
        self.tessellator.tessellate_dry_stroke(idx, &self.strokes, &self.controls);
    }

    pub fn get_vertices_ptr(&self) -> *const f32 {
        self.tessellator.vertex_buffer.as_ptr()
    }

    pub fn get_vertices_len(&self) -> usize {
        self.tessellator.vertex_buffer.len()
    }

    pub fn get_trail_ptr(&self) -> *const f32 {
        self.choreographer.trail_buffer.as_ptr()
    }

    pub fn get_trail_len(&self) -> usize {
        self.choreographer.trail_buffer.len()
    }

    pub fn get_dry_progress_ptr(&self) -> *const f32 {
        self.choreographer.dry_progress_buffer.as_ptr()
    }

    pub fn get_dry_progress_len(&self) -> usize {
        self.choreographer.dry_progress_buffer.len()
    }

    pub fn current_stroke_index(&self) -> usize {
        self.choreographer.current_stroke_index
    }

    pub fn stroke_progress(&self) -> f32 {
        self.choreographer.stroke_progress
    }

    pub fn current_stroke_count(&self) -> usize {
        self.strokes.len()
    }

    pub fn is_animating(&self) -> bool {
        self.choreographer.is_animating
    }

    pub fn is_single_stroke_animating(&self) -> bool {
        self.choreographer.is_single_stroke_animating
    }

    pub fn is_any_stroke_drying(&self) -> bool {
        self.choreographer.is_any_stroke_drying
    }

    pub fn anim_time(&self) -> f32 {
        self.choreographer.anim_time
    }

    pub fn pause_progress(&self) -> f32 {
        self.choreographer.pause_progress(&self.strokes, &self.controls)
    }

    pub fn active_tip_x(&self) -> f32 {
        self.choreographer.active_tip_x(&self.strokes, &self.controls)
    }

    pub fn active_tip_y(&self) -> f32 {
        self.choreographer.active_tip_y(&self.strokes, &self.controls)
    }
}
