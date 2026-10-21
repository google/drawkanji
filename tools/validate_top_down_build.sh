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
# End-to-end top-down validation script for DrawKanji's standalone Make build.
#
# Performs two isolated container builds in a clean temporary workspace:
#   1. Full top-down build: copies the repository into an isolated container,
#      installs Make & Rust/WASM toolchain dependencies via `tools/setup_toolchain.sh`,
#      downloads KanjiVG SVGs from GitHub, and builds `kanjivg.bin` + WASM via `make`.
#   2. Prebuilt `kanjivg.bin` build: saves `kanjivg.bin` from Run 1 to temp
#      storage, wipes the build & workspace, places `kanjivg.bin` into
#      the source root, and runs `make` — verifying that the KanjiVG zip is NOT
#      downloaded when `kanjivg.bin` is already present in the source tree.
#
# Usage:
#   ./tools/validate_top_down_build.sh [--get-docker] [--deploy <target_directory>]
set -euo pipefail

DEPLOY_DIR=""
GET_DOCKER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --get-docker)
      GET_DOCKER=1
      shift
      ;;
    --deploy)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        echo "Error: --deploy requires a target_directory argument." >&2
        exit 1
      fi
      DEPLOY_DIR="$2"
      shift 2
      ;;
    --deploy=*)
      DEPLOY_DIR="${1#*=}"
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--get-docker] [--deploy <target_directory>]"
      exit 0
      ;;
    *)
      echo "Error: Unknown argument: $1" >&2
      echo "Usage: $0 [--get-docker] [--deploy <target_directory>]" >&2
      exit 1
      ;;
  esac
done

if [ -n "${DEPLOY_DIR}" ]; then
  mkdir -p "${DEPLOY_DIR}"
  DEPLOY_DIR="$(cd "${DEPLOY_DIR}" && pwd)"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

export PATH="$HOME/.local/bin:$PATH"
DOCKER_BIN="docker"

docker_available() {
  if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
      DOCKER_BIN="docker"
      return 0
    elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
      DOCKER_BIN="sudo docker"
      return 0
    fi
  fi
  return 1
}

bwrap_available() {
  command -v bwrap >/dev/null 2>&1 && bwrap --ro-bind / / true >/dev/null 2>&1
}

install_rootless_podman_docker() {
  echo "No passwordless sudo detected; installing rootless Podman (with docker CLI shim) into $HOME/.local..."
  local prefix="$HOME/.local"
  local podman_root="$prefix/opt/podman"
  local tmp_debs
  tmp_debs="$(mktemp -d)"
  mkdir -p "$prefix/bin" "$podman_root" "$HOME/.config/containers"

  (
    cd "$tmp_debs"
    apt-get download \
      podman \
      conmon \
      crun \
      fuse-overlayfs \
      slirp4netns \
      catatonit \
      netavark \
      aardvark-dns \
      passt \
      golang-github-containers-common \
      golang-github-containers-image \
      libsubid5 \
      libblake3-0 \
      libslirp0
    for deb in *.deb; do
      dpkg-deb -x "$deb" "$podman_root"
    done
  )
  rm -rf "$tmp_debs"

  if [ -x "$podman_root/usr/bin/crun" ] && [ ! -x "$podman_root/usr/bin/crun.real" ]; then
    mv "$podman_root/usr/bin/crun" "$podman_root/usr/bin/crun.real"
    cat > "$podman_root/usr/bin/crun" <<EOF
#!/bin/sh
export LD_LIBRARY_PATH="$podman_root/usr/lib/x86_64-linux-gnu:$podman_root/lib/x86_64-linux-gnu:\${LD_LIBRARY_PATH:-}"
exec "$podman_root/usr/bin/crun.real" "\$@"
EOF
    chmod +x "$podman_root/usr/bin/crun"
  fi

  cat > "$HOME/.config/containers/containers.conf" <<EOF
[engine]
runtime = "crun"
cgroup_manager = "cgroupfs"
events_logger = "file"
helper_binaries_dir = ["$podman_root/usr/bin", "$podman_root/usr/libexec/podman", "$podman_root/usr/lib/podman"]
[engine.runtimes]
crun = ["$podman_root/usr/bin/crun"]
[network]
default_rootless_network_cmd = "slirp4netns"
EOF

  cat > "$HOME/.config/containers/storage.conf" <<'EOF'
[storage]
driver = "vfs"
[storage.options]
ignore_chown_errors = "true"
EOF

  cat > "$HOME/.config/containers/policy.json" <<'EOF'
{"default":[{"type":"insecureAcceptAnything"}]}
EOF

  cat > "$HOME/.config/containers/registries.conf" <<'EOF'
unqualified-search-registries = ["mirror.gcr.io", "docker.io"]
EOF

  cat > "$prefix/bin/podman" <<EOF
#!/bin/sh
export PATH="$podman_root/usr/bin:$podman_root/usr/libexec/podman:$podman_root/usr/lib/podman:\$PATH"
export LD_LIBRARY_PATH="$podman_root/usr/lib/x86_64-linux-gnu:$podman_root/lib/x86_64-linux-gnu:\${LD_LIBRARY_PATH:-}"
exec "$podman_root/usr/bin/podman" "\$@"
EOF
  chmod +x "$prefix/bin/podman"

  cat > "$prefix/bin/docker" <<EOF
#!/bin/sh
exec "$prefix/bin/podman" "\$@"
EOF
  chmod +x "$prefix/bin/docker"
}

