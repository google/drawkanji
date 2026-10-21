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

use std::collections::VecDeque;
use crate::parser::{Point, Stroke};
use crate::AnimationControls;

pub struct Choreographer {
    pub current_stroke_index: usize,
    pub stroke_progress: f32,
    pub stroke_time_elapsed_ms: f32,
    pub stroke_tip_history: VecDeque<Point>,
    pub stroke_completion_times: Vec<Option<f32>>,
    pub anim_time: f32,
    pub is_animating: bool,
    pub is_single_stroke_animating: bool,
    pub is_any_stroke_drying: bool,
    pub trail_buffer: Vec<f32>,
    pub dry_progress_buffer: Vec<f32>,
}

impl Choreographer {
    pub fn new() -> Self {
        Choreographer {
            current_stroke_index: 0,
            stroke_progress: 0.0,
            stroke_time_elapsed_ms: 0.0,
            stroke_tip_history: VecDeque::new(),
            stroke_completion_times: Vec::new(),
            anim_time: 0.0,
            is_animating: false,
            is_single_stroke_animating: false,
            is_any_stroke_drying: false,
            trail_buffer: Vec::new(),
            dry_progress_buffer: Vec::new(),
        }
    }

    pub fn reset(&mut self, stroke_count: usize) {
        self.current_stroke_index = 0;
        self.stroke_progress = 0.0;
        self.stroke_time_elapsed_ms = 0.0;
        self.stroke_tip_history.clear();
        self.stroke_completion_times = vec![None; stroke_count];
        self.dry_progress_buffer = vec![1.0; stroke_count];
        self.is_any_stroke_drying = false;
        self.trail_buffer.clear();
    }

    pub fn tick(&mut self, dt: f32, strokes: &[Stroke], controls: &AnimationControls) -> bool {
        self.anim_time += dt;

        let mut needs_rebuild = false;

        if self.is_animating && self.current_stroke_index < strokes.len() {
            needs_rebuild = true;
            let current_stroke = &strokes[self.current_stroke_index];
            
            let mut total_length = 0.0;
            if !current_stroke.polylines.is_empty() {
                let last_poly = &current_stroke.polylines[current_stroke.polylines.len() - 1];
                if !last_poly.is_empty() {
                    total_length = last_poly[last_poly.len() - 1].len;
                }
            }

            let stroke_duration = if total_length > 0.0 {
                (total_length / controls.speed) * 1000.0
            } else {
                100.0
            };

            let step_duration = stroke_duration + controls.pause_dur_ms;
            self.stroke_time_elapsed_ms += dt * 1000.0;
            self.stroke_progress = (self.stroke_time_elapsed_ms / stroke_duration).min(1.0);

            if self.stroke_time_elapsed_ms <= stroke_duration {
                let current_length = total_length * self.stroke_progress;
                if let Some(pt) = self.get_point_at_length(strokes, self.current_stroke_index, current_length) {
                    self.stroke_tip_history.push_back(pt);
                    if self.stroke_tip_history.len() > controls.trail_length {
                        self.stroke_tip_history.pop_front();
                    }
                }
            }

            if self.stroke_time_elapsed_ms >= step_duration {
                let dry_offset = if self.is_single_stroke_animating { controls.pause_dur_ms / 1000.0 } else { 0.0 };
                if self.current_stroke_index < self.stroke_completion_times.len() {
                    self.stroke_completion_times[self.current_stroke_index] = Some(self.anim_time - dry_offset);
                }
                
                self.current_stroke_index += 1;
                self.stroke_progress = 0.0;
                self.stroke_time_elapsed_ms = 0.0;
                self.stroke_tip_history.clear();

                if self.current_stroke_index >= strokes.len() {
                    self.current_stroke_index = strokes.len();
                    self.stroke_progress = 1.0;
                    self.is_animating = false;
                    self.is_single_stroke_animating = false;
                } else if self.is_single_stroke_animating {
                    self.is_animating = false;
                    self.is_single_stroke_animating = false;
                }
            }
        }

        let mut any_drying = false;
        for i in 0..strokes.len() {
            if i < self.stroke_completion_times.len() {
                if let Some(t_comp) = self.stroke_completion_times[i] {
                    let elapsed_ms = (self.anim_time - t_comp) * 1000.0;
                    let dry_progress = (elapsed_ms / controls.pause_dur_ms).min(1.0);
                    if i < self.dry_progress_buffer.len() {
                        self.dry_progress_buffer[i] = dry_progress;
                    }
                    if elapsed_ms < controls.pause_dur_ms {
                        any_drying = true;
                    }
                } else {
                    if i < self.dry_progress_buffer.len() {
                        self.dry_progress_buffer[i] = 1.0;
                    }
                }
            }
        }

        self.is_any_stroke_drying = any_drying;

        self.trail_buffer.clear();
        let l = self.stroke_tip_history.len();
        if l > 0 {
            let active_stroke_width_unscaled = controls.line_weight * (8.0 / 6.5);
            let radius_unscaled = active_stroke_width_unscaled * (controls.tip_size_percent / 100.0) / 2.0;
            let pause_progress = self.pause_progress(strokes, controls);

            for (i, pt) in self.stroke_tip_history.iter().enumerate() {
                let mut t = if l > 1 { i as f32 / (l - 1) as f32 } else { 0.0 };
                t *= 1.0 - pause_progress;
                let r = radius_unscaled * (0.35 + 0.65 * t);
                self.trail_buffer.push(pt.x);
                self.trail_buffer.push(pt.y);
                self.trail_buffer.push(t);
                self.trail_buffer.push(r);
            }
        }

        needs_rebuild || any_drying || self.stroke_progress > 0.0
    }

