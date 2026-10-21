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

use wasm_bindgen::prelude::*;

#[derive(Clone, Copy, Debug)]
#[wasm_bindgen]
pub struct Point {
    pub x: f32,
    pub y: f32,
    pub len: f32,
}

#[derive(Clone, Debug)]
pub struct Stroke {
    pub path_d: String,
    pub polylines: Vec<Vec<Point>>,
}

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Cmd(char),
    Num(f32),
}

fn tokenize(d: &str) -> Vec<Token> {
    let commands = ['M', 'm', 'L', 'l', 'H', 'h', 'V', 'v', 'C', 'c', 'S', 's', 'Q', 'q', 'T', 't', 'Z', 'z'];
    let mut tokens = Vec::new();
    let chars: Vec<char> = d.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if commands.contains(&c) {
            tokens.push(Token::Cmd(c));
            i += 1;
        } else if c == ',' || c == ' ' || c == '\r' || c == '\n' || c == '\t' {
            i += 1;
        } else {
            let start = i;
            if chars[i] == '-' {
                i += 1;
            }
            let mut has_dot = false;
            while i < chars.len() {
                let curr = chars[i];
                if curr.is_ascii_digit() {
                    i += 1;
                } else if curr == '.' && !has_dot {
                    has_dot = true;
                    i += 1;
                } else {
                    break;
                }
            }
            let num_str: String = chars[start..i].iter().collect();
            if !num_str.is_empty() {
                if let Ok(val) = num_str.parse::<f32>() {
                    tokens.push(Token::Num(val));
                } else {
                    i += 1;
                }
            } else {
                i += 1;
            }
        }
    }
    tokens
}

fn get_steps(x1: f32, y1: f32, x2: f32, y2: f32) -> usize {
    let dx = x2 - x1;
    let dy = y2 - y1;
    let dist = (dx * dx + dy * dy).sqrt();
    ((dist / 1.5).round() as usize).max(3).min(24)
}

