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
# Installs Make, Rust (with wasm32-unknown-unknown target), and wasm-bindgen
# for building DrawKanji on Linux (root or rootless container) and macOS.
set -euo pipefail

echo "=== Setting up Make & WebAssembly Rust Toolchain for DrawKanji ==="

INSTALL_PREFIX="${INSTALL_PREFIX:-/usr/local}"
if [ ! -w "$INSTALL_PREFIX" ] || ! mkdir -p "$INSTALL_PREFIX/bin" "$INSTALL_PREFIX/lib" "$INSTALL_PREFIX/share" 2>/dev/null; then
  INSTALL_PREFIX="$HOME/.local"
  mkdir -p "$INSTALL_PREFIX/bin" "$INSTALL_PREFIX/lib" "$INSTALL_PREFIX/share"
fi
export PATH="$INSTALL_PREFIX/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

OS_NAME="$(uname -s)"

if [ "${FORCE_UPSTREAM_TOOLCHAIN:-0}" != "1" ] && [ "$OS_NAME" = "Linux" ] && command -v apt-get >/dev/null 2>&1 && { [ -e /usr/lib/apt/methods/uplib+https ] || [ -e /usr/lib/apt/methods/uplib ]; }; then
  PKGS=(
    make
    rustc
    libstd-rust-1.92
    libstd-rust-dev
    libstd-rust-dev-wasm32
    lld-21
    llvm-21-linker-tools
    wasm-bindgen
  )

  UID_MAP_SIZE="$(awk 'NR==1 {print $3}' /proc/self/uid_map 2>/dev/null || echo 65536)"

  if [ "$(id -u)" -eq 0 ] && [ -w /usr/bin ] && [ "${UID_MAP_SIZE}" -gt 1 ]; then
    echo "Installing Make, Rust (wasm32), and wasm-bindgen via apt-get..."
    apt-get update -y
    apt-get install -y "${PKGS[@]}"
  elif [ "${UID_MAP_SIZE}" -gt 1 ] && sudo -n true 2>/dev/null; then
    echo "Installing Make, Rust (wasm32), and wasm-bindgen via sudo apt-get..."
    sudo apt-get update -y
    sudo apt-get install -y "${PKGS[@]}"
  elif command -v make >/dev/null 2>&1 && [ -x "$INSTALL_PREFIX/bin/rustc" ] && [ -x "$INSTALL_PREFIX/bin/wasm-bindgen" ] && [ -d "$INSTALL_PREFIX/lib/rustlib/wasm32-unknown-unknown" ]; then
    echo "Make, Rust (wasm32), and wasm-bindgen already installed in $INSTALL_PREFIX."
  else
    echo "Unprivileged container detected; extracting apt packages into $INSTALL_PREFIX..."
    TMP_APT="$(mktemp -d)"
    (
      cd "$TMP_APT"
      apt-get -o APT::Sandbox::User=root download "${PKGS[@]}"
      for deb in *.deb; do
        dpkg-deb -x "$deb" "$TMP_APT/root"
      done
      cp -a "$TMP_APT/root/usr/bin/"* "$INSTALL_PREFIX/bin/" 2>/dev/null || true
      cp -a "$TMP_APT/root/usr/lib/"* "$INSTALL_PREFIX/lib/" 2>/dev/null || true
      cp -a "$TMP_APT/root/usr/share/"* "$INSTALL_PREFIX/share/" 2>/dev/null || true
      if [ -x "$INSTALL_PREFIX/lib/llvm-21/bin/lld" ]; then
        ln -sf "$INSTALL_PREFIX/lib/llvm-21/bin/lld" "$INSTALL_PREFIX/bin/rust-lld"
        ln -sf "$INSTALL_PREFIX/lib/llvm-21/bin/lld" "$INSTALL_PREFIX/bin/wasm-ld"
      fi
    )
    rm -rf "$TMP_APT"
  fi
