// ============================================================================
// WigglePaint — 60fps Stage Compositor, Zero-Warp Puppet Renderer & Overlays
// ============================================================================
(function (global) {
  'use strict';

  const { STAGE_W, STAGE_H, state, createOffscreenCanvas, createDefaultPartTransform } = global.WPState;
  const { solveForwardKinematics, ensurePartMesh } = global.WPRigging;

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

  // Render Zero-Warp Rigid Puppet Pieces (sorted back-to-front with seamless joint caps!)
  function drawPuppetPieces(ctx, pieces, fk) {
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      const bt = fk.boneTransforms.get(piece.boneId);
      if (!bt) {
        ctx.drawImage(piece.canvas, piece.offsetX, piece.offsetY);
        continue;
      }
      ctx.save();
      ctx.translate(bt.ax, bt.ay);
      if (Math.abs(bt.scale - 1) > 1e-3) {
        ctx.rotate(bt.worldAngle);
        ctx.scale(bt.scale, 1);
        ctx.rotate(-bt.restWorldAngle);
      } else {
        ctx.rotate(bt.dPhi);
      }
      ctx.translate(-bt.restAx, -bt.restAy);
      ctx.drawImage(piece.canvas, piece.offsetX, piece.offsetY);
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
            if (Math.abs(bt.scale - 1) > 1e-3) {
              ctx.rotate(bt.worldAngle);
              ctx.scale(bt.scale, 1);
              ctx.rotate(-bt.restWorldAngle);
            } else {
              ctx.rotate(bt.dPhi);
            }
            ctx.translate(-bt.restAx, -bt.restAy);
          }
          ctx.drawImage(part.canvas, 0, 0);
        } else if (mesh.mode === 'puppet' && mesh.pieces) {
          drawPuppetPieces(ctx, mesh.pieces, fk);
        } else {
          ctx.drawImage(part.canvas, 0, 0);
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

    const upDirX = sin;
    const upDirY = -cos;
    const signY = sy >= 0 ? 1 : -1;
    const rotHandle = {
      x: n.x + upDirX * 28 * signY,
      y: n.y + upDirY * 28 * signY
    };

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
      renderPoseToContext(stageCtx, null, { useRestSpace: true });

      if (isDraw && uiHintState.previewCanvas) {
        stageCtx.drawImage(uiHintState.previewCanvas, 0, 0);
      }

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

      const charCanvas = uiHintState.charScratch || createOffscreenCanvas(STAGE_W, STAGE_H);
      uiHintState.charScratch = charCanvas;
      const charCtx = charCanvas.getContext('2d');
      renderPoseToContext(charCtx, currentPose, { charactersOnly: true });
      stageCtx.drawImage(charCanvas, 0, 0);
    }

    // Vector Overlays
    if (isDraw && uiHintState.cursorPos) {
      drawBrushCursor(overlayCtx, uiHintState.cursorPos);
    }

    if (isRig) {
      if (state.showMeshWireframe) {
        for (const p of state.parts) {
          if (!p.visible) continue;
          const m = ensurePartMesh(p);
          if (m.bound && m.zoneOverlayCanvas) {
            overlayCtx.drawImage(m.zoneOverlayCanvas, 0, 0);
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

    for (const b of state.bones) {
      const bt = fk.boneTransforms.get(b.id);
      if (!bt) continue;
      const isSel = state.selectedBoneId === b.id;
      const isHov = uiHintState.hoverBoneId === b.id;
      drawBoneShape(ctx, bt.ax, bt.ay, bt.bx, bt.by, isSel, isHov, accentFill);
    }

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

    for (const j of state.joints) {
      const pos = fk.jointPositions.get(j.id) || { x: j.x, y: j.y, isRoot: true };
      const isHov = uiHintState.hoverJointId === j.id;
      const isSnap = uiHintState.snapJointId === j.id;
      const isSel = state.selectedJointId === j.id;

      ctx.save();
      if (isSnap || isHov) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, isSnap ? 16 : 13, 0, Math.PI * 2);
        ctx.fillStyle = isSnap ? 'rgba(16, 185, 129, 0.28)' : 'rgba(59, 130, 246, 0.24)';
        ctx.fill();
      }

      if (pos.isRoot) {
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
