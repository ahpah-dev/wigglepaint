// ============================================================================
// WigglePaint — 60fps Stage Compositor, Seam-Free Mesh Warp & Vector Overlays
// ============================================================================
(function (global) {
  'use strict';

  const { STAGE_W, STAGE_H, state, createOffscreenCanvas, createDefaultPartTransform } = global.WPState;
  const { solveForwardKinematics, ensurePartMesh, deformPartVertices } = global.WPRigging;

  const onionScratch = createOffscreenCanvas(STAGE_W, STAGE_H);
  const onionCtx = onionScratch.getContext('2d');

  function isSkeletonAtRest(fk) {
    for (const bt of fk.boneTransforms.values()) {
      if (
        Math.abs(bt.dPhi) > 1e-4 ||
        Math.abs(bt.ax - bt.restAx) > 0.05 ||
        Math.abs(bt.ay - bt.restAy) > 0.05 ||
        Math.abs(bt.scale - 1) > 1e-3
      ) {
        return false;
      }
    }
    return true;
  }

  // Seam-free affine triangle rasterizer
  function drawDeformedMesh(ctx, srcCanvas, mesh) {
    const verts = mesh.vertices;
    const tris = mesh.triangles;

    for (let i = 0; i < tris.length; i++) {
      const tri = tris[i];
      const v0 = verts[tri.a];
      const v1 = verts[tri.b];
      const v2 = verts[tri.c];

      const u0 = v0.u, w0 = v0.v;
      const u1 = v1.u, w1 = v1.v;
      const u2 = v2.u, w2 = v2.v;

      const x0 = v0.x, y0 = v0.y;
      const x1 = v1.x, y1 = v1.y;
      const x2 = v2.x, y2 = v2.y;

      const du1 = u1 - u0, dw1 = w1 - w0;
      const du2 = u2 - u0, dw2 = w2 - w0;
      const det = du1 * dw2 - du2 * dw1;
      if (Math.abs(det) < 1e-5) continue;

      const invDet = 1 / det;
      const dx1 = x1 - x0, dy1 = y1 - y0;
      const dx2 = x2 - x0, dy2 = y2 - y0;

      const a = (dx1 * dw2 - dx2 * dw1) * invDet;
      const c = (du1 * dx2 - du2 * dx1) * invDet;
      const e = x0 - a * u0 - c * w0;

      const b = (dy1 * dw2 - dy2 * dw1) * invDet;
      const d = (du1 * dy2 - du2 * dy1) * invDet;
      const f = y0 - b * u0 - d * w0;

      // Expand clip triangle slightly (0.8px) outward from centroid to eliminate Canvas2D AA hairline seams
      const mx = (x0 + x1 + x2) * 0.333333;
      const my = (y0 + y1 + y2) * 0.333333;

      let ex0 = x0 - mx, ey0 = y0 - my;
      const l0 = Math.sqrt(ex0 * ex0 + ey0 * ey0) || 1;
      ex0 = x0 + (ex0 / l0) * 0.85;
      ey0 = y0 + (ey0 / l0) * 0.85;

      let ex1 = x1 - mx, ey1 = y1 - my;
      const l1 = Math.sqrt(ex1 * ex1 + ey1 * ey1) || 1;
      ex1 = x1 + (ex1 / l1) * 0.85;
      ey1 = y1 + (ey1 / l1) * 0.85;

      let ex2 = x2 - mx, ey2 = y2 - my;
      const l2 = Math.sqrt(ex2 * ex2 + ey2 * ey2) || 1;
      ex2 = x2 + (ex2 / l2) * 0.85;
      ey2 = y2 + (ey2 / l2) * 0.85;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(ex0, ey0);
      ctx.lineTo(ex1, ey1);
      ctx.lineTo(ex2, ey2);
      ctx.closePath();
      ctx.clip();

      ctx.transform(a, b, c, d, e, f);
      ctx.drawImage(srcCanvas, tri.sx, tri.sy, tri.sw, tri.sh, tri.sx, tri.sy, tri.sw, tri.sh);
      ctx.restore();
    }
  }

  // Render full scene or character-only silhouette for any Pose into any 2D context
  function renderPoseToContext(ctx, pose, options = {}) {
    const charactersOnly = !!options.charactersOnly;
    const useRestSpace = !!options.useRestSpace;

    if (!charactersOnly) {
      ctx.save();
      ctx.fillStyle = state.stageBgColor || '#ffffff';
      ctx.fillRect(0, 0, STAGE_W, STAGE_H);
      if (state.backdropVisible) {
        ctx.drawImage(state.backdropCanvas, 0, 0);
      }
      ctx.restore();
    } else {
      ctx.clearRect(0, 0, STAGE_W, STAGE_H);
    }

    const fk = useRestSpace ? null : solveForwardKinematics(pose);
    const skeletonRest = useRestSpace || !fk || isSkeletonAtRest(fk);

    for (const part of state.parts) {
      if (!part.visible) continue;

      ctx.save();
      if (!useRestSpace && pose && pose.partTransforms && pose.partTransforms[part.id]) {
        const pt = pose.partTransforms[part.id];
        ctx.globalAlpha *= pt.opacity !== undefined ? pt.opacity : 1;
        const cx = part.bounds ? part.bounds.cx : STAGE_W * 0.5;
        const cy = part.bounds ? part.bounds.cy : STAGE_H * 0.5;
        if (pt.dx || pt.dy || pt.rotation || pt.scaleX !== 1 || pt.scaleY !== 1) {
          ctx.translate(cx + (pt.dx || 0), cy + (pt.dy || 0));
          ctx.rotate(pt.rotation || 0);
          ctx.scale(pt.scaleX ?? 1, pt.scaleY ?? 1);
          ctx.translate(-cx, -cy);
        }
      }

      if (useRestSpace || state.bones.length === 0) {
        ctx.drawImage(part.canvas, 0, 0);
      } else {
        const mesh = ensurePartMesh(part);
        if (!mesh.bound || skeletonRest) {
          ctx.drawImage(part.canvas, 0, 0);
        } else if (mesh.mode === 'rigid') {
          const bt = fk.boneTransforms.get(mesh.rigidBoneId);
          if (bt) {
            ctx.translate(bt.ax, bt.ay);
            ctx.rotate(bt.dPhi);
            ctx.scale(bt.scale, bt.scale);
            ctx.translate(-bt.restAx, -bt.restAy);
          }
          ctx.drawImage(part.canvas, 0, 0);
        } else {
          deformPartVertices(mesh, fk);
          drawDeformedMesh(ctx, part.canvas, mesh);
        }
      }

      ctx.restore();
    }
  }

  function renderTintedGhost(targetCtx, pose, tintHex, alpha) {
    renderPoseToContext(onionCtx, pose, { charactersOnly: true });
    onionCtx.save();
    onionCtx.globalCompositeOperation = 'source-atop';
    onionCtx.fillStyle = tintHex;
    onionCtx.fillRect(0, 0, STAGE_W, STAGE_H);
    onionCtx.restore();

    targetCtx.save();
    targetCtx.globalAlpha = alpha;
    targetCtx.drawImage(onionScratch, 0, 0);
    targetCtx.restore();
  }

  // Compute Transform Gizmo Box geometry in stage coordinates for a Part & Pose
  function getPartTransformGizmo(part, pose) {
    if (!part) return null;
    const b = part.bounds || { x: STAGE_W * 0.35, y: STAGE_H * 0.3, w: STAGE_W * 0.3, h: STAGE_H * 0.4, cx: STAGE_W * 0.5, cy: STAGE_H * 0.5 };
    const pad = 10;
    const halfW = Math.max(24, b.w * 0.5 + pad);
    const halfH = Math.max(24, b.h * 0.5 + pad);

    const def = createDefaultPartTransform();
    const pt = (pose && pose.partTransforms && pose.partTransforms[part.id]) || def;
    const cx = b.cx + (pt.dx || 0);
    const cy = b.cy + (pt.dy || 0);
    const rot = pt.rotation || 0;
    const sx = pt.scaleX ?? 1;
    const sy = pt.scaleY ?? 1;

    const cos = Math.cos(rot);
    const sin = Math.sin(rot);

    function toWorld(lx, ly) {
      const rx = lx * sx;
      const ry = ly * sy;
      return {
        x: cx + rx * cos - ry * sin,
        y: cy + rx * sin + ry * cos
      };
    }

    const nw = toWorld(-halfW, -halfH);
    const ne = toWorld(halfW, -halfH);
    const se = toWorld(halfW, halfH);
    const sw = toWorld(-halfW, halfH);
    const n = toWorld(0, -halfH);
    const s = toWorld(0, halfH);
    const e = toWorld(halfW, 0);
    const w = toWorld(-halfW, 0);

    // Rotation lollipop 28px out from top edge normal
    const topSign = sy >= 0 ? -1 : 1;
    const rotHandle = {
      x: n.x + (-sin * topSign) * -28,
      y: n.y + (cos * topSign) * -28
    };
    // Simpler exact normal along local -Y direction:
    const upDirX = sin;
    const upDirY = -cos;
    const signY = sy >= 0 ? 1 : -1;
    rotHandle.x = n.x + upDirX * 28 * signY;
    rotHandle.y = n.y + upDirY * 28 * signY;

    return {
      cx, cy, rot, sx, sy, halfW, halfH,
      corners: [nw, ne, se, sw],
      handles: { nw, ne, se, sw, n, s, e, w, rotate: rotHandle }
    };
  }

  // Render full live Stage + Overlay
  function renderStageAndOverlay(stageCtx, overlayCtx, uiHintState = {}) {
    overlayCtx.clearRect(0, 0, STAGE_W, STAGE_H);

    const isDraw = state.mode === 'draw';
    const isRig = state.mode === 'rig';
    const isAnimate = state.mode === 'animate';

    const currentPose = isAnimate
      ? (state.scrubPreviewPose || state.poses[state.activePoseIndex] || null)
      : null;

    if (isDraw || isRig) {
      // Render crisp Rest Space
      renderPoseToContext(stageCtx, null, { useRestSpace: true });

      // Composite live stroke/shape preview on top of active layer if drawing
      if (isDraw && uiHintState.previewCanvas) {
        stageCtx.drawImage(uiHintState.previewCanvas, 0, 0);
      }

      // Draw floating selection if active in Draw mode
      if (isDraw && state.selection && state.selection.canvas) {
        const sel = state.selection;
        stageCtx.save();
        stageCtx.translate(sel.x + sel.w * 0.5, sel.y + sel.h * 0.5);
        stageCtx.rotate(sel.rotation || 0);
        stageCtx.drawImage(sel.canvas, -sel.w * 0.5, -sel.h * 0.5, sel.w, sel.h);
        stageCtx.restore();

        drawSelectionMarquee(overlayCtx, sel);
      }
    } else {
      // Animate Mode: Background -> Optional Onion Skins -> Active/Tweened Pose
      stageCtx.save();
      stageCtx.fillStyle = state.stageBgColor || '#ffffff';
      stageCtx.fillRect(0, 0, STAGE_W, STAGE_H);
      if (state.backdropVisible) {
        stageCtx.drawImage(state.backdropCanvas, 0, 0);
      }
      stageCtx.restore();

      if (
        state.onionSkin &&
        !state.isPlaying &&
        !state.scrubPreviewPose &&
        state.poses.length > 1
      ) {
        const prevIdx = (state.activePoseIndex - 1 + state.poses.length) % state.poses.length;
        renderTintedGhost(stageCtx, state.poses[prevIdx], '#f43f5e', 0.22);
        if (state.poses.length > 2) {
          const nextIdx = (state.activePoseIndex + 1) % state.poses.length;
          renderTintedGhost(stageCtx, state.poses[nextIdx], '#06b6d4', 0.17);
        }
      }

      // Render active/tweened characters onto stage
      const charCanvas = uiHintState.charScratch || createOffscreenCanvas(STAGE_W, STAGE_H);
      uiHintState.charScratch = charCanvas;
      const charCtx = charCanvas.getContext('2d');
      renderPoseToContext(charCtx, currentPose, { charactersOnly: true });
      stageCtx.drawImage(charCanvas, 0, 0);
    }

    // ------------------------------------------------------------------------
    // Vector Overlays (Cursors, Bones, Joints, Transform Gizmo)
    // ------------------------------------------------------------------------
    if (isDraw && uiHintState.cursorPos) {
      drawBrushCursor(overlayCtx, uiHintState.cursorPos);
    }

    if (isRig) {
      if (state.showMeshWireframe) {
        for (const p of state.parts) {
          if (!p.visible) continue;
          const m = ensurePartMesh(p);
          if (m.bound && m.mode === 'bendy') {
            drawMeshWireframe(overlayCtx, m, true);
          }
        }
      }
      drawSkeletonOverlay(overlayCtx, null, uiHintState);
    }

    if (isAnimate && !state.isPlaying) {
      const showTransform = state.animTool === 'transform' || state.bones.length === 0;
      if (showTransform) {
        const activePart = state.parts.find((p) => p.id === state.activePartId) || state.parts[0];
        if (activePart && activePart.visible) {
          drawTransformGizmo(overlayCtx, activePart, currentPose, uiHintState);
        }
      }
      if (state.bones.length > 0 && state.animTool !== 'transform') {
        drawSkeletonOverlay(overlayCtx, currentPose, uiHintState);
      }
    }
  }

  function drawBrushCursor(ctx, pos) {
    const tool = state.tool;
    if (!['brush', 'pencil', 'eraser', 'spray'].includes(tool)) return;
    const r = tool === 'spray' ? Math.max(8, state.brushSize * 1.6) : Math.max(2, state.brushSize * 0.5);
    ctx.save();
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(15,23,42,0.85)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  function drawSelectionMarquee(ctx, sel) {
    ctx.save();
    ctx.translate(sel.x + sel.w * 0.5, sel.y + sel.h * 0.5);
    ctx.rotate(sel.rotation || 0);
    const hw = sel.w * 0.5;
    const hh = sel.h * 0.5;

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(-hw, -hh, sel.w, sel.h);

    ctx.setLineDash([5, 5]);
    ctx.lineDashOffset = -((performance.now() * 0.03) % 10);
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1.8;
    ctx.strokeRect(-hw, -hh, sel.w, sel.h);
    ctx.setLineDash([]);

    // Corner handles
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    for (const [cx, cy] of corners) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawMeshWireframe(ctx, mesh, restSpace) {
    ctx.save();
    ctx.strokeStyle = 'rgba(124, 58, 237, 0.25)';
    ctx.lineWidth = 1;
    const verts = mesh.vertices;
    ctx.beginPath();
    for (const t of mesh.triangles) {
      const a = verts[t.a], b = verts[t.b], c = verts[t.c];
      const ax = restSpace ? a.u : a.x, ay = restSpace ? a.v : a.y;
      const bx = restSpace ? b.u : b.x, by = restSpace ? b.v : b.y;
      const cx = restSpace ? c.u : c.x, cy = restSpace ? c.v : c.y;
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineTo(cx, cy);
      ctx.closePath();
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawBoneShape(ctx, ax, ay, bx, by, isSelected, isHovered, accentColor) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const width = Math.min(11, Math.max(5, len * 0.14));
    const shoulder = Math.min(len * 0.22, 14);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + ux * shoulder + nx * width, ay + uy * shoulder + ny * width);
    ctx.lineTo(bx, by);
    ctx.lineTo(ax + ux * shoulder - nx * width, ay + uy * shoulder - ny * width);
    ctx.closePath();

    // Outer white contrast halo
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.lineWidth = 4.5;
    ctx.stroke();

    ctx.fillStyle = isSelected
      ? 'rgba(249, 115, 22, 0.55)'
      : isHovered
        ? 'rgba(56, 189, 248, 0.52)'
        : accentColor;
    ctx.fill();

    ctx.strokeStyle = isSelected ? '#c2410c' : isHovered ? '#0284c7' : '#312e81';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.restore();
  }

  function drawSkeletonOverlay(ctx, pose, uiHintState = {}) {
    const fk = solveForwardKinematics(pose);
    const isRig = state.mode === 'rig';
    const accentFill = isRig ? 'rgba(124, 58, 237, 0.38)' : 'rgba(234, 88, 12, 0.34)';

    // Draw bones
    for (const b of state.bones) {
      const bt = fk.boneTransforms.get(b.id);
      if (!bt) continue;
      const isSel = state.selectedBoneId === b.id;
      const isHov = uiHintState.hoverBoneId === b.id;
      drawBoneShape(ctx, bt.ax, bt.ay, bt.bx, bt.by, isSel, isHov, accentFill);
    }

    // Live bone creation preview in Rig Mode
    if (isRig && uiHintState.boneDragPreview) {
      const { x1, y1, x2, y2 } = uiHintState.boneDragPreview;
      drawBoneShape(ctx, x1, y1, x2, y2, false, true, 'rgba(16, 185, 129, 0.45)');
      ctx.save();
      ctx.beginPath();
      ctx.arc(x2, y2, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#10b981';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.restore();
    }

    // Draw joints
    for (const j of state.joints) {
      const pos = fk.jointPositions.get(j.id) || { x: j.x, y: j.y, isRoot: true };
      const isHov = uiHintState.hoverJointId === j.id;
      const isSnap = uiHintState.snapJointId === j.id;
      const isSel = state.selectedJointId === j.id;

      ctx.save();

      // Snap magnetic halo
      if (isSnap || isHov) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, isSnap ? 16 : 13, 0, Math.PI * 2);
        ctx.fillStyle = isSnap ? 'rgba(16, 185, 129, 0.28)' : 'rgba(59, 130, 246, 0.24)';
        ctx.fill();
      }

      if (pos.isRoot) {
        // Diamond badge for Root Joint (draggable whole-body mover!)
        const r = isHov ? 10 : 8.5;
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y - r);
        ctx.lineTo(pos.x + r, pos.y);
        ctx.lineTo(pos.x, pos.y + r);
        ctx.lineTo(pos.x - r, pos.y);
        ctx.closePath();
        ctx.fillStyle = '#f59e0b';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fill();
        ctx.strokeStyle = '#78350f';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        const r = isHov || isSel ? 7.5 : 6;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
        ctx.fillStyle = j.pinned ? '#ef4444' : isSnap ? '#10b981' : isRig ? '#8b5cf6' : '#fb923c';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fill();
        ctx.strokeStyle = '#1e1b4b';
        ctx.lineWidth = 1.4;
        ctx.stroke();

        if (j.pinned) {
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  function drawTransformGizmo(ctx, part, pose, uiHintState = {}) {
    const g = getPartTransformGizmo(part, pose);
    if (!g) return;
    const [nw, ne, se, sw] = g.corners;

    ctx.save();
    // Bounding quad
    ctx.beginPath();
    ctx.moveTo(nw.x, nw.y);
    ctx.lineTo(ne.x, ne.y);
    ctx.lineTo(se.x, se.y);
    ctx.lineTo(sw.x, sw.y);
    ctx.closePath();

    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = '#ea580c';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Rotate stem + handle
    ctx.beginPath();
    ctx.moveTo(g.handles.n.x, g.handles.n.y);
    ctx.lineTo(g.handles.rotate.x, g.handles.rotate.y);
    ctx.strokeStyle = '#ea580c';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(g.handles.rotate.x, g.handles.rotate.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = uiHintState.hoverGizmoHandle === 'rotate' ? '#fbbf24' : '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = '#ea580c';
    ctx.stroke();

    // Corner handles (Scale) & Edge handles (Squash & Stretch)
    for (const key of ['nw', 'ne', 'se', 'sw', 'n', 's', 'e', 'w']) {
      const p = g.handles[key];
      const isCorner = key.length === 2;
      const hov = uiHintState.hoverGizmoHandle === key;
      ctx.beginPath();
      ctx.arc(p.x, p.y, isCorner ? (hov ? 7 : 5.8) : (hov ? 6 : 4.8), 0, Math.PI * 2);
      ctx.fillStyle = hov ? '#fb923c' : isCorner ? '#ffffff' : '#fed7aa';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#c2410c';
      ctx.stroke();
    }

    // Center pivot crosshair
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ea580c';
    ctx.fill();
    ctx.restore();
  }

  global.WPRenderer = {
    renderPoseToContext,
    getPartTransformGizmo,
    renderStageAndOverlay
  };
})(window);
