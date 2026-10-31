// ============================================================================
// WigglePaint — Self-Contained Pure-JS GIF89a Encoder (Zero Dependencies)
// ============================================================================
(function (global) {
  'use strict';

  function buildPalette(framesRgba) {
    // 1. Collect frequent exact colors (quantized to 5-bit buckets to group near-identical shades, storing exact average)
    const bucketCounts = new Int32Array(32768);
    const bucketR = new Float64Array(32768);
    const bucketG = new Float64Array(32768);
    const bucketB = new Float64Array(32768);

    const stride = Math.max(1, Math.floor((framesRgba[0].length / 4) / 12000)) * 4;
    for (let f = 0; f < framesRgba.length; f++) {
      const data = framesRgba[f];
      for (let i = 0; i < data.length; i += stride) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        bucketCounts[key]++;
        bucketR[key] += r;
        bucketG[key] += g;
        bucketB[key] += b;
      }
    }

    const usedBuckets = [];
    for (let k = 0; k < 32768; k++) {
      if (bucketCounts[k] > 0) {
        usedBuckets.push({
          count: bucketCounts[k],
          r: Math.round(bucketR[k] / bucketCounts[k]),
          g: Math.round(bucketG[k] / bucketCounts[k]),
          b: Math.round(bucketB[k] / bucketCounts[k])
        });
      }
    }
    usedBuckets.sort((a, b) => b.count - a.count);

    const palette = [];
    // Take up to 130 dominant scene colors (covers all MS-Paint flat fills & strokes cleanly)
    const maxSceneColors = Math.min(130, usedBuckets.length);
    for (let i = 0; i < maxSceneColors; i++) {
      palette.push([usedBuckets[i].r, usedBuckets[i].g, usedBuckets[i].b]);
    }

    // Fill remaining slots with a uniform 5x5x5 color cube (125 colors) so anti-aliased transitions never band
    const steps = [0, 64, 128, 192, 255];
    for (let r of steps) {
      for (let g of steps) {
        for (let b of steps) {
          if (palette.length < 256) {
            palette.push([r, g, b]);
          }
        }
      }
    }
    while (palette.length < 256) {
      palette.push([0, 0, 0]);
    }

    // Precompute fast 15-bit RGB555 -> palette index lookup table (32,768 entries)
    const lut = new Uint8Array(32768);
    for (let ir = 0; ir < 32; ir++) {
      const r = (ir << 3) | (ir >> 2);
      for (let ig = 0; ig < 32; ig++) {
        const g = (ig << 3) | (ig >> 2);
        for (let ib = 0; ib < 32; ib++) {
          const b = (ib << 3) | (ib >> 2);
          let bestIdx = 0;
          let bestDist = 1e9;
          for (let p = 0; p < 256; p++) {
            const dr = r - palette[p][0];
            const dg = g - palette[p][1];
            const db = b - palette[p][2];
            const d = dr * dr + dg * dg + db * db;
            if (d < bestDist) {
              bestDist = d;
              bestIdx = p;
              if (d === 0) break;
            }
          }
          lut[(ir << 10) | (ig << 5) | ib] = bestIdx;
        }
      }
    }

    return { palette, lut };
  }

  function lzwEncode(indices, outBytes) {
    const minCodeSize = 8;
    const clearCode = 256;
    const eoiCode = 257;

    outBytes.push(minCodeSize);

    // Flat dictionary table: [prefix * 256 + suffix] -> code + 1 (0 means empty)
    const dict = new Int32Array(4096 * 256);

    let codeSize = 9;
    let nextCode = 258;
    let bitBuffer = 0;
    let bitCount = 0;
    const subBlock = [];

    function flushSubBlock() {
      if (subBlock.length > 0) {
        outBytes.push(subBlock.length);
        for (let i = 0; i < subBlock.length; i++) {
          outBytes.push(subBlock[i]);
        }
        subBlock.length = 0;
      }
    }

    function writeCode(code) {
      bitBuffer |= (code << bitCount);
      bitCount += codeSize;
      while (bitCount >= 8) {
        subBlock.push(bitBuffer & 0xff);
        bitBuffer >>= 8;
        bitCount -= 8;
        if (subBlock.length === 255) {
          flushSubBlock();
        }
      }
    }

    // Initial Clear Code
    writeCode(clearCode);

    if (indices.length === 0) {
      writeCode(eoiCode);
    } else {
      let prefix = indices[0];
      for (let i = 1; i < indices.length; i++) {
        const suffix = indices[i];
        const key = (prefix << 8) | suffix;
        const entry = dict[key];
        if (entry !== 0) {
          prefix = entry - 1;
        } else {
          writeCode(prefix);
          if (nextCode < 4096) {
            dict[key] = nextCode + 1;
            if (nextCode === (1 << codeSize) && codeSize < 12) {
              codeSize++;
            }
            nextCode++;
          } else {
            writeCode(clearCode);
            dict.fill(0);
            codeSize = 9;
            nextCode = 258;
          }
          prefix = suffix;
        }
      }
      writeCode(prefix);
      writeCode(eoiCode);
    }

    if (bitCount > 0) {
      subBlock.push(bitBuffer & 0xff);
    }
    flushSubBlock();
    outBytes.push(0x00); // Block terminator
  }

  function encodeGIF(width, height, framesRgba, delayCs = 5) {
    const { palette, lut } = buildPalette(framesRgba);
    const out = [];

    function writeStr(s) {
      for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    }
    function writeU16(v) {
      out.push(v & 0xff, (v >> 8) & 0xff);
    }

    // 1. Header
    writeStr('GIF89a');

    // 2. Logical Screen Descriptor
    writeU16(width);
    writeU16(height);
    out.push(0xf7); // Global color table, 8-bit color, 256 entries
    out.push(0x00); // Background color index
    out.push(0x00); // Pixel aspect ratio

    // 3. Global Color Table (256 * 3 bytes)
    for (let i = 0; i < 256; i++) {
      out.push(palette[i][0], palette[i][1], palette[i][2]);
    }

    // 4. Netscape 2.0 Loop Extension (Infinite Loop)
    out.push(0x21, 0xff, 0x0b);
    writeStr('NETSCAPE2.0');
    out.push(0x03, 0x01, 0x00, 0x00, 0x00);

    const pixelCount = width * height;
    const indexed = new Uint8Array(pixelCount);

    // 5. Frames
    for (let f = 0; f < framesRgba.length; f++) {
      const rgba = framesRgba[f];
      for (let p = 0, j = 0; p < pixelCount; p++, j += 4) {
        const key = ((rgba[j] >> 3) << 10) | ((rgba[j + 1] >> 3) << 5) | (rgba[j + 2] >> 3);
        indexed[p] = lut[key];
      }

      // Graphic Control Extension
      out.push(0x21, 0xf9, 0x04, 0x04);
      writeU16(Math.max(2, Math.round(delayCs)));
      out.push(0x00, 0x00);

      // Image Descriptor
      out.push(0x2c);
      writeU16(0);
      writeU16(0);
      writeU16(width);
      writeU16(height);
      out.push(0x00);

      // LZW Data
      lzwEncode(indexed, out);
    }

    // 6. GIF Trailer
    out.push(0x3b);

    return new Blob([new Uint8Array(out)], { type: 'image/gif' });
  }

  global.WPGif = { encodeGIF };
})(window);