else
  # Vanilla Ubuntu/Debian, other Linux distros, or macOS:
  if [ "$(id -u)" -eq 0 ]; then
    chmod a+rwxt /tmp 2>/dev/null || true
  fi

  # 1. Ensure base OS tools (make, curl, ca-certificates, python3, unzip, C linker) exist on apt-based Linux
  if [ "$OS_NAME" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
    if ! command -v make >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1 || ! command -v unzip >/dev/null 2>&1 || ! command -v cc >/dev/null 2>&1 || [ ! -f /etc/ssl/certs/ca-certificates.crt ]; then
      echo "Installing base system dependencies (ca-certificates, curl, python3, make, build-essential, unzip)..."
      if [ "$(id -u)" -eq 0 ]; then
        chmod a+rwxt /tmp 2>/dev/null || true
        DEBIAN_FRONTEND=noninteractive apt-get update -y
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
          ca-certificates curl python3 make build-essential unzip
      elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        sudo chmod a+rwxt /tmp 2>/dev/null || true
        sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
          ca-certificates curl python3 make build-essential unzip
      fi
    fi
  fi

  # 2. Install Rust & wasm32-unknown-unknown target via rustup (with apt-get fallback if sh.rustup.rs is blocked)
  export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
  export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
  export PATH="$CARGO_HOME/bin:$PATH"

  if ! command -v rustc >/dev/null 2>&1; then
    echo "Installing Rust (stable + wasm32-unknown-unknown) via rustup..."
    if curl --connect-timeout 10 --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh 2>/dev/null; then
      sh /tmp/rustup-init.sh -y --default-toolchain stable --profile minimal --target wasm32-unknown-unknown
      rm -f /tmp/rustup-init.sh
      # shellcheck disable=SC1091
      [ -f "$CARGO_HOME/env" ] && source "$CARGO_HOME/env"
    elif [ "$OS_NAME" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
      echo "sh.rustup.rs unreachable; falling back to apt packages for rustc (wasm32-unknown-unknown) + lld..."
      UID_MAP_SIZE="$(awk 'NR==1 {print $3}' /proc/self/uid_map 2>/dev/null || echo 65536)"
      if [ "$(id -u)" -eq 0 ] && [ -w /usr/bin ] && [ "${UID_MAP_SIZE}" -gt 1 ]; then
        DEBIAN_FRONTEND=noninteractive apt-get update -y
        DEBIAN_FRONTEND=noninteractive apt-get install -y rustc libstd-rust-dev libstd-rust-dev-wasm32 lld
      elif [ "${UID_MAP_SIZE}" -gt 1 ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y rustc libstd-rust-dev libstd-rust-dev-wasm32 lld
      else
        TMP_APT="$(mktemp -d)"
        (
          cd "$TMP_APT"
          apt-get -o APT::Sandbox::User=root download rustc libstd-rust-1.92 libstd-rust-dev libstd-rust-dev-wasm32 lld-21 llvm-21-linker-tools
          for deb in *.deb; do
            dpkg-deb -x "$deb" "$TMP_APT/root"
          done
          cp -a "$TMP_APT/root/usr/bin/"* "$INSTALL_PREFIX/bin/" 2>/dev/null || true
          cp -a "$TMP_APT/root/usr/lib/"* "$INSTALL_PREFIX/lib/" 2>/dev/null || true
          cp -a "$TMP_APT/root/usr/share/"* "$INSTALL_PREFIX/share/" 2>/dev/null || true
          if [ -x "$INSTALL_PREFIX/lib/llvm-21/bin/lld" ]; then
            ln -sf "$INSTALL_PREFIX/lib/llvm-21/bin/lld" "$INSTALL_PREFIX/bin/rust-lld"
            ln -sf "$INSTALL_PREFIX/lib/llvm-21/bin/lld" "$INSTALL_PREFIX/bin/wasm-ld"
          fi
        )
        rm -rf "$TMP_APT"
      fi
    else
      echo "Error: Could not reach https://sh.rustup.rs to install Rust." >&2
      exit 1
    fi
  elif command -v rustup >/dev/null 2>&1; then
    echo "Adding wasm32-unknown-unknown target..."
    rustup target add wasm32-unknown-unknown
  fi

  # 3. Install wasm-bindgen CLI (0.2.108) from GitHub Releases (with apt-get fallback if blocked)
  if ! command -v wasm-bindgen >/dev/null 2>&1; then
    echo "Installing wasm-bindgen CLI (0.2.108) from GitHub Releases..."
    ARCH="$(uname -m)"
    case "$OS_NAME-$ARCH" in
      Darwin-arm64) WBG_TAR="wasm-bindgen-0.2.108-aarch64-apple-darwin.tar.gz" ;;
      Darwin-x86_64) WBG_TAR="wasm-bindgen-0.2.108-x86_64-apple-darwin.tar.gz" ;;
      Linux-aarch64) WBG_TAR="wasm-bindgen-0.2.108-aarch64-unknown-linux-gnu.tar.gz" ;;
      *) WBG_TAR="wasm-bindgen-0.2.108-x86_64-unknown-linux-musl.tar.gz" ;;
    esac
    TMP_WBG="$(mktemp -d)"
    if curl --connect-timeout 10 -fsSL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.108/${WBG_TAR}" \
         | tar -xz -C "$TMP_WBG" --strip-components=1 2>/dev/null && \
       [ -f "$TMP_WBG/wasm-bindgen" ]; then
      mv "$TMP_WBG/wasm-bindgen" "$INSTALL_PREFIX/bin/wasm-bindgen"
      chmod +x "$INSTALL_PREFIX/bin/wasm-bindgen"
    elif [ "$OS_NAME" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
      echo "GitHub Release asset download unreachable; falling back to apt package for wasm-bindgen..."
      (
        cd "$TMP_WBG"
        apt-get -o APT::Sandbox::User=root download wasm-bindgen
        for deb in *.deb; do
          dpkg-deb -x "$deb" "$TMP_WBG/root"
        done
        cp -a "$TMP_WBG/root/usr/bin/"* "$INSTALL_PREFIX/bin/" 2>/dev/null || true
      )
    else
      rm -rf "$TMP_WBG"
      echo "Error: Failed to download wasm-bindgen from GitHub Releases." >&2
      exit 1
    fi
    rm -rf "$TMP_WBG"
  fi
fi

export LD_LIBRARY_PATH="$INSTALL_PREFIX/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

DETECTED_SYSROOT=""
if [ -d "$INSTALL_PREFIX/lib/rustlib/wasm32-unknown-unknown" ]; then
  DETECTED_SYSROOT="$INSTALL_PREFIX"
elif command -v rustc >/dev/null 2>&1; then
  CANDIDATE_SYSROOT="$(rustc --print sysroot 2>/dev/null || true)"
  if [ -n "$CANDIDATE_SYSROOT" ] && [ -d "$CANDIDATE_SYSROOT/lib/rustlib/wasm32-unknown-unknown" ]; then
    DETECTED_SYSROOT="$CANDIDATE_SYSROOT"
  fi
fi

echo "=== Toolchain Setup Complete! ==="
echo "  Make:         $(make --version | head -n 1)"
if [ -n "$DETECTED_SYSROOT" ]; then
  echo "  Rustc:        $(rustc --sysroot "$DETECTED_SYSROOT" --version)"
else
  echo "  Rustc:        $(rustc --version)"
fi
echo "  wasm-bindgen: $(wasm-bindgen --version)"
echo "You are ready to compile the project by running: make"