    pub fn get_point_at_length(&self, strokes: &[Stroke], stroke_idx: usize, target_len: f32) -> Option<Point> {
        if stroke_idx >= strokes.len() { return None; }
        let stroke = &strokes[stroke_idx];
        if stroke.polylines.is_empty() { return None; }

        for poly in &stroke.polylines {
            if poly.is_empty() { continue; }
            let first = poly[0];
            let last = poly[poly.len() - 1];
            if target_len >= first.len && target_len <= last.len {
                for i in 1..poly.len() {
                    if poly[i].len >= target_len {
                        let prev = poly[i-1];
                        let next = poly[i];
                        if (next.len - prev.len).abs() < 1e-6 {
                            return Some(prev);
                        }
                        let ratio = (target_len - prev.len) / (next.len - prev.len);
                        return Some(Point {
                            x: prev.x + ratio * (next.x - prev.x),
                            y: prev.y + ratio * (next.y - prev.y),
                            len: target_len,
                        });
                    }
                }
            }
        }
        
        for poly in stroke.polylines.iter().rev() {
            if !poly.is_empty() {
                return Some(poly[poly.len() - 1]);
            }
        }
        None
    }

    pub fn pause_progress(&self, strokes: &[Stroke], controls: &AnimationControls) -> f32 {
        if self.current_stroke_index >= strokes.len() {
            return 0.0;
        }
        let current_stroke = &strokes[self.current_stroke_index];
        let mut total_length = 0.0;
        if !current_stroke.polylines.is_empty() {
            let last_poly = &current_stroke.polylines[current_stroke.polylines.len() - 1];
            if !last_poly.is_empty() {
                total_length = last_poly[last_poly.len() - 1].len;
            }
        }
        let stroke_duration = if total_length > 0.0 {
            (total_length / controls.speed) * 1000.0
        } else {
            100.0
        };
        if self.stroke_time_elapsed_ms > stroke_duration {
            ((self.stroke_time_elapsed_ms - stroke_duration) / controls.pause_dur_ms).min(1.0)
        } else {
            0.0
        }
    }

    pub fn active_tip_x(&self, strokes: &[Stroke], _controls: &AnimationControls) -> f32 {
        let mut total_length = 0.0;
        if self.current_stroke_index < strokes.len() {
            let current_stroke = &strokes[self.current_stroke_index];
            if !current_stroke.polylines.is_empty() {
                let last_poly = &current_stroke.polylines[current_stroke.polylines.len() - 1];
                if !last_poly.is_empty() {
                    total_length = last_poly[last_poly.len() - 1].len;
                }
            }
        }
        let current_length = total_length * self.stroke_progress;
        if let Some(pt) = self.get_point_at_length(strokes, self.current_stroke_index, current_length) {
            pt.x
        } else {
            0.0
        }
    }

    pub fn active_tip_y(&self, strokes: &[Stroke], _controls: &AnimationControls) -> f32 {
        let mut total_length = 0.0;
        if self.current_stroke_index < strokes.len() {
            let current_stroke = &strokes[self.current_stroke_index];
            if !current_stroke.polylines.is_empty() {
                let last_poly = &current_stroke.polylines[current_stroke.polylines.len() - 1];
                if !last_poly.is_empty() {
                    total_length = last_poly[last_poly.len() - 1].len;
                }
            }
        }
        let current_length = total_length * self.stroke_progress;
        if let Some(pt) = self.get_point_at_length(strokes, self.current_stroke_index, current_length) {
            pt.y
        } else {
            0.0
        }
    }

    pub fn start_animation(&mut self, stroke_count: usize) {
        if self.is_animating { return; }
        self.is_single_stroke_animating = false;
        if self.current_stroke_index >= stroke_count {
            self.reset(stroke_count);
        }
        self.is_animating = true;
    }

    pub fn stop_animation(&mut self) {
        self.is_animating = false;
        self.is_single_stroke_animating = false;
    }

    pub fn step_forward(&mut self, strokes: &[Stroke]) {
        if self.is_animating { return; }
        if self.current_stroke_index < strokes.len() {
            if self.stroke_progress >= 1.0 {
                self.current_stroke_index += 1;
                if self.current_stroke_index >= strokes.len() {
                    return;
                }
            }
            self.stroke_progress = 0.0;
            self.stroke_time_elapsed_ms = 0.0;
            self.stroke_tip_history.clear();
            self.is_animating = true;
            self.is_single_stroke_animating = true;
        }
    }

    pub fn step_backward(&mut self, strokes: &[Stroke]) -> i32 {
        self.stop_animation();
        if self.current_stroke_index >= strokes.len() {
            self.current_stroke_index = strokes.len() - 1;
            self.stroke_progress = 0.0;
            self.stroke_time_elapsed_ms = 0.0;
            self.stroke_tip_history.clear();
            if self.current_stroke_index < self.stroke_completion_times.len() {
                self.stroke_completion_times[self.current_stroke_index] = None;
            }
            return self.current_stroke_index as i32;
        } else if self.stroke_progress > 0.0 {
            self.stroke_progress = 0.0;
            self.stroke_time_elapsed_ms = 0.0;
            self.stroke_tip_history.clear();
            return -1;
        } else if self.current_stroke_index > 0 {
            self.current_stroke_index -= 1;
            self.stroke_progress = 0.0;
            self.stroke_time_elapsed_ms = 0.0;
            self.stroke_tip_history.clear();
            if self.current_stroke_index < self.stroke_completion_times.len() {
                self.stroke_completion_times[self.current_stroke_index] = None;
            }
            return self.current_stroke_index as i32;
        }
        -1
    }
}
