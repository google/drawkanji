# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import collections
import os
import struct
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1 and sys.argv[1]:
    _input = os.path.abspath(sys.argv[1])
    KANJI_DIR = os.path.dirname(_input) if os.path.isfile(_input) else _input
else:
    KANJI_DIR = os.path.join(SCRIPT_DIR, '..', 'kanjivg', 'kanji')

if len(sys.argv) > 2 and sys.argv[2]:
    OUTPUT_FILE = os.path.abspath(sys.argv[2])
else:
    OUTPUT_FILE = os.path.join(SCRIPT_DIR, '..', 'kanjivg', 'kanjivg.bin')

class TrieNode:
    def __init__(self):
        self.is_terminal = False
        self.content_offset = 0
        self.content_length = 0
        self.children = {}  # int (0..15) -> TrieNode

def get_node_byte_size(node):
    return 1 + 2 + (8 if node.is_terminal else 0) + 4 * len(node.children)

def build_archive():
    print("=== Building KanjiVG Binary Trie Archive ===")
    print(f"Source directory: {KANJI_DIR}")

    if not os.path.exists(KANJI_DIR):
        print(f"Error: Kanji directory not found at {KANJI_DIR}")
        return

    svg_files = [f for f in os.listdir(KANJI_DIR) if f.endswith('.svg')]
    print(f"Found {len(svg_files)} SVG files to archive.")

    root = TrieNode()
    content_chunks = []
    current_content_offset = 0

    for filename in sorted(svg_files):
        hex_key = filename[:-4].lower()
        file_path = os.path.join(KANJI_DIR, filename)

        with open(file_path, 'rb') as f:
            content = f.read()

        content_len = len(content)
        content_chunks.append(content)

        curr = root
        for char in hex_key:
            try:
                hex_val = int(char, 16)
            except ValueError:
                print(f"FATAL BUILD ERROR: Filename '{filename}' contains non-hexadecimal character '{char}'!")
                sys.exit(1)

            if hex_val not in curr.children:
                curr.children[hex_val] = TrieNode()
            curr = curr.children[hex_val]

        curr.is_terminal = True
        curr.content_offset = current_content_offset
        curr.content_length = content_len
        current_content_offset += content_len

    full_content_data = b''.join(content_chunks)
    print(f"Content Data Total Size: {len(full_content_data) / (1024 * 1024):.2f} MB")

    # Breadth-first layout assignment for Index Data
    node_offset_map = {}
    queue = collections.deque([root])
    node_offset_map[root] = 0

    next_free_offset = get_node_byte_size(root)

    while queue:
        node = queue.popleft()
        sorted_hex_vals = sorted(node.children.keys())
        for hex_val in sorted_hex_vals:
            child = node.children[hex_val]
            if child not in node_offset_map:
                node_offset_map[child] = next_free_offset
                queue.append(child)
                next_free_offset += get_node_byte_size(child)

    index_data_size = next_free_offset
    print(f"Index Data Total Size: {index_data_size / 1024:.2f} KB ({len(node_offset_map)} Trie nodes)")

    # Serialize Index Data Buffer
    index_buffer = bytearray(index_data_size)

    all_nodes = list(node_offset_map.keys())
    for node in all_nodes:
        offset = node_offset_map[node]
        meta = 0x80 if node.is_terminal else 0x00
        index_buffer[offset] = meta

        child_bitmask = 0
        sorted_hex_vals = sorted(node.children.keys())
        for hex_val in sorted_hex_vals:
            child_bitmask |= (1 << hex_val)

        struct.pack_into('<H', index_buffer, offset + 1, child_bitmask)

        child_ptr_start = offset + 3
        if node.is_terminal:
            struct.pack_into('<I', index_buffer, offset + 3, node.content_offset)
            struct.pack_into('<I', index_buffer, offset + 7, node.content_length)
            child_ptr_start = offset + 11

        for c_idx, child_val in enumerate(sorted_hex_vals):
            child_node = node.children[child_val]
            child_offset = node_offset_map[child_node]
            struct.pack_into('<I', index_buffer, child_ptr_start + c_idx * 4, child_offset)

    # Header: Magic ('AE3A') + Index Length (u32 LE)
    header = b'AE3A' + struct.pack('<I', index_data_size)

    final_archive = header + bytes(index_buffer) + full_content_data

    if os.path.dirname(OUTPUT_FILE):
        os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, 'wb') as f:
        f.write(final_archive)

    print(f"Successfully generated archive: {OUTPUT_FILE}")
    print(f"Total Archive File Size: {len(final_archive) / (1024 * 1024):.2f} MB")

if __name__ == '__main__':
    build_archive()
