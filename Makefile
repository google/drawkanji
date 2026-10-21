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
# Standalone Makefile for DrawKanji (WebGPU / Canvas Kanji Stroke Visualizer)
#
# Usage:
#   make                             Build kanjivg.bin and WASM deliverables
#   make wasm                        Build only the Rust -> WebAssembly deliverables
#   make kanjivg.bin                 Download KanjiVG SVGs and build kanjivg.bin (if not already present)
#   make deploy DEPLOY_DIR=/path     Build and deploy all web deliverables to DEPLOY_DIR
#   make clean                       Remove build intermediates (keeps prebuilt kanjivg.bin)
#   make distclean                   Remove all build outputs including kanjivg.bin

PYTHON ?= python3
CURL ?= curl
UNZIP ?= unzip
WASM_BINDGEN ?= wasm-bindgen

BUILD_DIR ?= build
PKG_DIR ?= pkg
DEPLOY_DIR ?=

KANJIVG_URL ?= https://github.com/KanjiVG/kanjivg/releases/download/r20260714/kanjivg-20260714-main.zip
KANJIVG_SHA256 ?= b5df6cd2bc249dd49b8041eb99e38ba9f8dc6b9ea57962a80084b4a315d1a7fc

RUST_SRCS := $(wildcard src/*.rs)
WASM_LIB := $(BUILD_DIR)/drawkanji_rs.wasm
WASM_BG := $(PKG_DIR)/drawkanji_wasm_bin_bg.wasm
WASM_JS := $(PKG_DIR)/drawkanji_wasm_bin.js
WASM_BYTES_JS := $(PKG_DIR)/drawkanji_wasm_bytes.js

export PATH := /usr/local/bin:$(HOME)/.local/bin:$(HOME)/.cargo/bin:$(PATH)

.PHONY: all wasm deploy clean distclean

all: kanjivg.bin wasm

wasm: $(WASM_JS) $(WASM_BG) $(WASM_BYTES_JS)

# If kanjivg.bin already exists in the source tree, Make treats this target as
# up-to-date and skips downloading the KanjiVG SVG release archive.
kanjivg.bin:
	@echo "=== Downloading KanjiVG SVG release archive ==="
	@mkdir -p $(BUILD_DIR)/kanjivg_dl
	$(CURL) -fSL "$(KANJIVG_URL)" -o $(BUILD_DIR)/kanjivg_dl/kanjivg.zip
	@echo "$(KANJIVG_SHA256)  $(BUILD_DIR)/kanjivg_dl/kanjivg.zip" | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -)
	$(UNZIP) -q -o $(BUILD_DIR)/kanjivg_dl/kanjivg.zip -d $(BUILD_DIR)/kanjivg_dl
	@echo "=== Building kanjivg.bin binary trie archive ==="
	$(PYTHON) tools/build_kanjivg_archive.py $(BUILD_DIR)/kanjivg_dl/kanji $@

$(WASM_LIB): $(RUST_SRCS) tools/build_wasm.sh
	@mkdir -p $(BUILD_DIR)
	./tools/build_wasm.sh $@

$(WASM_BG): $(WASM_LIB)
	@mkdir -p $(PKG_DIR)
	@echo "=== Generating JavaScript & WebAssembly bindings via wasm-bindgen ==="
	LD_LIBRARY_PATH="/usr/local/lib/x86_64-linux-gnu:$(HOME)/.local/lib/x86_64-linux-gnu:$${LD_LIBRARY_PATH:-}" \
	$(WASM_BINDGEN) --target no-modules --out-name drawkanji_wasm_bin --out-dir $(PKG_DIR) $(WASM_LIB)

$(WASM_JS): $(WASM_BG)
	@test -f $@ || (rm -f $(WASM_BG) && $(MAKE) $(WASM_BG))

$(WASM_BYTES_JS): $(WASM_BG) tools/encode_wasm_bytes.py
	@echo "=== Encoding in-memory WebAssembly payload ($(WASM_BYTES_JS)) ==="
	$(PYTHON) tools/encode_wasm_bytes.py $(WASM_BG) $@

deploy: all
	@if [ -z "$(DEPLOY_DIR)" ]; then \
		echo "Error: DEPLOY_DIR is required. Usage: make deploy DEPLOY_DIR=/path/to/dir" >&2; \
		exit 1; \
	fi
	@echo "=== Deploying DrawKanji web deliverables to $(DEPLOY_DIR) ==="
	@mkdir -p "$(DEPLOY_DIR)" "$(DEPLOY_DIR)/kanjivg" "$(DEPLOY_DIR)/pkg"
	cp -f *.html *.css *.js "$(DEPLOY_DIR)/"
	@if [ -f .htaccess ]; then cp -f .htaccess "$(DEPLOY_DIR)/.htaccess"; fi
	cp -f kanjivg.bin "$(DEPLOY_DIR)/kanjivg/kanjivg.bin"
	cp -f $(WASM_JS) $(WASM_BG) $(WASM_BYTES_JS) "$(DEPLOY_DIR)/pkg/"
	@chmod -R a+rX "$(DEPLOY_DIR)" 2>/dev/null || true
	@echo "=== Deployment complete: $(DEPLOY_DIR) ==="

clean:
	rm -rf $(BUILD_DIR) $(PKG_DIR) target

distclean: clean
	rm -f kanjivg.bin
