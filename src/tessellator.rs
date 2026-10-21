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

use crate::parser::{Point, Stroke, truncate_polyline};
use crate::AnimationControls;
use crate::choreographer::Choreographer;

const GLOW_RADIUS_MULTIPLIER: f32 = 4.5;

#[derive(Clone, Copy, Debug)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct WasmControlPoint {
    pub x: f32,
    pub y: f32,
    pub stroke_index: u32,
    pub accumulated_len: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct WasmStrokeMeta {
    pub start_index: u32,
    pub point_count: u32,
    pub line_weight: f32,
    pub _pad: f32,
}

pub struct Tessellator {
    pub vertex_buffer: Vec<f32>,
    pub dry_stroke_cache: Vec<Option<Vec<f32>>>,
    pub guide_stroke_cache: Vec<Option<Vec<f32>>>,
    pub flat_control_points: Vec<WasmControlPoint>,
    pub flat_strokes_meta: Vec<WasmStrokeMeta>,
}

impl Tessellator {
    pub fn new() -> Self {
        Tessellator {
            vertex_buffer: Vec::new(),
            dry_stroke_cache: Vec::new(),
            guide_stroke_cache: Vec::new(),
            flat_control_points: Vec::new(),
            flat_strokes_meta: Vec::new(),
        }
    }

    pub fn clear_tessellation_buffers(&mut self) {
        self.vertex_buffer.clear();
        self.vertex_buffer.shrink_to_fit();
        for i in 0..self.dry_stroke_cache.len() {
            self.dry_stroke_cache[i] = None;
        }
        for i in 0..self.guide_stroke_cache.len() {
            self.guide_stroke_cache[i] = None;
        }
    }

    pub fn rebuild_flat_control_points(&mut self, strokes: &[Stroke], controls: &AnimationControls) {
        self.flat_control_points.clear();
        self.flat_strokes_meta.clear();

        let factor = controls.anti_aliasing as f32;
        let padding = 45.0 * factor;
        let draw_size = (512.0 * factor) - padding * 2.0;
        let scale = draw_size / 109.0;

        let mut current_point_index = 0u32;

        for (stroke_idx, stroke) in strokes.iter().enumerate() {
            let start_idx = current_point_index;
            let mut point_count = 0u32;

            for poly in &stroke.polylines {
                for pt in poly {
                    let x = padding + pt.x * scale;
                    let y = padding + pt.y * scale;

                    self.flat_control_points.push(WasmControlPoint {
                        x,
                        y,
                        stroke_index: stroke_idx as u32,
                        accumulated_len: pt.len * scale,
                    });
                    point_count += 1;
                    current_point_index += 1;
                }
            }

            self.flat_strokes_meta.push(WasmStrokeMeta {
                start_index: start_idx,
                point_count,
                line_weight: controls.line_weight * scale,
                _pad: 0.0,
            });
        }
    }

    pub fn precompute_stroke_geometries(&mut self, strokes: &[Stroke], controls: &AnimationControls) {
        let factor = controls.anti_aliasing as f32;
        let padding = 45.0 * factor;
        let draw_size = (512.0 * factor) - padding * 2.0;
        let scale = draw_size / 109.0;

        let map_coords = |poly: &[Point]| -> Vec<Point> {
            poly.iter().map(|pt| Point {
                x: padding + pt.x * scale,
                y: padding + pt.y * scale,
                len: pt.len * scale,
            }).collect()
        };

        let guide_stroke_width = 4.0 * scale;
        let c_guide = Color { r: 1.0, g: 1.0, b: 1.0, a: 0.08 };

        self.guide_stroke_cache = vec![None; strokes.len()];
        self.dry_stroke_cache = vec![None; strokes.len()];

        for i in 0..strokes.len() {
            let mut guide_verts = Vec::new();
            for poly in &strokes[i].polylines {
                if poly.len() < 2 { continue; }
                let mapped = map_coords(poly);
                tessellate_stroke(&mapped, guide_stroke_width, c_guide, &mut guide_verts);
            }
            self.guide_stroke_cache[i] = Some(guide_verts);
        }
    }

