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

"""Encodes a WebAssembly binary into window.WASM_BYTES JavaScript."""

import base64
import sys


def main():
  if len(sys.argv) < 3:
    print('Usage: encode_wasm_bytes.py <input.wasm> <output.js>', file=sys.stderr)
    sys.exit(1)

  wasm_path = sys.argv[1]
  out_path = sys.argv[2]

  with open(wasm_path, 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('ascii')

  with open(out_path, 'w') as f:
    f.write(
        'window.WASM_BYTES = Uint8Array.from(atob("'
        + b64
        + '"), c => c.charCodeAt(0));\n'
    )


if __name__ == '__main__':
  main()
