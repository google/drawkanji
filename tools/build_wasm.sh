#!/bin/bash
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
#
# Compiles DrawKanji's Rust library (src/lib.rs) into a wasm32-unknown-unknown
# cdylib WebAssembly module using rustc and pinned GitHub source archives for
# wasm-bindgen 0.2.108.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_WASM="${1:-${PROJECT_DIR}/build/drawkanji_rs.wasm}"
WASM_DEPS_DIR="${WASM_DEPS_DIR:-${PROJECT_DIR}/build/wasm_deps}"

export PATH="/usr/local/bin:/home/builder/.local/bin:${HOME:-/root}/.local/bin:${HOME:-/root}/.cargo/bin:/usr/bin:/bin:${PATH:-}"
for llvm_dir in /usr/local/lib/llvm-21/bin /home/builder/.local/lib/llvm-21/bin "${HOME:-/root}/.local/lib/llvm-21/bin" /usr/lib/llvm-21/bin; do
  if [ -d "$llvm_dir" ]; then
    export PATH="$llvm_dir:$PATH"
    break
  fi
done

for lib_dir in /usr/local/lib/x86_64-linux-gnu /home/builder/.local/lib/x86_64-linux-gnu "${HOME:-/root}/.local/lib/x86_64-linux-gnu"; do
  if [ -d "$lib_dir" ]; then
    export LD_LIBRARY_PATH="$lib_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  fi
done

SYSROOT_ARGS=()
for sr in "${RUST_SYSROOT:-}" /usr/local /home/builder/.local "${HOME:-/root}/.local"; do
  if [ -n "$sr" ] && [ -d "$sr/lib/rustlib/wasm32-unknown-unknown" ]; then
    SYSROOT_ARGS=("--sysroot" "$sr")
    break
  fi
done

mkdir -p "${WASM_DEPS_DIR}/src" "${WASM_DEPS_DIR}/host" "${WASM_DEPS_DIR}/wasm32" "${WASM_DEPS_DIR}/bin" "$(dirname "${OUT_WASM}")"

if ! command -v rust-lld >/dev/null 2>&1; then
  for candidate in \
      "${RUST_SYSROOT:-}"/lib/rustlib/*/bin/rust-lld \
      "${RUST_SYSROOT:-}"/lib/rustlib/*/bin/gcc-ld/ld.lld \
      /home/builder/.rustup/toolchains/*/lib/rustlib/*/bin/rust-lld \
      "${HOME:-/root}"/.rustup/toolchains/*/lib/rustlib/*/bin/rust-lld \
      /usr/local/lib/llvm-*/bin/lld \
      /home/builder/.local/lib/llvm-*/bin/lld \
      "${HOME:-/root}"/.local/lib/llvm-*/bin/lld \
      /usr/lib/llvm-*/bin/lld \
      "$(command -v lld 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      ln -sf "$candidate" "${WASM_DEPS_DIR}/bin/rust-lld"
      break
    fi
  done
fi
export PATH="${WASM_DEPS_DIR}/bin:$PATH"

PROC_MACRO_EXT="so"
if [ "$(uname -s)" = "Darwin" ]; then
  PROC_MACRO_EXT="dylib"
fi

run_rustc() {
  rustc "${SYSROOT_ARGS[@]}" "$@"
}

# Pass --cap-lints allow when compiling third-party dependency crates (matching
# Cargo's behavior for external dependencies so removed/renamed lints such as
# `repr_transparent_external_private_fields` in syn do not emit warnings on
# newer rustc versions).
run_rustc_dep() {
  rustc "${SYSROOT_ARGS[@]}" --cap-lints allow "$@"
}

verify_sha256() {
  local file="$1"
  local expected="$2"
  echo "${expected}  ${file}" | (sha256sum -c - >/dev/null 2>&1 || shasum -a 256 -c - >/dev/null 2>&1)
}

fetch_crate() {
  local name="$1"
  local url="$2"
  local sha256="$3"
  local dest="${WASM_DEPS_DIR}/src/${name}"
  if [ ! -f "${dest}/.ready" ]; then
    local archive="${WASM_DEPS_DIR}/src/${name}.tar.gz"
    rm -rf "${dest}"
    mkdir -p "${dest}"
    curl -fsSL "${url}" -o "${archive}"
    verify_sha256 "${archive}" "${sha256}"
    tar -xzf "${archive}" -C "${dest}" --strip-components=1
    rm -f "${archive}"
    touch "${dest}/.ready"
  fi
}