    pub fn tessellate_dry_stroke(&mut self, idx: usize, strokes: &[Stroke], controls: &AnimationControls) {
        if idx >= strokes.len() || idx >= self.dry_stroke_cache.len() {
            return;
        }

        let factor = controls.anti_aliasing as f32;
        let padding = 45.0 * factor;
        let draw_size = (512.0 * factor) - padding * 2.0;
        let scale = draw_size / 109.0;

        let map_coords = |poly: &[Point]| -> Vec<Point> {
            poly.iter().map(|pt| Point {
                x: padding + pt.x * scale,
                y: padding + pt.y * scale,
                len: pt.len * scale,
            }).collect()
        };

        let dry_stroke_width = controls.line_weight * scale;
        let c_blue = Color { r: 56.0/255.0, g: 189.0/255.0, b: 248.0/255.0, a: 1.0 };

        let mut dry_verts = Vec::new();
        for poly in &strokes[idx].polylines {
            if poly.len() < 2 { continue; }
            let mapped = map_coords(poly);
            tessellate_stroke(&mapped, dry_stroke_width, c_blue, &mut dry_verts);
        }
        self.dry_stroke_cache[idx] = Some(dry_verts);
    }

    pub fn rebuild_vertex_buffer(&mut self, strokes: &[Stroke], controls: &AnimationControls, choreographer: &Choreographer) {
        self.vertex_buffer.clear();

        let factor = controls.anti_aliasing as f32;
        let padding = 45.0 * factor;
        let draw_size = (512.0 * factor) - padding * 2.0;
        let scale = draw_size / 109.0;

        let map_coords = |poly: &[Point]| -> Vec<Point> {
            poly.iter().map(|pt| Point {
                x: padding + pt.x * scale,
                y: padding + pt.y * scale,
                len: pt.len * scale,
            }).collect()
        };

        let active_stroke_width = controls.line_weight * (8.0 / 6.5) * scale;
        let dry_stroke_width = controls.line_weight * scale;

        let c_yellow = Color { r: 250.0/255.0, g: 204.0/255.0, b: 21.0/255.0, a: 1.0 };
        let c_blue = Color { r: 56.0/255.0, g: 189.0/255.0, b: 248.0/255.0, a: 1.0 };

        for i in 0..choreographer.current_stroke_index {
            if i < choreographer.dry_progress_buffer.len() {
                let dry_progress = choreographer.dry_progress_buffer[i];
                if dry_progress < 1.0 {
                    let col = Color {
                        r: c_yellow.r + (c_blue.r - c_yellow.r) * dry_progress,
                        g: c_yellow.g + (c_blue.g - c_yellow.g) * dry_progress,
                        b: c_yellow.b + (c_blue.b - c_yellow.b) * dry_progress,
                        a: 1.0,
                    };
                    let w = active_stroke_width - (active_stroke_width - dry_stroke_width) * dry_progress;
                    for poly in &strokes[i].polylines {
                        if poly.len() < 2 { continue; }
                        let mapped = map_coords(poly);
                        tessellate_stroke(&mapped, w, col, &mut self.vertex_buffer);
                    }
                }
            }
        }

        if choreographer.current_stroke_index < strokes.len() && choreographer.stroke_progress > 0.0 {
            let current_stroke = &strokes[choreographer.current_stroke_index];
            
            let mut total_length = 0.0;
            if !current_stroke.polylines.is_empty() {
                let last_poly = &current_stroke.polylines[current_stroke.polylines.len() - 1];
                if !last_poly.is_empty() {
                    total_length = last_poly[last_poly.len() - 1].len;
                }
            }

            let current_length = total_length * choreographer.stroke_progress;
            let diameter = active_stroke_width * (controls.tip_size_percent / 100.0);
            let radius = diameter / 2.0;

            let stroke_duration = if total_length > 0.0 {
                (total_length / controls.speed) * 1000.0
            } else {
                100.0
            };

            let mut pause_progress = 0.0;
            if choreographer.stroke_time_elapsed_ms > stroke_duration {
                pause_progress = ((choreographer.stroke_time_elapsed_ms - stroke_duration) / controls.pause_dur_ms).min(1.0);
            }

            let mut rem_len = current_length;
            for poly in &current_stroke.polylines {
                if poly.is_empty() { continue; }
                let total_poly_len = poly[poly.len() - 1].len;
                
                let dry_prog = if choreographer.is_single_stroke_animating { pause_progress } else { 0.0 };
                let w = active_stroke_width - (active_stroke_width - dry_stroke_width) * dry_prog;
                let col = Color {
                    r: c_yellow.r + (c_blue.r - c_yellow.r) * dry_prog,
                    g: c_yellow.g + (c_blue.g - c_yellow.g) * dry_prog,
                    b: c_yellow.b + (c_blue.b - c_yellow.b) * dry_prog,
                    a: 1.0,
                };

                let mapped = map_coords(poly);
                let truncated = truncate_polyline(&mapped, rem_len * scale);
                if truncated.len() >= 2 {
                    tessellate_stroke(&truncated, w, col, &mut self.vertex_buffer);
                }
                rem_len -= total_poly_len;
            }

            let l = choreographer.stroke_tip_history.len();
            if l > 1 {
                let trail_alpha = (1.0 - pause_progress).powi(2);
                for j in 0..l - 1 {
                    let idx = j * 4;
                    if idx + 3 < choreographer.trail_buffer.len() {
                        let pt_x = choreographer.trail_buffer[idx];
                        let pt_y = choreographer.trail_buffer[idx + 1];
                        let t = choreographer.trail_buffer[idx + 2];
                        let r = choreographer.trail_buffer[idx + 3];

                        let pt_canvas_x = padding + pt_x * scale;
                        let pt_canvas_y = padding + pt_y * scale;
                        let r_pt = r * scale;

                        let c_red = Color { r: 239.0/255.0, g: 68.0/255.0, b: 68.0/255.0, a: 1.0 };
                        let col = Color {
                            r: c_yellow.r + (c_red.r - c_yellow.r) * t,
                            g: c_yellow.g + (c_red.g - c_yellow.g) * t,
                            b: c_yellow.b + (c_red.b - c_yellow.b) * t,
                            a: trail_alpha,
                        };
                        append_circle_geometry(pt_canvas_x, pt_canvas_y, r_pt, col, &mut self.vertex_buffer);
                    }
                }
            }

            let tip_pt_canvas_opt = if l > 0 {
                let idx = (l - 1) * 4;
                if idx + 3 < choreographer.trail_buffer.len() {
                    let pt_x = choreographer.trail_buffer[idx];
                    let pt_y = choreographer.trail_buffer[idx + 1];
                    let r = choreographer.trail_buffer[idx + 3];
                    Some((padding + pt_x * scale, padding + pt_y * scale, r * scale))
                } else {
                    None
                }
            } else if let Some(point) = choreographer.get_point_at_length(strokes, choreographer.current_stroke_index, current_length) {
                Some((padding + point.x * scale, padding + point.y * scale, radius))
            } else {
                None
            };

            if let Some((pt_canvas_x, pt_canvas_y, tip_radius)) = tip_pt_canvas_opt {
                let glow_radius = tip_radius * GLOW_RADIUS_MULTIPLIER;
                let glow_alpha = 1.0 - pause_progress;

                if glow_radius > 0.0 && glow_alpha > 0.0 {
                    let glow_color = Color { r: c_yellow.r, g: c_yellow.g, b: c_yellow.b, a: glow_alpha };
                    append_glow_circle_geometry(pt_canvas_x, pt_canvas_y, glow_radius, glow_color, &mut self.vertex_buffer);
                }
            }

            if l > 0 {
                let idx = (l - 1) * 4;
                if idx + 3 < choreographer.trail_buffer.len() {
                    let pt_x = choreographer.trail_buffer[idx];
                    let pt_y = choreographer.trail_buffer[idx + 1];
                    let t = choreographer.trail_buffer[idx + 2];
                    let r = choreographer.trail_buffer[idx + 3];

                    let pt_canvas_x = padding + pt_x * scale;
                    let pt_canvas_y = padding + pt_y * scale;
                    let tip_radius = r * scale;

                    let c_red = Color { r: 239.0/255.0, g: 68.0/255.0, b: 68.0/255.0, a: 1.0 };
                    let tip_alpha = (1.0 - pause_progress).powi(2);
                    let col = Color {
                        r: c_yellow.r + (c_red.r - c_yellow.r) * t,
                        g: c_yellow.g + (c_red.g - c_yellow.g) * t,
                        b: c_yellow.b + (c_red.b - c_yellow.b) * t,
                        a: tip_alpha,
                    };
                    append_circle_geometry(pt_canvas_x, pt_canvas_y, tip_radius, col, &mut self.vertex_buffer);
                }
            } else if let Some(point) = choreographer.get_point_at_length(strokes, choreographer.current_stroke_index, current_length) {
                let pt_canvas_x = padding + point.x * scale;
                let pt_canvas_y = padding + point.y * scale;
                let c_red = Color { r: 239.0/255.0, g: 68.0/255.0, b: 68.0/255.0, a: 1.0 };
                append_circle_geometry(pt_canvas_x, pt_canvas_y, radius, c_red, &mut self.vertex_buffer);
            }
        }
    }
}