pub fn parse_to_polylines(d: &str) -> Vec<Vec<Point>> {
    let tokens = tokenize(d);
    let mut polylines = Vec::new();
    let mut current_polyline = Vec::new();
    
    let mut cx = 0.0;
    let mut cy = 0.0;
    let mut sx = 0.0;
    let mut sy = 0.0;
    let mut cpx = 0.0;
    let mut cpy = 0.0;
    let mut qpx = 0.0;
    let mut qpy = 0.0;
    
    let mut t_idx = 0;
    let mut last_cmd = ' ';

    while t_idx < tokens.len() {
        let mut cmd = ' ';
        if let Token::Cmd(c) = tokens[t_idx] {
            cmd = c;
            t_idx += 1;
        } else if last_cmd != ' ' {
            cmd = last_cmd;
        }
        
        if cmd == ' ' {
            break;
        }
        
        match cmd {
            'M' | 'm' => {
                let px = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let py = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let target_x = if cmd == 'M' { px } else { cx + px };
                let target_y = if cmd == 'M' { py } else { cy + py };
                
                if !current_polyline.is_empty() {
                    polylines.push(current_polyline);
                }
                current_polyline = Vec::new();
                sx = target_x;
                sy = target_y;
                current_polyline.push(Point { x: target_x, y: target_y, len: 0.0 });
                cx = target_x;
                cy = target_y;
                cpx = target_x; cpy = target_y;
                qpx = target_x; qpy = target_y;
                last_cmd = if cmd == 'M' { 'L' } else { 'l' };
            }
            'L' | 'l' => {
                let px = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let py = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let target_x = if cmd == 'L' { px } else { cx + px };
                let target_y = if cmd == 'L' { py } else { cy + py };
                current_polyline.push(Point { x: target_x, y: target_y, len: 0.0 });
                cx = target_x;
                cy = target_y;
                cpx = target_x; cpy = target_y;
                qpx = target_x; qpy = target_y;
                last_cmd = cmd;
            }
            'H' | 'h' => {
                let px = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let target_x = if cmd == 'H' { px } else { cx + px };
                current_polyline.push(Point { x: target_x, y: cy, len: 0.0 });
                cx = target_x;
                cpx = target_x; cpy = cy;
                qpx = target_x; qpy = cy;
                last_cmd = cmd;
            }
            'V' | 'v' => {
                let py = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let target_y = if cmd == 'V' { py } else { cy + py };
                current_polyline.push(Point { x: cx, y: target_y, len: 0.0 });
                cy = target_y;
                cpx = cx; cpy = target_y;
                qpx = cx; qpy = target_y;
                last_cmd = cmd;
            }
            'C' | 'c' => {
                let x1 = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let y1 = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let x2 = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let y2 = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let x = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let y = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                
                let ctrl1_x = if cmd == 'C' { x1 } else { cx + x1 };
                let ctrl1_y = if cmd == 'C' { y1 } else { cy + y1 };
                let ctrl2_x = if cmd == 'C' { x2 } else { cx + x2 };
                let ctrl2_y = if cmd == 'C' { y2 } else { cy + y2 };
                let target_x = if cmd == 'C' { x } else { cx + x };
                let target_y = if cmd == 'C' { y } else { cy + y };
                
                let steps = get_steps(cx, cy, target_x, target_y);
                subdivide_cubic(cx, cy, ctrl1_x, ctrl1_y, ctrl2_x, ctrl2_y, target_x, target_y, &mut current_polyline, steps);
                cx = target_x;
                cy = target_y;
                cpx = ctrl2_x;
                cpy = ctrl2_y;
                qpx = target_x;
                qpy = target_y;
                last_cmd = cmd;
            }
            'S' | 's' => {
                let x2 = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let y2 = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let x = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let y = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                
                let mut ctrl1_x = cx;
                let mut ctrl1_y = cy;
                if last_cmd == 'C' || last_cmd == 'c' || last_cmd == 'S' || last_cmd == 's' {
                    ctrl1_x = 2.0 * cx - cpx;
                    ctrl1_y = 2.0 * cy - cpy;
                }
                
                let ctrl2_x = if cmd == 'S' { x2 } else { cx + x2 };
                let ctrl2_y = if cmd == 'S' { y2 } else { cy + y2 };
                let target_x = if cmd == 'S' { x } else { cx + x };
                let target_y = if cmd == 'S' { y } else { cy + y };
                
                let steps = get_steps(cx, cy, target_x, target_y);
                subdivide_cubic(cx, cy, ctrl1_x, ctrl1_y, ctrl2_x, ctrl2_y, target_x, target_y, &mut current_polyline, steps);
                cx = target_x;
                cy = target_y;
                cpx = ctrl2_x;
                cpy = ctrl2_y;
                qpx = target_x;
                qpy = target_y;
                last_cmd = cmd;
            }
            'Q' | 'q' => {
                let x1 = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let y1 = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let x = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let y = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                
                let ctrl_x = if cmd == 'Q' { x1 } else { cx + x1 };
                let ctrl_y = if cmd == 'Q' { y1 } else { cy + y1 };
                let target_x = if cmd == 'Q' { x } else { cx + x };
                let target_y = if cmd == 'Q' { y } else { cy + y };
                
                let steps = get_steps(cx, cy, target_x, target_y);
                subdivide_quadratic(cx, cy, ctrl_x, ctrl_y, target_x, target_y, &mut current_polyline, steps);
                cx = target_x;
                cy = target_y;
                qpx = ctrl_x;
                qpy = ctrl_y;
                cpx = target_x;
                cpy = target_y;
                last_cmd = cmd;
            }
            'T' | 't' => {
                let x = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                let y = if let Token::Num(val) = tokens[t_idx] { t_idx += 1; val } else { 0.0 };
                
                let mut ctrl_x = cx;
                let mut ctrl_y = cy;
                if last_cmd == 'Q' || last_cmd == 'q' || last_cmd == 'T' || last_cmd == 't' {
                    ctrl_x = 2.0 * cx - qpx;
                    ctrl_y = 2.0 * cy - qpy;
                }
                
                let target_x = if cmd == 'T' { x } else { cx + x };
                let target_y = if cmd == 'T' { y } else { cy + y };
                
                let steps = get_steps(cx, cy, target_x, target_y);
                subdivide_quadratic(cx, cy, ctrl_x, ctrl_y, target_x, target_y, &mut current_polyline, steps);
                cx = target_x;
                cy = target_y;
                qpx = ctrl_x;
                qpy = ctrl_y;
                cpx = target_x;
                cpy = target_y;
                last_cmd = cmd;
            }
            'Z' | 'z' => {
                if (cx - sx).abs() > 1e-5 || (cy - sy).abs() > 1e-5 {
                    current_polyline.push(Point { x: sx, y: sy, len: 0.0 });
                    cx = sx;
                    cy = sy;
                }
                cpx = sx; cpy = sy;
                qpx = sx; qpy = sy;
                last_cmd = cmd;
            }
            _ => {
                t_idx += 1;
            }
        }
    }
    
    if !current_polyline.is_empty() {
        polylines.push(current_polyline);
    }
    polylines
}