if [ ! -f "${WASM_DEPS_DIR}/wasm32/libwasm_bindgen.rlib" ] || \
   [ ! -f "${WASM_DEPS_DIR}/host/libwasm_bindgen_macro.${PROC_MACRO_EXT}" ]; then
  echo "=== Fetching & compiling wasm-bindgen 0.2.108 crates ==="
  fetch_crate "unicode_ident" \
    "https://github.com/dtolnay/unicode-ident/archive/refs/tags/1.0.13.tar.gz" \
    "e60b592db1ef630d98b73b45630f40ca94c67f0f157d409c04badd2a8763bf92"
  fetch_crate "proc_macro2" \
    "https://github.com/dtolnay/proc-macro2/archive/refs/tags/1.0.101.tar.gz" \
    "175f5f476a3744e2c477e1535ecd65c115fec04fde2672fcba2d88d196a95f80"
  fetch_crate "quote" \
    "https://github.com/dtolnay/quote/archive/refs/tags/1.0.40.tar.gz" \
    "14b645bd367881c587936eaca1df9b42ecd4bfd1d8f5b88f4497fce695c9c559"
  fetch_crate "syn" \
    "https://github.com/dtolnay/syn/archive/refs/tags/2.0.105.tar.gz" \
    "887b2a55d42ec456bb78537becbb3cf94f046957f935dc44d8305553af1804ba"
  fetch_crate "bumpalo" \
    "https://github.com/fitzgen/bumpalo/archive/refs/tags/3.16.0.tar.gz" \
    "1fc930e2d5fad200810fd06083d63912193171403148fbb2bf39d30f9a8ba397"
  fetch_crate "cfg_if" \
    "https://github.com/rust-lang/cfg-if/archive/refs/tags/1.0.0.tar.gz" \
    "d40577ae0766585cef4473efbcb3bd9394ea883347a4caf76804edbb2ac338a3"
  fetch_crate "once_cell" \
    "https://github.com/matklad/once_cell/archive/refs/tags/v1.21.3.tar.gz" \
    "5c7df12a42658637d0eab9cf16f315975cfdd1abc4d14524058ea5f280c27a42"
  fetch_crate "wasm_bindgen_src" \
    "https://github.com/wasm-bindgen/wasm-bindgen/archive/refs/tags/0.2.108.tar.gz" \
    "9a4d3f69b555e5e8a588b3b571fb285b9bfdc3a893661352ceff6ab8c80eef47"

  SRC_ROOT="${WASM_DEPS_DIR}/src"
  HOST_OUT="${WASM_DEPS_DIR}/host"
  WASM_OUT="${WASM_DEPS_DIR}/wasm32"
  WBG_ROOT="${SRC_ROOT}/wasm_bindgen_src"

  # 1. Host proc-macro dependency graph
  run_rustc_dep --crate-name unicode_ident --edition=2018 --crate-type lib \
    "${SRC_ROOT}/unicode_ident/src/lib.rs" --out-dir "${HOST_OUT}"

  run_rustc_dep --crate-name proc_macro2 --edition=2021 --crate-type lib \
    --cfg 'feature="proc-macro"' --cfg wrap_proc_macro \
    "${SRC_ROOT}/proc_macro2/src/lib.rs" \
    --extern "unicode_ident=${HOST_OUT}/libunicode_ident.rlib" \
    -L "dependency=${HOST_OUT}" --out-dir "${HOST_OUT}"

  run_rustc_dep --crate-name quote --edition=2018 --crate-type lib \
    --cfg 'feature="proc-macro"' \
    "${SRC_ROOT}/quote/src/lib.rs" \
    --extern "proc_macro2=${HOST_OUT}/libproc_macro2.rlib" \
    -L "dependency=${HOST_OUT}" --out-dir "${HOST_OUT}"

  run_rustc_dep --crate-name syn --edition=2021 --crate-type lib \
    --cfg 'feature="full"' --cfg 'feature="visit"' --cfg 'feature="visit-mut"' \
    --cfg 'feature="parsing"' --cfg 'feature="printing"' \
    --cfg 'feature="clone-impls"' --cfg 'feature="derive"' --cfg 'feature="proc-macro"' \
    "${SRC_ROOT}/syn/src/lib.rs" \
    --extern "proc_macro2=${HOST_OUT}/libproc_macro2.rlib" \
    --extern "quote=${HOST_OUT}/libquote.rlib" \
    --extern "unicode_ident=${HOST_OUT}/libunicode_ident.rlib" \
    -L "dependency=${HOST_OUT}" --out-dir "${HOST_OUT}"

  run_rustc_dep --crate-name bumpalo --edition=2021 --crate-type lib \
    --cfg 'feature="default"' \
    "${SRC_ROOT}/bumpalo/src/lib.rs" \
    -L "dependency=${HOST_OUT}" --out-dir "${HOST_OUT}"

  CARGO_PKG_VERSION=0.2.108 CARGO_PKG_NAME=wasm-bindgen-shared \
    run_rustc_dep --crate-name wasm_bindgen_shared --edition=2021 --crate-type lib \
    "${WBG_ROOT}/crates/shared/src/lib.rs" \
    --extern "unicode_ident=${HOST_OUT}/libunicode_ident.rlib" \
    -L "dependency=${HOST_OUT}" --out-dir "${HOST_OUT}"

  CARGO_PKG_VERSION=0.2.108 CARGO_PKG_NAME=wasm-bindgen-macro-support \
    run_rustc_dep --crate-name wasm_bindgen_macro_support --edition=2021 --crate-type lib \
    "${WBG_ROOT}/crates/macro-support/src/lib.rs" \
    --extern "bumpalo=${HOST_OUT}/libbumpalo.rlib" \
    --extern "proc_macro2=${HOST_OUT}/libproc_macro2.rlib" \
    --extern "quote=${HOST_OUT}/libquote.rlib" \
    --extern "syn=${HOST_OUT}/libsyn.rlib" \
    --extern "wasm_bindgen_shared=${HOST_OUT}/libwasm_bindgen_shared.rlib" \
    -L "dependency=${HOST_OUT}" --out-dir "${HOST_OUT}"

  CARGO_PKG_VERSION=0.2.108 CARGO_PKG_NAME=wasm-bindgen-macro \
    run_rustc_dep --crate-name wasm_bindgen_macro --edition=2021 --crate-type proc-macro \
    "${WBG_ROOT}/crates/macro/src/lib.rs" \
    --extern "quote=${HOST_OUT}/libquote.rlib" \
    --extern "wasm_bindgen_macro_support=${HOST_OUT}/libwasm_bindgen_macro_support.rlib" \
    -L "dependency=${HOST_OUT}" --out-dir "${HOST_OUT}"

  # 2. wasm32-unknown-unknown dependency graph
  run_rustc_dep --target wasm32-unknown-unknown --crate-name unicode_ident --edition=2018 --crate-type lib \
    "${SRC_ROOT}/unicode_ident/src/lib.rs" --out-dir "${WASM_OUT}"

  run_rustc_dep --target wasm32-unknown-unknown --crate-name cfg_if --edition=2018 --crate-type lib \
    "${SRC_ROOT}/cfg_if/src/lib.rs" --out-dir "${WASM_OUT}"

  run_rustc_dep --target wasm32-unknown-unknown --crate-name once_cell --edition=2021 --crate-type lib \
    --cfg 'feature="race"' --cfg 'feature="alloc"' \
    "${SRC_ROOT}/once_cell/src/lib.rs" --out-dir "${WASM_OUT}"

  CARGO_PKG_VERSION=0.2.108 CARGO_PKG_NAME=wasm-bindgen-shared \
    run_rustc_dep --target wasm32-unknown-unknown --crate-name wasm_bindgen_shared --edition=2021 --crate-type lib \
    "${WBG_ROOT}/crates/shared/src/lib.rs" \
    --extern "unicode_ident=${WASM_OUT}/libunicode_ident.rlib" \
    -L "dependency=${WASM_OUT}" --out-dir "${WASM_OUT}"

  CARGO_MANIFEST_DIR="${WBG_ROOT}" CARGO_PKG_VERSION=0.2.108 CARGO_PKG_NAME=wasm-bindgen \
    run_rustc_dep --target wasm32-unknown-unknown --crate-name wasm_bindgen --edition=2021 --crate-type lib \
    --cfg wbg_reference_types --cfg wbg_diagnostic --cfg 'feature="default"' --cfg 'feature="std"' \
    "${WBG_ROOT}/src/lib.rs" \
    --extern "cfg_if=${WASM_OUT}/libcfg_if.rlib" \
    --extern "once_cell=${WASM_OUT}/libonce_cell.rlib" \
    --extern "wasm_bindgen_macro=${HOST_OUT}/libwasm_bindgen_macro.${PROC_MACRO_EXT}" \
    --extern "wasm_bindgen_shared=${WASM_OUT}/libwasm_bindgen_shared.rlib" \
    -L "dependency=${WASM_OUT}" -L "dependency=${HOST_OUT}" \
    --out-dir "${WASM_OUT}"
fi

echo "=== Compiling DrawKanji Rust library (src/lib.rs -> ${OUT_WASM}) ==="
CARGO_MANIFEST_DIR="${PROJECT_DIR}" CARGO_PKG_NAME="drawkanji_rs" CARGO_PKG_VERSION="0.1.0" \
  run_rustc --target wasm32-unknown-unknown --crate-name "drawkanji_rs" --edition="2021" \
  --crate-type cdylib -C opt-level=3 \
  "${PROJECT_DIR}/src/lib.rs" \
  --extern "wasm_bindgen=${WASM_DEPS_DIR}/wasm32/libwasm_bindgen.rlib" \
  -L "dependency=${WASM_DEPS_DIR}/wasm32" -L "dependency=${WASM_DEPS_DIR}/host" \
  -o "${OUT_WASM}"