pub fn append_circle_geometry(cx: f32, cy: f32, r: f32, color: Color, vertex_array: &mut Vec<f32>) {
    let segments = 16;
    for i in 0..segments {
        let a1 = (i as f32 / segments as f32) * std::f32::consts::PI * 2.0;
        let a2 = ((i + 1) as f32 / segments as f32) * std::f32::consts::PI * 2.0;
        
        vertex_array.push(cx);
        vertex_array.push(cy);
        vertex_array.push(color.r);
        vertex_array.push(color.g);
        vertex_array.push(color.b);
        vertex_array.push(color.a);
        
        vertex_array.push(cx + a1.cos() * r);
        vertex_array.push(cy + a1.sin() * r);
        vertex_array.push(color.r);
        vertex_array.push(color.g);
        vertex_array.push(color.b);
        vertex_array.push(color.a);
        
        vertex_array.push(cx + a2.cos() * r);
        vertex_array.push(cy + a2.sin() * r);
        vertex_array.push(color.r);
        vertex_array.push(color.g);
        vertex_array.push(color.b);
        vertex_array.push(color.a);
    }
}

pub fn append_glow_circle_geometry(cx: f32, cy: f32, r: f32, color: Color, vertex_array: &mut Vec<f32>) {
    let segments = 16;
    let r_mid = r * 0.5;
    let r_outer = r;

    let a_center = color.a;
    let a_mid = color.a * 0.25;
    let a_outer = 0.0;

    let mut mid_vertices = Vec::with_capacity(segments + 1);
    let mut outer_vertices = Vec::with_capacity(segments + 1);

    for i in 0..=segments {
        let angle = (i as f32 / segments as f32) * std::f32::consts::PI * 2.0;
        let cos_val = angle.cos();
        let sin_val = angle.sin();
        mid_vertices.push(Point {
            x: cx + cos_val * r_mid,
            y: cy + sin_val * r_mid,
            len: 0.0,
        });
        outer_vertices.push(Point {
            x: cx + cos_val * r_outer,
            y: cy + sin_val * r_outer,
            len: 0.0,
        });
    }

    for i in 0..segments {
        vertex_array.push(cx);
        vertex_array.push(cy);
        vertex_array.push(color.r);
        vertex_array.push(color.g);
        vertex_array.push(color.b);
        vertex_array.push(a_center);

        vertex_array.push(mid_vertices[i].x);
        vertex_array.push(mid_vertices[i].y);
        vertex_array.push(color.r);
        vertex_array.push(color.g);
        vertex_array.push(color.b);
        vertex_array.push(a_mid);

        vertex_array.push(mid_vertices[i+1].x);
        vertex_array.push(mid_vertices[i+1].y);
        vertex_array.push(color.r);
        vertex_array.push(color.g);
        vertex_array.push(color.b);
        vertex_array.push(a_mid);

        vertex_array.push(mid_vertices[i].x);
        vertex_array.push(mid_vertices[i].y);
        vertex_array.push(color.r);
        vertex_array.push(color.g);
        vertex_array.push(color.b);
        vertex_array.push(a_mid);

        vertex_array.push(outer_vertices[i].x);
        vertex_array.push(outer_vertices[i].y);
        vertex_array.push(color.r);
        vertex_array.push(color.g);
        vertex_array.push(color.b);
        vertex_array.push(a_outer);

        vertex_array.push(outer_vertices[i+1].x);
        vertex_array.push(outer_vertices[i+1].y);
        vertex_array.push(color.r);
        vertex_array.push(color.g);
        vertex_array.push(color.b);
        vertex_array.push(a_outer);

        vertex_array.push(mid_vertices[i].x);
        vertex_array.push(mid_vertices[i].y);
        vertex_array.push(color.r);
        vertex_array.push(color.g);
        vertex_array.push(color.b);
        vertex_array.push(a_mid);

        vertex_array.push(outer_vertices[i+1].x);
        vertex_array.push(outer_vertices[i+1].y);
        vertex_array.push(color.r);
        vertex_array.push(color.g);
        vertex_array.push(color.b);
        vertex_array.push(a_outer);

        vertex_array.push(mid_vertices[i+1].x);
        vertex_array.push(mid_vertices[i+1].y);
        vertex_array.push(color.r);
        vertex_array.push(color.g);
        vertex_array.push(color.b);
        vertex_array.push(a_mid);
    }
}

