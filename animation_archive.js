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

function countSetBits(n) {
  let count = 0;
  while (n > 0) {
    count += n & 1;
    n >>= 1;
  }
  return count;
}

function lookupKanjiInArchive(hexStr) {
  if (!AppState.kanjiArchiveIndexDataView) return null;
  const view = AppState.kanjiArchiveIndexDataView;
  let offset = 0;

  for (let i = 0; i < hexStr.length; i++) {
    const hexVal = parseInt(hexStr[i], 16);
    if (isNaN(hexVal)) return null;

    const meta = view.getUint8(offset);
    const isTerminal = (meta & 0x80) !== 0;
    const childBitmask = view.getUint16(offset + 1, true);

    if ((childBitmask & (1 << hexVal)) === 0) {
      return null;
    }

    const maskBefore = childBitmask & ((1 << hexVal) - 1);
    const childIndex = countSetBits(maskBefore);

    const childArrayStart = isTerminal ? (offset + 11) : (offset + 3);
    const childNodeOffset = view.getUint32(childArrayStart + childIndex * 4, true);
    offset = childNodeOffset;
  }

  const finalMeta = view.getUint8(offset);
  const finalIsTerminal = (finalMeta & 0x80) !== 0;
  if (!finalIsTerminal) return null;

  const fileOffset = view.getUint32(offset + 3, true);
  const fileLength = view.getUint32(offset + 7, true);

  return {
    offset: AppState.kanjiArchiveContentBaseOffset + fileOffset,
    length: fileLength
  };
}

async function initKanjiArchiveIndex() {
  if (AppState.kanjiArchiveIndexDataView) return;
  try {
    const res = await fetch('kanjivg/kanjivg.bin', {
      headers: { Range: 'bytes=0-7' }
    });

    if (res.status === 200) {
      const fullBuf = await res.arrayBuffer();
      const view = new DataView(fullBuf);
      const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
      if (magic !== 'AE3A') {
        throw new Error(`Invalid archive magic header: ${magic}`);
      }
      const indexLength = view.getUint32(4, true);
      AppState.kanjiArchiveIndexDataView = new DataView(fullBuf, 8, indexLength);
      AppState.kanjiArchiveContentBaseOffset = 8 + indexLength;
      AppState.kanjiArchiveFullBuffer = fullBuf;
      console.log('KanjiVG archive index initialized (full buffer mode).');
      return;
    }

    if (res.status === 206) {
      const headerBuf = await res.arrayBuffer();
      const headerView = new DataView(headerBuf);
      const magic = String.fromCharCode(headerView.getUint8(0), headerView.getUint8(1), headerView.getUint8(2), headerView.getUint8(3));
      if (magic !== 'AE3A') {
        throw new Error(`Invalid archive magic header: ${magic}`);
      }
      const indexLength = headerView.getUint32(4, true);

      const indexRes = await fetch('kanjivg/kanjivg.bin', {
        headers: { Range: `bytes=8-${8 + indexLength - 1}` }
      });
      const indexBuf = await indexRes.arrayBuffer();
      AppState.kanjiArchiveIndexDataView = new DataView(indexBuf);
      AppState.kanjiArchiveContentBaseOffset = 8 + indexLength;
      console.log('KanjiVG archive index initialized (range mode).');
    }
  } catch (err) {
    console.warn('Failed to load KanjiVG binary archive index:', err);
  }
}

async function fetchSVGFromArchive(hexStr) {
  if (!AppState.kanjiArchiveIndexDataView) {
    await initKanjiArchiveIndex();
  }
  if (!AppState.kanjiArchiveIndexDataView) {
    throw new Error(`KanjiVG binary archive (kanjivg.bin) is unavailable.`);
  }

  const location = lookupKanjiInArchive(hexStr);
  if (!location) {
    throw new Error(`Character hex string '${hexStr}' not found in local KanjiVG archive.`);
  }

  if (AppState.kanjiArchiveFullBuffer) {
    const textDecoder = new TextDecoder('utf-8');
    const bytes = new Uint8Array(AppState.kanjiArchiveFullBuffer, location.offset, location.length);
    return textDecoder.decode(bytes);
  }

  const rangeHeader = `bytes=${location.offset}-${location.offset + location.length - 1}`;
  const res = await fetch('kanjivg/kanjivg.bin', {
    headers: { Range: rangeHeader }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch SVG byte range from local kanjivg.bin`);
  }
  return await res.text();
}
