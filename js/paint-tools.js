// ============================================================================
// WigglePaint — Classic MS-Paint Tools + Stabilized Brush + Lasso-to-Part
// ============================================================================
(function (global) {
  'use strict';

  const { clamp, dist, rgbToHex, smartFloodFill, getCanvasContentBounds, getConnectedComponentBoundsAndMask } = global.WPUtils;
  const { StrokeSmoother, catmullRomToBezier } = global.WPSmoothing;
  const {
    STAGE_W,
    STAGE_H,
    state,
    createOffscreenCanvas,
    createPart,
    getActiveDrawTarget,
    markPartDirty,
    pushHistory,
    notify
  } = global.WPState;

  const previewCanvas = createOffscreenCanvas(STAGE_W, STAGE_H);
  const previewCtx = previewCanvas.getContext('2d');

  let activeStroke = null;
  let sprayTimer = null;

  // Commit any floating selection back to its layer
  function commitSelection() {
    const sel = state.selection;
    if (!sel || !sel.canvas) {
      state.selection = null;
      return;
    }
    const targetPart = state.parts.find((p) => p.id === sel.partId);
    const ctx = sel.isBackdrop
      ? state.backdropCtx
      : targetPart
        ? targetPart.ctx
        : (getActiveDrawTarget() && getActiveDrawTarget().ctx);

    if (ctx) {
      ctx.save();
      ctx.translate(sel.x + sel.w * 0.5, sel.y + sel.h * 0.5);
      ctx.rotate(sel.rotation || 0);
      ctx.drawImage(sel.canvas, -sel.w * 0.5, -sel.h * 0.5, sel.w, sel.h);
      ctx.restore();
      if (targetPart) markPartDirty(targetPart);
    }
    state.selection = null;
    notify('selection-commit');
  }

  // Turn current floating selection into its own independent tweenable/riggable Part!
  function popSelectionToNewPart() {
    const sel = state.selection;
    if (!sel || !sel.canvas) return null;

    const newPart = createPart(`Part ${state.parts.length + 1}`, 'auto');
    newPart.ctx.save();
    newPart.ctx.translate(sel.x + sel.w * 0.5, sel.y + sel.h * 0.5);
    newPart.ctx.rotate(sel.rotation || 0);
    newPart.ctx.drawImage(sel.canvas, -sel.w * 0.5, -sel.h * 0.5, sel.w, sel.h);
    newPart.ctx.restore();
    markPartDirty(newPart);

    state.parts.push(newPart);
    state.activePartId = newPart.id;
    state.editingBackdrop = false;
    state.selection = null;
    notify('parts-changed');
    return newPart;
  }

  function deleteSelectionPixels() {
    if (!state.selection) return;
    pushHistory('Delete Selection');
    state.selection = null;
    notify('selection-deleted');
  }

  function copySelection() {
    const sel = state.selection;
    if (!sel || !sel.canvas) return false;
    const clipCanvas = createOffscreenCanvas(sel.w, sel.h);
    clipCanvas.getContext('2d').drawImage(sel.canvas, 0, 0, sel.w, sel.h);
    state.clipboard = {
      canvas: clipCanvas,
      w: sel.w,
      h: sel.h
    };
    notify('clipboard-changed');
    return true;
  }

  function pasteSelection(targetX, targetY) {
    if (!state.clipboard || !state.clipboard.canvas) return false;
    if (state.selection) {
      commitSelection();
    }
    pushHistory('Paste Selection');
    const cb = state.clipboard;
    const pasteCanvas = createOffscreenCanvas(cb.w, cb.h);
    pasteCanvas.getContext('2d').drawImage(cb.canvas, 0, 0, cb.w, cb.h);

    const px = (targetX !== undefined) ? targetX : clamp(Math.round((STAGE_W - cb.w) * 0.5), 20, STAGE_W - cb.w - 20);
    const py = (targetY !== undefined) ? targetY : clamp(Math.round((STAGE_H - cb.h) * 0.5), 20, STAGE_H - cb.h - 20);

    const target = getActiveDrawTarget();
    state.selection = {
      canvas: pasteCanvas,
      x: Math.max(0, px),
      y: Math.max(0, py),
      w: cb.w,
      h: cb.h,
      rotation: 0,
      isBackdrop: target ? target.isBackdrop : false,
      partId: (target && target.part) ? target.part.id : null
    };
    notify('selection-created');
    return true;
  }

  function trySelectShapeAtPoint(target, x, y) {
    const comp = getConnectedComponentBoundsAndMask(target.ctx, x, y, 6);
    if (!comp || comp.w < 2 || comp.h < 2) return false;

    const w = target.canvas.width;
    const h = target.canvas.height;
    const cw = comp.w;
    const ch = comp.h;
    const minX = comp.x;
    const minY = comp.y;
    const visited = comp.visited;

    // Extract isolated connected component pixels
    const cutCanvas = createOffscreenCanvas(cw, ch);
    const cutCtx = cutCanvas.getContext('2d');
    const cutData = cutCtx.createImageData(cw, ch);

    const srcData = target.ctx.getImageData(0, 0, w, h);
    const sData = srcData.data;
    const cData = cutData.data;

    pushHistory('Click Select');

    for (let py = 0; py < ch; py++) {
      const sy = minY + py;
      for (let px = 0; px < cw; px++) {
        const sx = minX + px;
        const sidx = sy * w + sx;
        if (visited[sidx]) {
          const sPix = sidx * 4;
          const cPix = (py * cw + px) * 4;
          cData[cPix] = sData[sPix];
          cData[cPix + 1] = sData[sPix + 1];
          cData[cPix + 2] = sData[sPix + 2];
          cData[cPix + 3] = sData[sPix + 3];

          // Erase from source layer (lift up as selection)
          sData[sPix + 3] = 0;
        }
      }
    }

    cutCtx.putImageData(cutData, 0, 0);
    target.ctx.putImageData(srcData, 0, 0);
    if (target.part) markPartDirty(target.part);

    const tight = getCanvasContentBounds(cutCanvas, 4);
    if (!tight) return false;

    const selCanvas = createOffscreenCanvas(tight.w, tight.h);
    selCanvas.getContext('2d').drawImage(cutCanvas, tight.x, tight.y, tight.w, tight.h, 0, 0, tight.w, tight.h);

    state.selection = {
      canvas: selCanvas,
      x: minX + tight.x,
      y: minY + tight.y,
      w: tight.w,
      h: tight.h,
      rotation: 0,
      isBackdrop: target.isBackdrop,
      partId: target.part ? target.part.id : null
    };
    notify('selection-created');
    return true;
  }

  function drawPixelLine(ctx, x0, y0, x1, y1, size, color) {
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    ctx.fillStyle = color;
    const half = Math.floor(size * 0.5);
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    while (true) {
      ctx.fillRect(x0 - half, y0 - half, Math.max(1, size), Math.max(1, size));
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  // --------------------------------------------------------------------------
  // Smoothed stroke rendering
  // --------------------------------------------------------------------------
  // The stroke tip is produced by a 1€ filter (see js/smoothing.js) which kills
  // hand tremor without letting the line fall behind the cursor. The resulting
  // anchors are then joined by a centripetal Catmull-Rom spline so the stroke
  // is one continuous curve instead of a chain of straight chords.
  //
  // The tangent at the newest anchor is extrapolated forwards, otherwise the
  // visible tip would trail the cursor by a full sample.
  function drawSplineSegment(ctx, smoother) {
    const pts = smoother.pts;
    const n = pts.length;
    if (n < 2) return;

    const p2 = pts[n - 1];
    const p1 = pts[n - 2];
    const p0 = n >= 3 ? pts[n - 3] : p1;
    const p3 = { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };

    const c = catmullRomToBezier(p0, p1, p2, p3);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.bezierCurveTo(c.c1x, c.c1y, c.c2x, c.c2y, p2.x, p2.y);
    ctx.stroke();
  }

  // Build the per-stroke smoother, honouring the live slider value.
  function makeSmoother(x, y, t) {
    const sm = new StrokeSmoother((state.smoothingStrength ?? 75) / 100);
    sm.reset(x, y, t);
    return sm;
  }

  // Pointer samples for this event (coalesced frames included) in stage space.
  function samplesFor(samples, x, y) {
    if (samples && samples.length) return samples;
    return [{ x, y, t: performance.now() }];
  }

  function renderShapePreview(tool, x0, y0, x1, y1, shiftKey, strokeColor, fillColor) {
    previewCtx.clearRect(0, 0, STAGE_W, STAGE_H);
    previewCtx.save();
    previewCtx.lineWidth = Math.max(1, state.brushSize);
    previewCtx.lineCap = 'round';
    previewCtx.lineJoin = 'round';
    previewCtx.strokeStyle = strokeColor;
    previewCtx.fillStyle = state.shapeFillMode === 'fill' ? strokeColor : fillColor;

    const doFill = state.shapeFillMode === 'fill' || state.shapeFillMode === 'both';
    const doStroke = state.shapeFillMode === 'outline' || state.shapeFillMode === 'both';

    if (tool === 'line') {
      let ex = x1, ey = y1;
      if (shiftKey) {
        const ang = Math.atan2(y1 - y0, x1 - x0);
        const snapAng = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
        const d = dist(x0, y0, x1, y1);
        ex = x0 + Math.cos(snapAng) * d;
        ey = y0 + Math.sin(snapAng) * d;
      }
      previewCtx.beginPath();
      previewCtx.moveTo(x0, y0);
      previewCtx.lineTo(ex, ey);
      previewCtx.stroke();
    } else if (tool === 'rect') {
      let w = x1 - x0;
      let h = y1 - y0;
      if (shiftKey) {
        const s = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * s;
        h = Math.sign(h || 1) * s;
      }
      const rx = w >= 0 ? x0 : x0 + w;
      const ry = h >= 0 ? y0 : y0 + h;
      const rw = Math.abs(w);
      const rh = Math.abs(h);
      previewCtx.beginPath();
      if (previewCtx.roundRect) {
        previewCtx.roundRect(rx, ry, rw, rh, 2);
      } else {
        previewCtx.rect(rx, ry, rw, rh);
      }
      if (doFill) previewCtx.fill();
      if (doStroke) previewCtx.stroke();
    } else if (tool === 'ellipse') {
      let w = x1 - x0;
      let h = y1 - y0;
      if (shiftKey) {
        const s = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * s;
        h = Math.sign(h || 1) * s;
      }
      const cx = x0 + w * 0.5;
      const cy = y0 + h * 0.5;
      previewCtx.beginPath();
      previewCtx.ellipse(cx, cy, Math.max(0.5, Math.abs(w * 0.5)), Math.max(0.5, Math.abs(h * 0.5)), 0, 0, Math.PI * 2);
      if (doFill) previewCtx.fill();
      if (doStroke) previewCtx.stroke();
    } else if (tool === 'star') {
      const cx = (x0 + x1) * 0.5;
      const cy = (y0 + y1) * 0.5;
      const outerR = Math.max(4, dist(x0, y0, x1, y1) * 0.5);
      const innerR = outerR * 0.44;
      previewCtx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? outerR : innerR;
        const a = -Math.PI * 0.5 + (i * Math.PI) / 5;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (i === 0) previewCtx.moveTo(px, py);
        else previewCtx.lineTo(px, py);
      }
      previewCtx.closePath();
      if (doFill) previewCtx.fill();
      if (doStroke) previewCtx.stroke();
    }

    previewCtx.restore();
  }

  function pickColorFromStage(stageCanvas, x, y, isRightButton) {
    const px = clamp(Math.floor(x), 0, STAGE_W - 1);
    const py = clamp(Math.floor(y), 0, STAGE_H - 1);
    const ctx = stageCanvas.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(px, py, 1, 1).data;
    const hex = rgbToHex(d[0], d[1], d[2]);
    if (isRightButton) state.secondaryColor = hex;
    else state.primaryColor = hex;
    notify('color-picked');
  }

  function onPointerDown(x, y, e, stageCanvas, onOpenTextInput) {
    const isRight = e.button === 2;
    const strokeColor = isRight ? state.secondaryColor : state.primaryColor;
    const fillColor = isRight ? state.primaryColor : state.secondaryColor;

    // Alt-click quick eyedropper from any draw tool!
    if (e.altKey || state.tool === 'eyedropper') {
      pickColorFromStage(stageCanvas, x, y, isRight);
      return null;
    }

    const target = getActiveDrawTarget();
    if (!target) return null;

    // Handle active floating selection interaction first
    if (state.selection) {
      const sel = state.selection;
      const corners = [
        { k: 'nw', x: sel.x, y: sel.y },
        { k: 'ne', x: sel.x + sel.w, y: sel.y },
        { k: 'se', x: sel.x + sel.w, y: sel.y + sel.h },
        { k: 'sw', x: sel.x, y: sel.y + sel.h }
      ];
      for (const c of corners) {
        if (dist(x, y, c.x, c.y) <= 10) {
          activeStroke = {
            kind: 'sel-resize',
            corner: c.k,
            origX: sel.x,
            origY: sel.y,
            origW: sel.w,
            origH: sel.h,
            startX: x,
            startY: y
          };
          return { previewCanvas: null };
        }
      }
      if (x >= sel.x && x <= sel.x + sel.w && y >= sel.y && y <= sel.y + sel.h) {
        activeStroke = {
          kind: 'sel-move',
          startX: x,
          startY: y,
          origX: sel.x,
          origY: sel.y
        };
        return { previewCanvas: null };
      }
      // Clicked outside selection -> stamp it down
      commitSelection();
    }

    if (state.tool === 'text') {
      if (onOpenTextInput) onOpenTextInput(x, y, strokeColor);
      return null;
    }

    if (state.tool === 'bucket') {
      pushHistory('Flood Fill');
      smartFloodFill(target.ctx, x, y, strokeColor, state.bucketTolerance);
      if (target.part) markPartDirty(target.part);
      notify('painted');
      return null;
    }

    if (state.tool === 'select' || state.tool === 'lasso') {
      previewCtx.clearRect(0, 0, STAGE_W, STAGE_H);
      activeStroke = {
        kind: state.tool === 'select' ? 'rect-select' : 'lasso',
        x0: x,
        y0: y,
        x1: x,
        y1: y,
        hasDragged: false,
        points: [{ x, y }],
        target
      };
      return { previewCanvas };
    }

    pushHistory(`Paint (${state.tool})`);

    if (state.tool === 'brush') {
      activeStroke = {
        kind: 'brush',
        smoother: makeSmoother(x, y, e && e.timeStamp ? e.timeStamp : performance.now()),
        lastPt: { x, y },
        color: strokeColor,
        size: state.brushSize,
        target
      };
      // Dot on single click
      target.ctx.save();
      target.ctx.fillStyle = strokeColor;
      target.ctx.beginPath();
      target.ctx.arc(x, y, Math.max(0.75, state.brushSize * 0.5), 0, Math.PI * 2);
      target.ctx.fill();
      target.ctx.restore();
      return { previewCanvas: null };
    }

    if (state.tool === 'pencil') {
      const size = Math.max(1, Math.round(state.brushSize * 0.5));
      activeStroke = {
        kind: 'pencil',
        smoother: makeSmoother(x, y, e && e.timeStamp ? e.timeStamp : performance.now()),
        lastX: x,
        lastY: y,
        color: strokeColor,
        size,
        target
      };
      drawPixelLine(target.ctx, x, y, x, y, size, strokeColor);
      return { previewCanvas: null };
    }

    if (state.tool === 'eraser') {
      activeStroke = {
        kind: 'eraser',
        smoother: makeSmoother(x, y, e && e.timeStamp ? e.timeStamp : performance.now()),
        lastX: x,
        lastY: y,
        size: Math.max(4, state.brushSize * 1.4),
        target
      };
      const ctx = target.ctx;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(x, y, activeStroke.size * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return { previewCanvas: null };
    }

    if (state.tool === 'spray') {
      activeStroke = {
        kind: 'spray',
        x,
        y,
        color: strokeColor,
        radius: Math.max(8, state.brushSize * 1.6),
        target
      };
      const emitSpray = () => {
        if (!activeStroke || activeStroke.kind !== 'spray') return;
        const ctx = activeStroke.target.ctx;
        ctx.save();
        ctx.fillStyle = activeStroke.color;
        const density = Math.max(10, Math.round(activeStroke.radius * 1.3));
        for (let i = 0; i < density; i++) {
          const ang = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.random()) * activeStroke.radius;
          const sx = activeStroke.x + Math.cos(ang) * r;
          const sy = activeStroke.y + Math.sin(ang) * r;
          ctx.fillRect(sx, sy, 1.6, 1.6);
        }
        ctx.restore();
        notify('spray-tick');
        sprayTimer = requestAnimationFrame(emitSpray);
      };
      emitSpray();
      return { previewCanvas: null };
    }

    if (['line', 'rect', 'ellipse', 'star'].includes(state.tool)) {
      previewCtx.clearRect(0, 0, STAGE_W, STAGE_H);
      activeStroke = {
        kind: 'shape',
        tool: state.tool,
        x0: x,
        y0: y,
        x1: x,
        y1: y,
        strokeColor,
        fillColor,
        target
      };
      renderShapePreview(state.tool, x, y, x, y, e.shiftKey, strokeColor, fillColor);
      return { previewCanvas };
    }

    return null;
  }

  function onPointerMove(x, y, e, coalesced) {
    if (!activeStroke) return null;

    if (activeStroke.kind === 'sel-move' && state.selection) {
      state.selection.x = activeStroke.origX + (x - activeStroke.startX);
      state.selection.y = activeStroke.origY + (y - activeStroke.startY);
      return { previewCanvas: null };
    }

    if (activeStroke.kind === 'sel-resize' && state.selection) {
      const sel = state.selection;
      const dx = x - activeStroke.startX;
      const dy = y - activeStroke.startY;
      const c = activeStroke.corner;
      if (c.includes('e')) sel.w = Math.max(12, activeStroke.origW + dx);
      if (c.includes('s')) sel.h = Math.max(12, activeStroke.origH + dy);
      if (c.includes('w')) {
        const nw = Math.max(12, activeStroke.origW - dx);
        sel.x = activeStroke.origX + (activeStroke.origW - nw);
        sel.w = nw;
      }
      if (c.includes('n')) {
        const nh = Math.max(12, activeStroke.origH - dy);
        sel.y = activeStroke.origY + (activeStroke.origH - nh);
        sel.h = nh;
      }
      return { previewCanvas: null };
    }

    if (activeStroke.kind === 'brush') {
      const ctx = activeStroke.target.ctx;
      const smooth = !!state.brushSmoothing;
      const samples = samplesFor(coalesced, x, y);

      ctx.save();
      ctx.strokeStyle = activeStroke.color;
      ctx.lineWidth = activeStroke.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (!smooth) {
          // Auto Smooth off: follow the pointer exactly.
          const prev = activeStroke.lastPt;
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(s.x, s.y);
          ctx.stroke();
          activeStroke.lastPt = { x: s.x, y: s.y };
          continue;
        }
        activeStroke.smoother.setStrength((state.smoothingStrength ?? 75) / 100);
        const r = activeStroke.smoother.push(s.x, s.y, s.t);
        if (!r.added) continue;
        drawSplineSegment(ctx, activeStroke.smoother);
        activeStroke.lastPt = { x: r.x, y: r.y };
      }

      ctx.restore();
      return { previewCanvas: null };
    }

    if (activeStroke.kind === 'pencil') {
      const smooth = !!state.brushSmoothing;
      const samples = samplesFor(coalesced, x, y);
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        let px = s.x;
        let py = s.y;
        if (smooth) {
          activeStroke.smoother.setStrength((state.smoothingStrength ?? 75) / 100);
          const r = activeStroke.smoother.push(s.x, s.y, s.t);
          if (!r.added) continue;
          px = r.x;
          py = r.y;
        }
        drawPixelLine(
          activeStroke.target.ctx,
          activeStroke.lastX,
          activeStroke.lastY,
          px,
          py,
          activeStroke.size,
          activeStroke.color
        );
        activeStroke.lastX = px;
        activeStroke.lastY = py;
      }
      return { previewCanvas: null };
    }

    if (activeStroke.kind === 'eraser') {
      const ctx = activeStroke.target.ctx;
      const smooth = !!state.brushSmoothing;
      const samples = samplesFor(coalesced, x, y);

      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = activeStroke.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (!smooth) {
          ctx.beginPath();
          ctx.moveTo(activeStroke.lastX, activeStroke.lastY);
          ctx.lineTo(s.x, s.y);
          ctx.stroke();
          activeStroke.lastX = s.x;
          activeStroke.lastY = s.y;
          continue;
        }
        activeStroke.smoother.setStrength((state.smoothingStrength ?? 75) / 100);
        const r = activeStroke.smoother.push(s.x, s.y, s.t);
        if (!r.added) continue;
        drawSplineSegment(ctx, activeStroke.smoother);
        activeStroke.lastX = r.x;
        activeStroke.lastY = r.y;
      }

      ctx.restore();
      return { previewCanvas: null };
    }

    if (activeStroke.kind === 'spray') {
      activeStroke.x = x;
      activeStroke.y = y;
      return { previewCanvas: null };
    }

    if (activeStroke.kind === 'shape') {
      activeStroke.x1 = x;
      activeStroke.y1 = y;
      renderShapePreview(
        activeStroke.tool,
        activeStroke.x0,
        activeStroke.y0,
        x,
        y,
        e.shiftKey,
        activeStroke.strokeColor,
        activeStroke.fillColor
      );
      return { previewCanvas };
    }

    if (activeStroke.kind === 'rect-select') {
      if (dist(activeStroke.x0, activeStroke.y0, x, y) >= 3) {
        activeStroke.hasDragged = true;
      }
      activeStroke.x1 = x;
      activeStroke.y1 = y;
      const rx = Math.min(activeStroke.x0, activeStroke.x1);
      const ry = Math.min(activeStroke.y0, activeStroke.y1);
      const rw = Math.abs(activeStroke.x1 - activeStroke.x0);
      const rh = Math.abs(activeStroke.y1 - activeStroke.y0);
      previewCtx.clearRect(0, 0, STAGE_W, STAGE_H);
      previewCtx.save();
      previewCtx.strokeStyle = '#ffffff';
      previewCtx.lineWidth = 3;
      previewCtx.strokeRect(rx, ry, rw, rh);
      previewCtx.setLineDash([5, 5]);
      previewCtx.strokeStyle = '#2563eb';
      previewCtx.lineWidth = 1.8;
      previewCtx.strokeRect(rx, ry, rw, rh);
      previewCtx.restore();
      return { previewCanvas };
    }

    if (activeStroke.kind === 'lasso') {
      if (dist(activeStroke.x0, activeStroke.y0, x, y) >= 3) {
        activeStroke.hasDragged = true;
      }
      const pts = activeStroke.points;
      if (dist(pts[pts.length - 1].x, pts[pts.length - 1].y, x, y) >= 3) {
        pts.push({ x, y });
      }
      previewCtx.clearRect(0, 0, STAGE_W, STAGE_H);
      previewCtx.save();
      previewCtx.beginPath();
      pts.forEach((p, i) => (i === 0 ? previewCtx.moveTo(p.x, p.y) : previewCtx.lineTo(p.x, p.y)));
      previewCtx.strokeStyle = '#ffffff';
      previewCtx.lineWidth = 3;
      previewCtx.stroke();
      previewCtx.setLineDash([5, 5]);
      previewCtx.strokeStyle = '#2563eb';
      previewCtx.lineWidth = 1.8;
      previewCtx.stroke();
      previewCtx.restore();
      return { previewCanvas };
    }

    return null;
  }

  function onPointerUp(e, endX, endY) {
    if (sprayTimer) {
      cancelAnimationFrame(sprayTimer);
      sprayTimer = null;
    }
    if (!activeStroke) return;

    const stroke = activeStroke;
    activeStroke = null;

    // Flush the final pointer position so the stroke always ends exactly
    // where the button was released. Only meaningful when the smoother was
    // actually fed during the stroke — with Auto Smooth off the smoother never
    // advanced, and drawing its pending segment would paint a stray chord
    // straight across the drawing.
    if (
      state.brushSmoothing &&
      stroke.smoother &&
      (stroke.kind === 'brush' || stroke.kind === 'eraser')
    ) {
      const last = stroke.smoother.pts[stroke.smoother.pts.length - 1];
      const tx = typeof endX === 'number' ? endX : last ? last.x : null;
      const ty = typeof endY === 'number' ? endY : last ? last.y : null;
      if (tx !== null && ty !== null) {
        if (stroke.smoother.finish(tx, ty)) {
          const ctx = stroke.target.ctx;
          ctx.save();
          if (stroke.kind === 'eraser') ctx.globalCompositeOperation = 'destination-out';
          else ctx.strokeStyle = stroke.color;
          ctx.lineWidth = stroke.size;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          drawSplineSegment(ctx, stroke.smoother);
          ctx.restore();
        }
      }
    }

    if (stroke.kind === 'shape') {
      stroke.target.ctx.drawImage(previewCanvas, 0, 0);
      previewCtx.clearRect(0, 0, STAGE_W, STAGE_H);
      if (stroke.target.part) markPartDirty(stroke.target.part);
      notify('painted');
      return;
    }

    if (stroke.kind === 'rect-select') {
      previewCtx.clearRect(0, 0, STAGE_W, STAGE_H);

      // Single click without dragging: select connected drawn shape/line at click location!
      if (!stroke.hasDragged) {
        if (trySelectShapeAtPoint(stroke.target, stroke.x0, stroke.y0)) {
          return;
        }
      }

      const rx = Math.round(Math.min(stroke.x0, stroke.x1));
      const ry = Math.round(Math.min(stroke.y0, stroke.y1));
      const rw = Math.round(Math.abs(stroke.x1 - stroke.x0));
      const rh = Math.round(Math.abs(stroke.y1 - stroke.y0));

      if (rw < 4 || rh < 4) {
        // Fallback: try click selection if drag was tiny
        trySelectShapeAtPoint(stroke.target, stroke.x0, stroke.y0);
        return;
      }

      const cutCanvas = createOffscreenCanvas(rw, rh);
      const cutCtx = cutCanvas.getContext('2d');
      cutCtx.drawImage(stroke.target.canvas, rx, ry, rw, rh, 0, 0, rw, rh);

      const tight = getCanvasContentBounds(cutCanvas, 4);
      if (!tight) return;

      pushHistory('Rect Select');
      const srcCtx = stroke.target.ctx;
      srcCtx.save();
      srcCtx.clearRect(rx, ry, rw, rh);
      srcCtx.restore();
      if (stroke.target.part) markPartDirty(stroke.target.part);

      const selCanvas = createOffscreenCanvas(tight.w, tight.h);
      selCanvas.getContext('2d').drawImage(cutCanvas, tight.x, tight.y, tight.w, tight.h, 0, 0, tight.w, tight.h);

      state.selection = {
        canvas: selCanvas,
        x: rx + tight.x,
        y: ry + tight.y,
        w: tight.w,
        h: tight.h,
        rotation: 0,
        isBackdrop: stroke.target.isBackdrop,
        partId: stroke.target.part ? stroke.target.part.id : null
      };
      notify('selection-created');
      return;
    }

    if (stroke.kind === 'lasso') {
      previewCtx.clearRect(0, 0, STAGE_W, STAGE_H);
      const pts = stroke.points;

      if (!stroke.hasDragged || pts.length < 3) {
        trySelectShapeAtPoint(stroke.target, stroke.x0, stroke.y0);
        return;
      }

      let minX = STAGE_W, minY = STAGE_H, maxX = 0, maxY = 0;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      minX = clamp(Math.floor(minX), 0, STAGE_W - 1);
      minY = clamp(Math.floor(minY), 0, STAGE_H - 1);
      maxX = clamp(Math.ceil(maxX), 0, STAGE_W);
      maxY = clamp(Math.ceil(maxY), 0, STAGE_H);
      const w = maxX - minX;
      const h = maxY - minY;
      if (w < 6 || h < 6) return;

      // Extract lassoed pixels onto an offscreen canvas
      const cutFull = createOffscreenCanvas(STAGE_W, STAGE_H);
      const cutFullCtx = cutFull.getContext('2d');
      cutFullCtx.save();
      cutFullCtx.beginPath();
      pts.forEach((p, i) => (i === 0 ? cutFullCtx.moveTo(p.x, p.y) : cutFullCtx.lineTo(p.x, p.y)));
      cutFullCtx.closePath();
      cutFullCtx.clip();
      cutFullCtx.drawImage(stroke.target.canvas, 0, 0);
      cutFullCtx.restore();

      const tight = getCanvasContentBounds(cutFull, 4);
      if (!tight) return; // Nothing painted inside lasso

      pushHistory('Lasso Cut');
      // Erase lassoed pixels from source layer
      const srcCtx = stroke.target.ctx;
      srcCtx.save();
      srcCtx.globalCompositeOperation = 'destination-out';
      srcCtx.beginPath();
      pts.forEach((p, i) => (i === 0 ? srcCtx.moveTo(p.x, p.y) : srcCtx.lineTo(p.x, p.y)));
      srcCtx.closePath();
      srcCtx.fill();
      srcCtx.restore();
      if (stroke.target.part) markPartDirty(stroke.target.part);

      const selCanvas = createOffscreenCanvas(tight.w, tight.h);
      selCanvas.getContext('2d').drawImage(cutFull, tight.x, tight.y, tight.w, tight.h, 0, 0, tight.w, tight.h);

      state.selection = {
        canvas: selCanvas,
        x: tight.x,
        y: tight.y,
        w: tight.w,
        h: tight.h,
        rotation: 0,
        isBackdrop: stroke.target.isBackdrop,
        partId: stroke.target.part ? stroke.target.part.id : null
      };
      notify('selection-created');
      return;
    }

    if (stroke.target && stroke.target.part) {
      markPartDirty(stroke.target.part);
    }
    notify('painted');
  }

  function stampText(text, x, y, color) {
    if (!text || !text.trim()) return;
    const target = getActiveDrawTarget();
    if (!target) return;
    pushHistory('Add Text');
    const ctx = target.ctx;
    ctx.save();
    ctx.font = `700 ${state.fontSize}px "Trebuchet MS", "Segoe UI", sans-serif`;
    ctx.fillStyle = color || state.primaryColor;
    ctx.textBaseline = 'top';
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      ctx.fillText(line, x, y + i * (state.fontSize * 1.2));
    });
    ctx.restore();
    if (target.part) markPartDirty(target.part);
    notify('painted');
  }

  global.WPPaintTools = {
    previewCanvas,
    commitSelection,
    popSelectionToNewPart,
    deleteSelectionPixels,
    copySelection,
    pasteSelection,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    stampText
  };
})(window);