pub fn tessellate_stroke(polyline: &[Point], w: f32, color: Color, vertex_array: &mut Vec<f32>) {
    if polyline.len() < 2 { return; }
    let r = w / 2.0;
    
    struct Norm {
        nx: f32,
        ny: f32,
        ux: f32,
        uy: f32,
    }

    let mut normals = Vec::with_capacity(polyline.len() - 1);
    for i in 0..polyline.len() - 1 {
        let p1 = polyline[i];
        let p2 = polyline[i+1];
        let dx = p2.x - p1.x;
        let dy = p2.y - p1.y;
        let len = (dx * dx + dy * dy).sqrt();
        if len < 1e-6 {
            normals.push(Norm { nx: 0.0, ny: 0.0, ux: 0.0, uy: 0.0 });
        } else {
            let nx = dx / len;
            let ny = dy / len;
            normals.push(Norm { nx, ny, ux: -ny, uy: nx });
        }
    }

    let push_vertex = |x: f32, y: f32, vertex_array: &mut Vec<f32>| {
        vertex_array.push(x);
        vertex_array.push(y);
        vertex_array.push(color.r);
        vertex_array.push(color.g);
        vertex_array.push(color.b);
        vertex_array.push(color.a);
    };

    let push_triangle = |x1, y1, x2, y2, x3, y3, vertex_array: &mut Vec<f32>| {
        push_vertex(x1, y1, vertex_array);
        push_vertex(x2, y2, vertex_array);
        push_vertex(x3, y3, vertex_array);
    };

    for i in 0..polyline.len() - 1 {
        let p1 = polyline[i];
        let p2 = polyline[i+1];
        let norm = &normals[i];
        if norm.nx == 0.0 && norm.ny == 0.0 { continue; }
        
        let ox = norm.ux * r;
        let oy = norm.uy * r;
        
        let l1_x = p1.x + ox; let l1_y = p1.y + oy;
        let r1_x = p1.x - ox; let r1_y = p1.y - oy;
        let l2_x = p2.x + ox; let l2_y = p2.y + oy;
        let r2_x = p2.x - ox; let r2_y = p2.y - oy;
        
        push_triangle(l1_x, l1_y, r1_x, r1_y, l2_x, l2_y, vertex_array);
        push_triangle(r1_x, r1_y, r2_x, r2_y, l2_x, l2_y, vertex_array);
    }

    for i in 1..polyline.len() - 1 {
        let pt = polyline[i];
        append_circle_geometry(pt.x, pt.y, r, color, vertex_array);
    }

    if !normals.is_empty() {
        let first = &normals[0];
        if first.nx != 0.0 || first.ny != 0.0 {
            append_circle_geometry(polyline[0].x, polyline[0].y, r, color, vertex_array);
        }
        let last = &normals[normals.len() - 1];
        if last.nx != 0.0 || last.ny != 0.0 {
            append_circle_geometry(polyline[polyline.len() - 1].x, polyline[polyline.len() - 1].y, r, color, vertex_array);
        }
    }
}
