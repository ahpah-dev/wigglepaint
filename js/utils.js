// ============================================================================
// WigglePaint — Math, Geometry, Easing, and Pixel Utilities
// ============================================================================
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Shortest signed angular difference from a to b in [-PI, PI]
  function shortAngleDiff(a, b) {
    let diff = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
    return diff;
  }

  function lerpAngle(a, b, t) {
    return a + shortAngleDiff(a, b) * t;
  }

  function hypot2(dx, dy) {
    return Math.sqrt(dx * dx + dy * dy);
  }

  function dist(x1, y1, x2, y2) {
    return Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
  }

  // Distance from point (px, py) to segment (ax, ay)-(bx, by), plus closest param t in [0,1]
  function pointToSegment(px, py, ax, ay, bx, by) {
    const vx = bx - ax;
    const vy = by - ay;
    const lenSq = vx * vx + vy * vy;
    let t = 0;
    if (lenSq > 1e-6) {
      t = clamp(((px - ax) * vx + (py - ay) * vy) / lenSq, 0, 1);
    }
    const cx = ax + vx * t;
    const cy = ay + vy * t;
    const dx = px - cx;
    const dy = py - cy;
    return { dist: Math.sqrt(dx * dx + dy * dy), t, cx, cy };
  }

  // Easing functions supporting overshoot (Springy / Elastic)
  const Easings = {
    smooth(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    },
    linear(t) {
      return t;
    },
    easeOut(t) {
      return 1 - Math.pow(1 - t, 3);
    },
    easeIn(t) {
      return t * t * t;
    },
    springy(t) {
      const c1 = 1.70158;
      const c2 = c1 * 1.525;
      return t < 0.5
        ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
        : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
    },
    bouncy(t) {
      const n1 = 7.5625;
      const d1 = 2.75;
      let x = t;
      if (x < 1 / d1) {
        return n1 * x * x;
      } else if (x < 2 / d1) {
        x -= 1.5 / d1;
        return n1 * x * x + 0.75;
      } else if (x < 2.5 / d1) {
        x -= 2.25 / d1;
        return n1 * x * x + 0.9375;
      } else {
        x -= 2.625 / d1;
        return n1 * x * x + 0.984375;
      }
    },
    elastic(t) {
      if (t === 0 || t === 1) return t;
      const c4 = (2 * Math.PI) / 3.6;
      return Math.pow(2, -9 * t) * Math.sin((t * 8.5 - 0.75) * c4) + 1;
    },
    hold(t) {
      return t >= 1 ? 1 : 0;
    }
  };

  function applyEasing(name, t) {
    const fn = Easings[name] || Easings.smooth;
    return fn(clamp(t, 0, 1));
  }

  function hexToRgba(hex, alpha = 255) {
    let h = (hex || '#000000').replace('#', '').trim();
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    const num = parseInt(h, 16) || 0;
    return [
      (num >> 16) & 255,
      (num >> 8) & 255,
      num & 255,
      alpha
    ];
  }

  function rgbToHex(r, g, b) {
    const toH = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    return `#${toH(r)}${toH(g)}${toH(b)}`;
  }

  // Smart Scanline Flood Fill with 1px Anti-Aliased Under-Bleed (eliminates white halos!)
  function smartFloodFill(ctx, startX, startY, fillHex, tolerance = 42) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const sx = Math.floor(startX);
    const sy = Math.floor(startY);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return false;

    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const [fr, fg, fb, fa] = hexToRgba(fillHex, 255);

    const seedIdx = (sy * w + sx) * 4;
    const sr = data[seedIdx];
    const sg = data[seedIdx + 1];
    const sb = data[seedIdx + 2];
    const sa = data[seedIdx + 3];

    // No-op if clicking an already identical opaque pixel with low tolerance
    if (sa > 250 && Math.abs(sr - fr) <= 2 && Math.abs(sg - fg) <= 2 && Math.abs(sb - fb) <= 2) {
      return false;
    }

    const tolSq = tolerance * tolerance * 3.2;

    function matchesSeed(pIdx) {
      const a = data[pIdx + 3];
      if (sa < 16) {
        // Filling transparent region: match transparent/near-transparent pixels
        return a <= Math.max(24, tolerance * 1.4);
      }
      const dr = data[pIdx] - sr;
      const dg = data[pIdx + 1] - sg;
      const db = data[pIdx + 2] - sb;
      const da = a - sa;
      return (dr * dr + dg * dg + db * db + da * da * 1.2) <= tolSq;
    }

    const visited = new Uint8Array(w * h);
    const filled = new Uint8Array(w * h);
    const stack = [sx, sy];

    while (stack.length > 0) {
      const y = stack.pop();
      let x = stack.pop();
      let idx = y * w + x;
      if (visited[idx]) continue;

      while (x > 0 && !visited[y * w + (x - 1)] && matchesSeed((y * w + (x - 1)) * 4)) {
        x--;
      }

      let spanAbove = false;
      let spanBelow = false;

      while (x < w) {
        idx = y * w + x;
        const pIdx = idx * 4;
        if (visited[idx] || !matchesSeed(pIdx)) break;

        visited[idx] = 1;
        filled[idx] = 1;

        if (y > 0) {
          const upIdx = (y - 1) * w + x;
          const upMatch = !visited[upIdx] && matchesSeed(upIdx * 4);
          if (!spanAbove && upMatch) {
            stack.push(x, y - 1);
            spanAbove = true;
          } else if (spanAbove && !upMatch) {
            spanAbove = false;
          }
        }

        if (y < h - 1) {
          const dnIdx = (y + 1) * w + x;
          const dnMatch = !visited[dnIdx] && matchesSeed(dnIdx * 4);
          if (!spanBelow && dnMatch) {
            stack.push(x, y + 1);
            spanBelow = true;
          } else if (spanBelow && !dnMatch) {
            spanBelow = false;
          }
        }
        x++;
      }
    }

    // Apply solid fill to filled mask + composite fill UNDER 1px anti-aliased outline neighbors
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const idx = row + x;
        const pIdx = idx * 4;
        if (filled[idx]) {
          data[pIdx] = fr;
          data[pIdx + 1] = fg;
          data[pIdx + 2] = fb;
          data[pIdx + 3] = fa;
        } else {
          // Check if adjacent to a filled pixel and partially transparent (AA fringe)
          const alpha = data[pIdx + 3];
          if (alpha > 0 && alpha < 245) {
            const hasFilledNeighbor =
              (x > 0 && filled[idx - 1]) ||
              (x < w - 1 && filled[idx + 1]) ||
              (y > 0 && filled[idx - w]) ||
              (y < h - 1 && filled[idx + w]);
            if (hasFilledNeighbor) {
              // Composite existing pixel OVER the new fill color (destination-over)
              const srcA = alpha / 255;
              const invA = 1 - srcA;
              data[pIdx] = Math.round(data[pIdx] * srcA + fr * invA);
              data[pIdx + 1] = Math.round(data[pIdx + 1] * srcA + fg * invA);
              data[pIdx + 2] = Math.round(data[pIdx + 2] * srcA + fb * invA);
              data[pIdx + 3] = 255;
            }
          }
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
    return true;
  }

  // Compute tight non-transparent bounding box of a canvas
  function getCanvasContentBounds(canvas, alphaThreshold = 8) {
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, w, h).data;

    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (data[(row + x) * 4 + 3] > alphaThreshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX) {
      return null;
    }
    return {
      x: minX,
      y: minY,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      cx: (minX + maxX + 1) / 2,
      cy: (minY + maxY + 1) / 2
    };
  }

  // Extract connected pixel component at (startX, startY)
  function getConnectedComponentBoundsAndMask(ctx, startX, startY, alphaThreshold = 8) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const sx = Math.floor(startX);
    const sy = Math.floor(startY);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;

    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const startIdx = (sy * w + sx) * 4;
    if (data[startIdx + 3] <= alphaThreshold) return null;

    const visited = new Uint8Array(w * h);
    const stack = [sx, sy];
    visited[sy * w + sx] = 1;

    let minX = sx, maxX = sx, minY = sy, maxY = sy;

    while (stack.length > 0) {
      const cy = stack.pop();
      const cx = stack.pop();

      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;

      // 4-way neighbors
      const neighbors = [
        [cx - 1, cy],
        [cx + 1, cy],
        [cx, cy - 1],
        [cx, cy + 1]
      ];

      for (let i = 0; i < 4; i++) {
        const nx = neighbors[i][0];
        const ny = neighbors[i][1];
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          const nidx = ny * w + nx;
          if (!visited[nidx]) {
            visited[nidx] = 1;
            if (data[nidx * 4 + 3] > alphaThreshold) {
              stack.push(nx, ny);
            }
          }
        }
      }
    }

    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;
    return {
      x: minX,
      y: minY,
      w: cw,
      h: ch,
      visited
    };
  }

  let uidCounter = 1;
  function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${(uidCounter++).toString(36)}`;
  }

  global.WPUtils = {
    TAU,
    clamp,
    lerp,
    shortAngleDiff,
    lerpAngle,
    hypot2,
    dist,
    pointToSegment,
    Easings,
    applyEasing,
    hexToRgba,
    rgbToHex,
    smartFloodFill,
    getCanvasContentBounds,
    getConnectedComponentBoundsAndMask,
    uid
  };
})(window);