fn subdivide_cubic(x0: f32, y0: f32, x1: f32, y1: f32, x2: f32, y2: f32, x3: f32, y3: f32, points: &mut Vec<Point>, steps: usize) {
    for step in 1..=steps {
        let t = step as f32 / steps as f32;
        let mt = 1.0 - t;
        let w0 = mt * mt * mt;
        let w1 = 3.0 * mt * mt * t;
        let w2 = 3.0 * mt * t * t;
        let w3 = t * t * t;
        points.push(Point {
            x: w0 * x0 + w1 * x1 + w2 * x2 + w3 * x3,
            y: w0 * y0 + w1 * y1 + w2 * y2 + w3 * y3,
            len: 0.0,
        });
    }
}

fn subdivide_quadratic(x0: f32, y0: f32, x1: f32, y1: f32, x2: f32, y2: f32, points: &mut Vec<Point>, steps: usize) {
    for step in 1..=steps {
        let t = step as f32 / steps as f32;
        let mt = 1.0 - t;
        let w0 = mt * mt;
        let w1 = 2.0 * mt * t;
        let w2 = t * t;
        points.push(Point {
            x: w0 * x0 + w1 * x1 + w2 * x2,
            y: w0 * y0 + w1 * y1 + w2 * y2,
            len: 0.0,
        });
    }
}

pub fn compute_polyline_lengths(polyline: &mut [Point]) -> f32 {
    if polyline.is_empty() { return 0.0; }
    let mut len = 0.0;
    polyline[0].len = 0.0;
    for i in 1..polyline.len() {
        let dx = polyline[i].x - polyline[i-1].x;
        let dy = polyline[i].y - polyline[i-1].y;
        len += (dx * dx + dy * dy).sqrt();
        polyline[i].len = len;
    }
    len
}

pub fn clean_polyline(polyline: &[Point]) -> Vec<Point> {
    if polyline.len() < 2 { return polyline.to_vec(); }
    let mut result = vec![polyline[0]];
    for i in 1..polyline.len() {
        let prev = result[result.len() - 1];
        let curr = polyline[i];
        let dx = curr.x - prev.x;
        let dy = curr.y - prev.y;
        let len = (dx * dx + dy * dy).sqrt();
        if len >= 1e-4 {
            result.push(curr);
        }
    }
    if result.len() < 2 && polyline.len() >= 2 {
        result.push(polyline[polyline.len() - 1]);
    }
    result
}

pub fn truncate_polyline(polyline: &[Point], target_len: f32) -> Vec<Point> {
    if target_len <= 0.0 || polyline.is_empty() { return Vec::new(); }
    let total = polyline[polyline.len() - 1].len;
    if target_len >= total { return polyline.to_vec(); }
    
    let mut result = Vec::new();
    for i in 0..polyline.len() {
        if polyline[i].len <= target_len {
            result.push(polyline[i]);
        } else {
            if i > 0 {
                let prev = polyline[i-1];
                let next = polyline[i];
                let ratio = (target_len - prev.len) / (next.len - prev.len);
                result.push(Point {
                    x: prev.x + ratio * (next.x - prev.x),
                    y: prev.y + ratio * (next.y - prev.y),
                    len: target_len,
                });
            }
            break;
        }
    }
    result
}