install_docker() {
  echo "Docker is not currently available. Installing Docker (--get-docker)..."
  local sudo_cmd=""
  local can_root=0
  if [ "$(id -u)" -eq 0 ]; then
    can_root=1
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo_cmd="sudo"
    can_root=1
  fi

  if [ "${can_root}" -eq 1 ]; then
    if command -v apt-get >/dev/null 2>&1; then
      ${sudo_cmd} apt-get update
      ${sudo_cmd} apt-get install -y docker.io
    elif command -v dnf >/dev/null 2>&1; then
      ${sudo_cmd} dnf install -y docker
    elif command -v yum >/dev/null 2>&1; then
      ${sudo_cmd} yum install -y docker
    elif command -v brew >/dev/null 2>&1; then
      brew install --cask docker
    elif command -v curl >/dev/null 2>&1; then
      curl -fsSL https://get.docker.com | ${sudo_cmd} sh
    else
      echo "Error: Could not find a supported package manager to install Docker." >&2
      exit 1
    fi

    # Ensure the Docker daemon is started on Linux
    if [ "$(uname -s)" = "Linux" ]; then
      ${sudo_cmd} systemctl start docker >/dev/null 2>&1 || \
        ${sudo_cmd} service docker start >/dev/null 2>&1 || true
    fi
  elif [ "$(uname -s)" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
    install_rootless_podman_docker
  else
    echo "Error: Root privileges or passwordless sudo are required to install Docker on this system." >&2
    exit 1
  fi

  if ! docker_available; then
    if command -v docker >/dev/null 2>&1 && [ -n "${sudo_cmd}" ] && ${sudo_cmd} docker info >/dev/null 2>&1; then
      DOCKER_BIN="${sudo_cmd} docker"
    else
      echo "Error: Docker was installed, but the Docker daemon is not reachable." >&2
      exit 1
    fi
  fi
}

TEST_ROOT="$(mktemp -d /tmp/drawkanji_validation.XXXXXX)"
SAVED_BIN="${TEST_ROOT}/saved_kanjivg.bin"

cleanup() {
  if [ "${CONTAINER_MODE:-}" = "docker" ] && [ -n "${DOCKER_CONTAINER:-}" ]; then
    ${DOCKER_BIN} exec "${DOCKER_CONTAINER}" /bin/sh -c "chmod -R a+rwX /workspace /home/builder /tmp 2>/dev/null || rm -rf /workspace/* /home/builder/.cache /home/builder/.local /home/builder/.rustup /home/builder/.cargo /tmp/* 2>/dev/null || true" >/dev/null 2>&1 || true
    ${DOCKER_BIN} rm -f -t 0 "${DOCKER_CONTAINER}" >/dev/null 2>&1 || true
  fi
  chmod -R u+w "${TEST_ROOT}" 2>/dev/null || true
  rm -rf "${TEST_ROOT}" 2>/dev/null || true
}
trap cleanup EXIT

chmod +x "${SOURCE_DIR}/tools/setup_toolchain.sh" "${SOURCE_DIR}/tools/build_wasm.sh"

if [ "${GET_DOCKER}" -eq 1 ]; then
  if ! docker_available; then
    install_docker
  fi
  CONTAINER_MODE="docker"
  DOCKER_IMAGE="${DOCKER_IMAGE:-debian:trixie-slim}"
  DOCKER_CONTAINER="drawkanji-validate-$$"
elif [ "${USE_BWRAP:-0}" != "1" ] && docker_available; then
  CONTAINER_MODE="docker"
  DOCKER_IMAGE="${DOCKER_IMAGE:-debian:trixie-slim}"
  DOCKER_CONTAINER="drawkanji-validate-$$"
elif bwrap_available; then
  CONTAINER_MODE="bwrap"
else
  echo "Error: No supported container runtime (docker or bubblewrap) is available on this system." >&2
  echo "Please try again with '--get-docker' to install Docker prior to running the rest of the script:" >&2
  echo "  $0 --get-docker" >&2
  exit 1
fi

echo "=================================================================="
echo " DrawKanji Top-Down Standalone Make Validation"
echo " Source Directory : ${SOURCE_DIR}"
echo " Staging Directory: ${TEST_ROOT}"
echo " Container Runtime: ${CONTAINER_MODE}"
if [ -n "${DEPLOY_DIR}" ]; then
  echo " Deploy Directory : ${DEPLOY_DIR}"
fi
echo "=================================================================="

mkdir -p "${TEST_ROOT}/usr_local" "${TEST_ROOT}/home" "${TEST_ROOT}/tmp" "${TEST_ROOT}/workspace"
chmod a+rwxt "${TEST_ROOT}/tmp"
chmod a+rwx "${TEST_ROOT}/home" "${TEST_ROOT}/workspace" "${TEST_ROOT}/usr_local"

echo ""
echo "[1/7] Copying project tree to isolated staging workspace (${TEST_ROOT}/workspace/drawkanji)..."
cp -r "${SOURCE_DIR}" "${TEST_ROOT}/workspace/drawkanji"
rm -rf "${TEST_ROOT}/workspace/drawkanji/build" \
       "${TEST_ROOT}/workspace/drawkanji/pkg" \
       "${TEST_ROOT}/workspace/drawkanji/target" \
       "${TEST_ROOT}/workspace/drawkanji/kanjivg.bin"

if [ "${CONTAINER_MODE}" = "docker" ]; then
  DOCKER_EXTRA_ARGS=(
    -v "${TEST_ROOT}/home:/home/builder"
    -v "${TEST_ROOT}/tmp:/tmp"
    -e HOME=/home/builder
    -e USER=builder
    -e FORCE_UPSTREAM_TOOLCHAIN="${FORCE_UPSTREAM_TOOLCHAIN:-0}"
    -e PATH=/usr/local/bin:/home/builder/.local/bin:/home/builder/.cargo/bin:/usr/bin:/bin
  )
  if [ -e /usr/lib/apt/methods/uplib+https ] || [ -e /usr/lib/apt/methods/uplib ]; then
    # Custom APT transport detected: mount host system dirs read-only
    DOCKER_EXTRA_ARGS+=(
      --privileged
      --network=host
      -v /usr:/usr:ro
      -v /lib:/lib:ro
      -v /lib64:/lib64:ro
      -v /bin:/bin:ro
      -v /sbin:/sbin:ro
      -v /etc:/etc:ro
      -v /var:/var:ro
      -v /run:/run:ro
    )
  fi
  ${DOCKER_BIN} run -d --name "${DOCKER_CONTAINER}" \
    "${DOCKER_EXTRA_ARGS[@]}" \
    -v "${TEST_ROOT}/workspace:/workspace" \
    -v "${TEST_ROOT}/tmp:/tmp_host" \
    -w /workspace/drawkanji \
    "${DOCKER_IMAGE}" sleep 3600 >/dev/null
  run_in_container() {
    ${DOCKER_BIN} exec \
      -e HOME=/home/builder \
      -e USER=builder \
      -e FORCE_UPSTREAM_TOOLCHAIN="${FORCE_UPSTREAM_TOOLCHAIN:-0}" \
      -e PATH=/usr/local/bin:/home/builder/.local/bin:/home/builder/.cargo/bin:/usr/bin:/bin \
      -w /workspace/drawkanji \
      "${DOCKER_CONTAINER}" /bin/bash -c "$1"
  }
else
  # Isolated Bubblewrap container with read-only system mounts
  run_in_container() {
    bwrap \
      --ro-bind /usr /usr \
      --ro-bind /lib /lib \
      --ro-bind /lib64 /lib64 \
      --ro-bind /bin /bin \
      --ro-bind /sbin /sbin \
      --ro-bind /etc /etc \
      --ro-bind /var /var \
      --ro-bind /run /run \
      --bind "${TEST_ROOT}/usr_local" /usr/local \
      --bind "${TEST_ROOT}/home" /home/builder \
      --bind "${TEST_ROOT}/tmp" /tmp \
      --bind "${TEST_ROOT}/workspace" /workspace \
      --dev /dev \
      --proc /proc \
      --unshare-pid \
      --setenv HOME /home/builder \
      --setenv USER builder \
      --setenv FORCE_UPSTREAM_TOOLCHAIN "${FORCE_UPSTREAM_TOOLCHAIN:-0}" \
      --setenv PATH "/usr/local/bin:/home/builder/.local/bin:/home/builder/.cargo/bin:/usr/bin:/bin" \
      --chdir /workspace/drawkanji \
      /bin/bash -c "$1"
  }
fi

echo ""
echo "[2/7] Installing Make & Rust/WASM dependencies via ./tools/setup_toolchain.sh..."
run_in_container "./tools/setup_toolchain.sh"

echo ""
echo "[3/7] Running Build #1 (top-down 'make' with KanjiVG download & kanjivg.bin generation)..."
run_in_container "make"

echo ""
echo "Verifying Build #1 artifacts:"
run_in_container '
  ls -lh kanjivg.bin \
         pkg/drawkanji_wasm_bin.js \
         pkg/drawkanji_wasm_bin_bg.wasm \
         pkg/drawkanji_wasm_bytes.js
  test -f build/kanjivg_dl/kanjivg.zip
  echo "  Confirmed: KanjiVG release archive downloaded to build/kanjivg_dl/kanjivg.zip"
'

echo ""
echo "[4/7] Saving generated kanjivg.bin to temporary space (${SAVED_BIN})..."
run_in_container "cp -f kanjivg.bin /workspace/saved_kanjivg.bin && chmod 0644 /workspace/saved_kanjivg.bin"
cp -f "${TEST_ROOT}/workspace/saved_kanjivg.bin" "${SAVED_BIN}"
run_in_container "rm -f /workspace/saved_kanjivg.bin"
ls -lh "${SAVED_BIN}"

echo ""
echo "[5/7] Cleaning up build and recreating clean workspace..."
run_in_container "chmod -R a+rwX /workspace/drawkanji /tmp 2>/dev/null || true; rm -rf /workspace/drawkanji /tmp/*; chmod a+rwxt /tmp 2>/dev/null || true"
chmod -R u+w "${TEST_ROOT}/workspace" 2>/dev/null || true
rm -rf "${TEST_ROOT}/workspace/drawkanji"
cp -r "${SOURCE_DIR}" "${TEST_ROOT}/workspace/drawkanji"
rm -rf "${TEST_ROOT}/workspace/drawkanji/build" \
       "${TEST_ROOT}/workspace/drawkanji/pkg" \
       "${TEST_ROOT}/workspace/drawkanji/target" \
       "${TEST_ROOT}/workspace/drawkanji/kanjivg.bin"

echo ""
echo "[6/7] Placing saved kanjivg.bin into source directory (/workspace/drawkanji/kanjivg.bin)..."
cp -f "${SAVED_BIN}" "${TEST_ROOT}/workspace/drawkanji/kanjivg.bin"
ls -lh "${TEST_ROOT}/workspace/drawkanji/kanjivg.bin"

echo ""
echo "[7/7] Running Build #2 ('make' with prebuilt kanjivg.bin in source tree)..."
run_in_container "make"

echo ""
echo "Verifying Build #2 artifacts and confirming KanjiVG zip was NOT downloaded:"
run_in_container '
  ls -lh kanjivg.bin \
         pkg/drawkanji_wasm_bin.js \
         pkg/drawkanji_wasm_bin_bg.wasm \
         pkg/drawkanji_wasm_bytes.js
  if [ -e build/kanjivg_dl ]; then
    echo "ERROR: build/kanjivg_dl was unexpectedly created in Build #2!" >&2
    exit 1
  fi
  echo "  Confirmed: No build/kanjivg_dl directory created — zero KanjiVG downloads occurred!"
'

if [ -n "${DEPLOY_DIR}" ]; then
  echo ""
  echo "Deploying Build #2 outputs and web-facing assets via 'make deploy' to ${DEPLOY_DIR}..."
  run_in_container "make deploy DEPLOY_DIR=/workspace/deploy_staging && chmod -R a+rX /workspace/deploy_staging"

  mkdir -p "${DEPLOY_DIR}"
  cp -rf "${TEST_ROOT}/workspace/deploy_staging/." "${DEPLOY_DIR}/"
  echo "  Deployed web assets and container build artifacts to ${DEPLOY_DIR}"
  ls -lh "${DEPLOY_DIR}/index.html" \
         "${DEPLOY_DIR}/kanjivg/kanjivg.bin" \
         "${DEPLOY_DIR}/pkg/drawkanji_wasm_bin.js" \
         "${DEPLOY_DIR}/pkg/drawkanji_wasm_bytes.js"
fi

echo ""
echo "=================================================================="
echo " ✅ Top-Down Validation Passed (Build #1 & Build #2 Succeeded)"
if [ -n "${DEPLOY_DIR}" ]; then
  echo " ✅ Deployed to: ${DEPLOY_DIR}"
fi
echo "=================================================================="
