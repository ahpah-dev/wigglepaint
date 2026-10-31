// ============================================================================
// WigglePaint — Main Studio Controller, Interactions, Timeline & Export
// ============================================================================
(function () {
  'use strict';

  const { clamp, dist, shortAngleDiff } = window.WPUtils;
  const {
    STAGE_W,
    STAGE_H,
    state,
    createOffscreenCanvas,
    createPart,
    clonePose,
    getActivePart,
    getActivePose,
    ensurePartTransform,
    markPartDirty,
    markAllMeshesDirty,
    recomputeRestSkeleton,
    pushHistory,
    undo,
    redo,
    resetProject,
    serializeProject,
    deserializeProject,
    onChange,
    notify
  } = window.WPState;

  const {
    solveForwardKinematics,
    findJointAt,
    findBoneAt,
    addBone,
    deleteBone,
    deleteJoint,
    stampSkeleton,
    solveIKDrag,
    rotateBoneFK,
    ensurePartMesh
  } = window.WPRigging;

  const {
    getTotalDuration,
    evaluatePoseAtTime,
    getPoseStartTime,
    resetPoseToRest,
    applyMagicMotion
  } = window.WPTweening;

  const PaintTools = window.WPPaintTools;
  const { renderPoseToContext, getPartTransformGizmo, renderStageAndOverlay } = window.WPRenderer;
  const Templates = window.WPTemplates;

  // Curated 28-color vibrant MS-Paint Modern Palette
  const PALETTE_COLORS = [
    '#1e2430', '#ffffff', '#64748b', '#94a3b8', '#ef4444', '#f97316', '#facc15',
    '#22c55e', '#10b981', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899',
    '#7f1d1d', '#9a3412', '#a16207', '#15803d', '#0f766e', '#1d4ed8', '#581c87',
    '#fecdd3', '#fed7aa', '#fef08a', '#bbf7d0', '#bae6fd', '#e9d5ff', '#fbcfe8'
  ];

  const EASING_META = {
    smooth: { icon: '🌊', label: 'Smooth' },
    springy: { icon: '🌀', label: 'Springy' },
    bouncy: { icon: '🏀', label: 'Bouncy' },
    elastic: { icon: '🎸', label: 'Elastic' },
    linear: { icon: '📏', label: 'Linear' },
    hold: { icon: '⏸️', label: 'Hold' }
  };

  // DOM Elements
  const stageCanvas = document.getElementById('stage-canvas');
  const stageCtx = stageCanvas.getContext('2d', { willReadFrequently: true });
  const overlayCanvas = document.getElementById('overlay-canvas');
  const overlayCtx = overlayCanvas.getContext('2d');
  const stageViewport = document.getElementById('stage-viewport');
  const stageFrame = document.getElementById('stage-frame');
  const coachBanner = document.getElementById('coach-banner');
  const textOverlay = document.getElementById('canvas-text-input');
  const toastEl = document.getElementById('toast');

  // Interactive transient UI hint state for overlays
  const uiHintState = {
    cursorPos: null,
    previewCanvas: null,
    hoverJointId: null,
    hoverBoneId: null,
    snapJointId: null,
    boneDragPreview: null,
    hoverGizmoHandle: null,
    charScratch: null
  };

  let activeInteraction = null;
  let pendingTextPos = null;
  let activePopoverPoseIdx = null;
  let toastTimeout = null;
  let thumbTimer = null;

  function showToast(msg, ms = 2400) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toastEl.classList.add('hidden'), ms);
  }

  // --------------------------------------------------------------------------
  // Responsive Stage Fitting & Coordinate Mapping
  // --------------------------------------------------------------------------
  function fitStageToViewport() {
    const rect = stageViewport.getBoundingClientRect();
    const availW = Math.max(240, rect.width - 28);
    const availH = Math.max(180, rect.height - 20);
    const scale = Math.min(availW / STAGE_W, availH / STAGE_H, 1.3);
    stageFrame.style.width = `${Math.round(STAGE_W * scale)}px`;
    stageFrame.style.height = `${Math.round(STAGE_H * scale)}px`;
  }

  function eventToStageCoords(e) {
    const rect = stageCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (STAGE_W / (rect.width || STAGE_W)),
      y: (e.clientY - rect.top) * (STAGE_H / (rect.height || STAGE_H))
    };
  }

  new ResizeObserver(fitStageToViewport).observe(stageViewport);

  // --------------------------------------------------------------------------
  // Palette Initialization
  // --------------------------------------------------------------------------
  function initPalette() {
    const grid = document.getElementById('palette-grid');
    grid.innerHTML = '';
    for (const hex of PALETTE_COLORS) {
      const btn = document.createElement('button');
      btn.className = 'pal-swatch';
      btn.style.background = hex;
      btn.title = `Left-click: Primary (${hex}) | Right-click: Secondary`;
      btn.addEventListener('click', () => {
        state.primaryColor = hex;
        syncColorUI();
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        state.secondaryColor = hex;
        syncColorUI();
      });
      grid.appendChild(btn);
    }

    const pInput = document.getElementById('input-primary-color');
    const sInput = document.getElementById('input-secondary-color');
    pInput.addEventListener('input', (e) => {
      state.primaryColor = e.target.value;
      syncColorUI();
    });
    sInput.addEventListener('input', (e) => {
      state.secondaryColor = e.target.value;
      syncColorUI();
    });
    document.getElementById('btn-swap-colors').addEventListener('click', () => {
      const tmp = state.primaryColor;
      state.primaryColor = state.secondaryColor;
      state.secondaryColor = tmp;
      syncColorUI();
    });
  }

  function syncColorUI() {
    document.getElementById('swatch-primary-box').style.background = state.primaryColor;
    document.getElementById('swatch-secondary-box').style.background = state.secondaryColor;
    document.getElementById('input-primary-color').value = state.primaryColor;
    document.getElementById('input-secondary-color').value = state.secondaryColor;
    document.getElementById('input-bg-color').value = state.stageBgColor;
  }

  // --------------------------------------------------------------------------
  // Mode Switching & Contextual Coach Banner
  // --------------------------------------------------------------------------
  function setMode(newMode) {
    if (!['draw', 'rig', 'animate'].includes(newMode)) return;
    commitPendingEdits();
    if (newMode !== 'animate') {
      state.isPlaying = false;
      state.scrubPreviewPose = null;
    }
    state.mode = newMode;
    document.body.dataset.mode = newMode;
    syncAllUI();
    requestRender();
  }

  function commitPendingEdits() {
    finishTextInput();
    if (state.selection) {
      PaintTools.commitSelection();
    }
  }

  function updateCoachBanner() {
    if (state.mode === 'draw') {
      if (state.selection) {
        coachBanner.innerHTML = '✂️ <strong>Selection ready!</strong> Drag to move, drag corners to scale, or click <strong>Split to New Part</strong> above!';
      } else if (state.editingBackdrop) {
        coachBanner.innerHTML = '🏞️ <strong>Painting Scenery Backdrop:</strong> Scenery stays completely still behind your animated characters!';
      } else if (state.tool === 'select') {
        coachBanner.innerHTML = '✂️ <strong>Lasso Tool:</strong> Draw a loop around any piece (like an arm or ball) to move it or split it into its own Part!';
      } else {
        coachBanner.innerHTML = '🎨 <strong>Draw freely!</strong> Left-click = Primary color, Right-click = Secondary. Ready to bring it to life? Click <strong>2. Rig</strong> or <strong>3. Animate</strong>!';
      }
    } else if (state.mode === 'rig') {
      if (state.bones.length === 0) {
        coachBanner.innerHTML = '🦴 <strong>Super Easy Rigging:</strong> Click &amp; drag across your character to add bones — or click <strong>⚡ Person Rig</strong> above! Everything binds automatically.';
      } else {
        coachBanner.innerHTML = '🦴 <strong>Rig Mode:</strong> Drag from any glowing dot to branch more limbs, or click <strong>3. Animate</strong> to bend &amp; pose your puppet!';
      }
    } else {
      if (state.isPlaying) {
        coachBanner.innerHTML = '🎬 <strong>Playing tweened animation!</strong> Press <strong>Space</strong> or click stage to pause &amp; tweak poses.';
      } else if (state.bones.length === 0 || state.animTool === 'transform') {
        coachBanner.innerHTML = '📐 <strong>Squash, Stretch &amp; Move:</strong> Drag inside box to move, drag sides to squash/stretch, top handle to spin! Click <strong>+ Add Pose</strong> below to tween.';
      } else {
        coachBanner.innerHTML = '🤖 <strong>Pose &amp; Tween:</strong> Drag any <strong>joint dot</strong> to bend limbs (IK), drag the <strong>gold diamond</strong> to move body, or click <strong>+ Add Pose</strong> below!';
      }
    }
  }

  // --------------------------------------------------------------------------
  // Inline Text Tool Overlay
  // --------------------------------------------------------------------------
  function openTextInputAt(stageX, stageY, color) {
    finishTextInput();
    const frameRect = stageFrame.getBoundingClientRect();
    const scaleX = frameRect.width / STAGE_W;
    const scaleY = frameRect.height / STAGE_H;

    pendingTextPos = { x: stageX, y: stageY, color };
    textOverlay.value = '';
    textOverlay.style.left = `${stageX * scaleX}px`;
    textOverlay.style.top = `${stageY * scaleY}px`;
    textOverlay.style.fontSize = `${Math.max(12, state.fontSize * scaleY)}px`;
    textOverlay.style.color = color;
    textOverlay.classList.remove('hidden');
    setTimeout(() => textOverlay.focus(), 10);
  }

  function finishTextInput() {
    if (!pendingTextPos || textOverlay.classList.contains('hidden')) return;
    const val = textOverlay.value;
    const { x, y, color } = pendingTextPos;
    pendingTextPos = null;
    textOverlay.classList.add('hidden');
    textOverlay.value = '';
    if (val && val.trim()) {
      PaintTools.stampText(val, x, y, color);
      scheduleThumbRefresh();
      requestRender();
    }
  }

  textOverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finishTextInput();
    } else if (e.key === 'Escape') {
      pendingTextPos = null;
      textOverlay.classList.add('hidden');
    }
  });
  textOverlay.addEventListener('blur', () => finishTextInput());

  // --------------------------------------------------------------------------
  // Stage Pointer Events (Draw + Rig + Animate)
  // --------------------------------------------------------------------------
  stageFrame.addEventListener('contextmenu', (e) => e.preventDefault());

  function hitTestTransformGizmo(part, pose, x, y) {
    const g = getPartTransformGizmo(part, pose);
    if (!g) return null;
    if (dist(x, y, g.handles.rotate.x, g.handles.rotate.y) <= 11) {
      return { handle: 'rotate', gizmo: g };
    }
    for (const k of ['nw', 'ne', 'se', 'sw', 'n', 's', 'e', 'w']) {
      if (dist(x, y, g.handles[k].x, g.handles[k].y) <= 10) {
        return { handle: k, gizmo: g };
      }
    }
    // Check inside oriented bounding quad
    const dx = x - g.cx;
    const dy = y - g.cy;
    const cos = Math.cos(-g.rot);
    const sin = Math.sin(-g.rot);
    const lx = (dx * cos - dy * sin) / (g.sx || 1);
    const ly = (dx * sin + dy * cos) / (g.sy || 1);
    if (Math.abs(lx) <= g.halfW && Math.abs(ly) <= g.halfH) {
      return { handle: 'move', gizmo: g };
    }
    return null;
  }

  function findVisiblePartAtPixel(x, y, pose) {
    // Check top-to-bottom for unbound or visible parts clicked directly
    for (let i = state.parts.length - 1; i >= 0; i--) {
      const p = state.parts[i];
      if (!p.visible || !p.bounds) continue;
      const g = getPartTransformGizmo(p, pose);
      if (!g) continue;
      const dx = x - g.cx;
      const dy = y - g.cy;
      const cos = Math.cos(-g.rot);
      const sin = Math.sin(-g.rot);
      const lx = (dx * cos - dy * sin) / (g.sx || 1) + p.bounds.cx;
      const ly = (dx * sin + dy * cos) / (g.sy || 1) + p.bounds.cy;
      const px = Math.floor(lx);
      const py = Math.floor(ly);
      if (px >= 0 && px < STAGE_W && py >= 0 && py < STAGE_H) {
        const a = p.ctx.getImageData(px, py, 1, 1).data[3];
        if (a > 12) return p;
      }
    }
    return null;
  }

  stageFrame.addEventListener('pointerdown', (e) => {
    if (e.target === textOverlay) return;
    const { x, y } = eventToStageCoords(e);
    stageFrame.setPointerCapture(e.pointerId);

    // -------------------- 1. DRAW MODE --------------------
    if (state.mode === 'draw') {
      const res = PaintTools.onPointerDown(x, y, e, stageCanvas, openTextInputAt);
      uiHintState.previewCanvas = res ? res.previewCanvas : null;
      syncSubbarUI();
      updateCoachBanner();
      requestRender();
      return;
    }

    // -------------------- 2. RIG MODE --------------------
    if (state.mode === 'rig') {
      // Right-click quick erase bone/joint!
      if (e.button === 2 || state.rigTool === 'erase') {
        const jHit = findJointAt(x, y, null, 15);
        if (jHit) {
          pushHistory('Delete Joint');
          deleteJoint(jHit.joint.id);
          syncAllUI();
          requestRender();
          return;
        }
        const bHit = findBoneAt(x, y, null, 12);
        if (bHit) {
          pushHistory('Delete Bone');
          deleteBone(bHit.bone.id);
          syncAllUI();
          requestRender();
          return;
        }
        return;
      }

      if (state.rigTool === 'pin') {
        const jHit = findJointAt(x, y, null, 16);
        if (jHit) {
          pushHistory('Toggle Joint Pin');
          jHit.joint.pinned = !jHit.joint.pinned;
          showToast(jHit.joint.pinned ? '📌 Joint pinned (IK anchor)' : 'Joint unpinned');
          requestRender();
        }
        return;
      }

      if (state.rigTool === 'move') {
        const jHit = findJointAt(x, y, null, 16);
        if (jHit) {
          pushHistory('Adjust Joint');
          state.selectedJointId = jHit.joint.id;
          activeInteraction = { kind: 'rig-move-joint', joint: jHit.joint };
          requestRender();
        }
        return;
      }

      // Default 'bone' creation tool: snap start to nearby joint if within 18px!
      const snapStart = findJointAt(x, y, null, 18);
      const sx = snapStart ? snapStart.x : x;
      const sy = snapStart ? snapStart.y : y;
      activeInteraction = {
        kind: 'rig-draw-bone',
        x1: sx,
        y1: sy,
        x2: x,
        y2: y
      };
      uiHintState.boneDragPreview = { x1: sx, y1: sy, x2: x, y2: y };
      requestRender();
      return;
    }

    // -------------------- 3. ANIMATE MODE --------------------
    if (state.mode === 'animate') {
      if (state.isPlaying) {
        state.isPlaying = false;
        state.scrubPreviewPose = null;
        syncTimelineUI();
      } else if (state.scrubPreviewPose) {
        state.scrubPreviewPose = null;
      }

      const pose = getActivePose();
      const useBoxMode = state.animTool === 'transform' || state.bones.length === 0;

      if (!useBoxMode && state.bones.length > 0) {
        // 1. Check Joint Drag (Smart IK or Root Move)
        const jHit = findJointAt(x, y, pose, 16);
        if (jHit) {
          pushHistory('Pose Joint');
          state.selectedJointId = jHit.joint.id;
          if (state.animTool === 'fk' && !jHit.isRoot) {
            // Find incoming bone to rotate via FK
            const incBone = state.bones.find((b) => b.childJointId === jHit.joint.id);
            if (incBone) {
              const fk = solveForwardKinematics(pose);
              const bt = fk.boneTransforms.get(incBone.id);
              activeInteraction = {
                kind: 'anim-fk-bone',
                boneId: incBone.id,
                grabOffset: bt ? shortAngleDiff(Math.atan2(y - bt.ay, x - bt.ax), bt.worldAngle) : 0
              };
              return;
            }
          }
          activeInteraction = { kind: 'anim-ik-joint', jointId: jHit.joint.id };
          return;
        }

        // 2. Check Bone Shaft Drag (Direct FK Rotation!)
        const bHit = findBoneAt(x, y, pose, 13);
        if (bHit) {
          pushHistory('Rotate Bone');
          state.selectedBoneId = bHit.bone.id;
          const bt = bHit.bt;
          const pointerAngle = Math.atan2(y - bt.ay, x - bt.ax);
          activeInteraction = {
            kind: 'anim-fk-bone',
            boneId: bHit.bone.id,
            grabOffset: shortAngleDiff(pointerAngle, bt.worldAngle)
          };
          requestRender();
          return;
        }

        // 3. Check if user clicked an unbound independent Part (like a separate ball/prop!)
        const clickedPart = findVisiblePartAtPixel(x, y, pose);
        if (clickedPart) {
          const mesh = ensurePartMesh(clickedPart);
          if (!mesh.bound) {
            state.activePartId = clickedPart.id;
            syncPartsUI();
            const pt = ensurePartTransform(pose, clickedPart.id);
            pushHistory('Move Part');
            activeInteraction = {
              kind: 'anim-gizmo',
              handle: 'move',
              part: clickedPart,
              startX: x,
              startY: y,
              origPt: { ...pt },
              gizmo: getPartTransformGizmo(clickedPart, pose)
            };
            requestRender();
            return;
          }
        }
      }

      // Transform Box Mode (or 0-bone scene!)
      let activePart = getActivePart();
      let gHit = activePart ? hitTestTransformGizmo(activePart, pose, x, y) : null;

      if (!gHit) {
        // See if user clicked directly on another Part on stage!
        const otherPart = findVisiblePartAtPixel(x, y, pose);
        if (otherPart) {
          state.activePartId = otherPart.id;
          activePart = otherPart;
          syncPartsUI();
          gHit = hitTestTransformGizmo(activePart, pose, x, y) || {
            handle: 'move',
            gizmo: getPartTransformGizmo(activePart, pose)
          };
        }
      }

      if (gHit && activePart) {
        pushHistory('Transform Part');
        const pt = ensurePartTransform(pose, activePart.id);
        activeInteraction = {
          kind: 'anim-gizmo',
          handle: gHit.handle,
          part: activePart,
          startX: x,
          startY: y,
          lastAngle: Math.atan2(y - gHit.gizmo.cy, x - gHit.gizmo.cx),
          origPt: { ...pt },
          gizmo: gHit.gizmo
        };
        requestRender();
      }
    }
  });

  stageFrame.addEventListener('pointermove', (e) => {
    const { x, y } = eventToStageCoords(e);
    uiHintState.cursorPos = { x, y };

    // -------------------- 1. DRAW MODE --------------------
    if (state.mode === 'draw') {
      const res = PaintTools.onPointerMove(x, y, e);
      if (res) uiHintState.previewCanvas = res.previewCanvas;
      requestRender();
      return;
    }

    // -------------------- 2. RIG MODE --------------------
    if (state.mode === 'rig') {
      if (activeInteraction && activeInteraction.kind === 'rig-draw-bone') {
        const snapEnd = findJointAt(x, y, null, 18);
        const ex = snapEnd ? snapEnd.x : x;
        const ey = snapEnd ? snapEnd.y : y;
        activeInteraction.x2 = ex;
        activeInteraction.y2 = ey;
        uiHintState.snapJointId = snapEnd ? snapEnd.joint.id : null;
        uiHintState.boneDragPreview = {
          x1: activeInteraction.x1,
          y1: activeInteraction.y1,
          x2: ex,
          y2: ey
        };
        requestRender();
        return;
      }

      if (activeInteraction && activeInteraction.kind === 'rig-move-joint') {
        activeInteraction.joint.x = clamp(Math.round(x), 4, STAGE_W - 4);
        activeInteraction.joint.y = clamp(Math.round(y), 4, STAGE_H - 4);
        recomputeRestSkeleton();
        requestRender();
        return;
      }

      // Hover highlights in Rig mode
      const jHit = findJointAt(x, y, null, 18);
      uiHintState.hoverJointId = jHit ? jHit.joint.id : null;
      uiHintState.snapJointId = state.rigTool === 'bone' && jHit ? jHit.joint.id : null;
      const bHit = !jHit ? findBoneAt(x, y, null, 12) : null;
      uiHintState.hoverBoneId = bHit ? bHit.bone.id : null;
      requestRender();
      return;
    }

    // -------------------- 3. ANIMATE MODE --------------------
    if (state.mode === 'animate') {
      const pose = getActivePose();

      if (activeInteraction) {
        if (activeInteraction.kind === 'anim-ik-joint') {
          solveIKDrag(pose, activeInteraction.jointId, x, y, {
            fullChain: e.shiftKey,
            stretch: state.stretchBones
          });
          scheduleThumbRefresh();
          requestRender();
          return;
        }

        if (activeInteraction.kind === 'anim-fk-bone') {
          const fk = solveForwardKinematics(pose);
          const bt = fk.boneTransforms.get(activeInteraction.boneId);
          if (bt) {
            const ptrAngle = Math.atan2(y - bt.ay, x - bt.ax);
            rotateBoneFK(pose, activeInteraction.boneId, ptrAngle + activeInteraction.grabOffset);
            scheduleThumbRefresh();
            requestRender();
          }
          return;
        }

        if (activeInteraction.kind === 'anim-gizmo') {
          const pt = ensurePartTransform(pose, activeInteraction.part.id);
          const orig = activeInteraction.origPt;
          const g = activeInteraction.gizmo;
          const h = activeInteraction.handle;

          if (h === 'move') {
            pt.dx = orig.dx + (x - activeInteraction.startX);
            pt.dy = orig.dy + (y - activeInteraction.startY);
          } else if (h === 'rotate') {
            const curAng = Math.atan2(y - g.cy, x - g.cx);
            const stepDiff = shortAngleDiff(activeInteraction.lastAngle, curAng);
            pt.rotation = (pt.rotation || 0) + stepDiff;
            activeInteraction.lastAngle = curAng;
          } else {
            // Local coordinates relative to center in unscaled gizmo orientation
            const dx = x - g.cx;
            const dy = y - g.cy;
            const cos = Math.cos(-orig.rotation);
            const sin = Math.sin(-orig.rotation);
            const lx = dx * cos - dy * sin;
            const ly = dx * sin + dy * cos;

            if (h.length === 2) {
              // Corner scale
              const newSX = clamp(Math.abs(lx) / g.halfW, 0.15, 4.0) * Math.sign(orig.scaleX || 1);
              const newSY = clamp(Math.abs(ly) / g.halfH, 0.15, 4.0) * Math.sign(orig.scaleY || 1);
              if (e.shiftKey) {
                const uni = Math.max(Math.abs(newSX), Math.abs(newSY));
                pt.scaleX = uni * Math.sign(orig.scaleX || 1);
                pt.scaleY = uni * Math.sign(orig.scaleY || 1);
              } else {
                pt.scaleX = newSX;
                pt.scaleY = newSY;
              }
            } else if (h === 'n' || h === 's') {
              const newSY = clamp(Math.abs(ly) / g.halfH, 0.2, 3.5);
              pt.scaleY = newSY;
              // Hold Alt or default gentle volume conservation if Alt pressed!
              if (e.altKey) {
                pt.scaleX = clamp(1 / Math.sqrt(newSY), 0.35, 2.8);
              }
            } else if (h === 'e' || h === 'w') {
              const newSX = clamp(Math.abs(lx) / g.halfW, 0.2, 3.5);
              pt.scaleX = newSX;
              if (e.altKey) {
                pt.scaleY = clamp(1 / Math.sqrt(newSX), 0.35, 2.8);
              }
            }
          }
          scheduleThumbRefresh();
          requestRender();
          return;
        }
      }

      // Hover feedback in Animate mode
      const showBox = state.animTool === 'transform' || state.bones.length === 0;
      if (showBox) {
        const activePart = getActivePart();
        const gHit = activePart ? hitTestTransformGizmo(activePart, pose, x, y) : null;
        uiHintState.hoverGizmoHandle = gHit ? gHit.handle : null;
        uiHintState.hoverJointId = null;
        uiHintState.hoverBoneId = null;
      } else {
        uiHintState.hoverGizmoHandle = null;
        const jHit = findJointAt(x, y, pose, 16);
        uiHintState.hoverJointId = jHit ? jHit.joint.id : null;
        const bHit = !jHit ? findBoneAt(x, y, pose, 13) : null;
        uiHintState.hoverBoneId = bHit ? bHit.bone.id : null;
      }
      requestRender();
    }
  });

  function endStagePointer(e) {
    if (state.mode === 'draw') {
      uiHintState.previewCanvas = null;
      PaintTools.onPointerUp(e);
      syncSubbarUI();
      updateCoachBanner();
      scheduleThumbRefresh();
      requestRender();
      return;
    }

    if (state.mode === 'rig' && activeInteraction) {
      if (activeInteraction.kind === 'rig-draw-bone') {
        const { x1, y1, x2, y2 } = activeInteraction;
        uiHintState.boneDragPreview = null;
        uiHintState.snapJointId = null;
        if (dist(x1, y1, x2, y2) >= 10) {
          pushHistory('Add Bone');
          addBone(x1, y1, x2, y2, 18);
          syncAllUI();
        }
      } else if (activeInteraction.kind === 'rig-move-joint') {
        scheduleThumbRefresh();
      }
      activeInteraction = null;
      requestRender();
      return;
    }

    if (state.mode === 'animate' && activeInteraction) {
      activeInteraction = null;
      scheduleThumbRefresh();
      requestRender();
    }
  }

  stageFrame.addEventListener('pointerup', endStagePointer);
  stageFrame.addEventListener('pointerleave', () => {
    uiHintState.cursorPos = null;
    if (!activeInteraction) requestRender();
  });

  // --------------------------------------------------------------------------
  // UI Controls Wiring
  // --------------------------------------------------------------------------
  function wireControls() {
    // Mode switcher
    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    // Paint Tools (clicking a Paint tool from Rig/Animate switches smoothly to Draw mode!)
    document.querySelectorAll('#paint-tool-grid .tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.selection && btn.dataset.tool !== 'select') {
          PaintTools.commitSelection();
        }
        state.tool = btn.dataset.tool;
        if (state.mode !== 'draw') {
          setMode('draw');
        } else {
          syncAllUI();
          requestRender();
        }
      });
    });

    // Brush size quick dots & slider
    document.querySelectorAll('#size-quick-dots .size-dot-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.brushSize = Number(btn.dataset.size);
        syncSubbarUI();
      });
    });
    document.getElementById('slider-brush-size').addEventListener('input', (e) => {
      state.brushSize = Number(e.target.value);
      syncSubbarUI();
    });
    document.getElementById('chk-smoothing').addEventListener('change', (e) => {
      state.brushSmoothing = e.target.checked;
    });

    // Shape fill buttons
    document.querySelectorAll('#cluster-shape-fill .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.shapeFillMode = btn.dataset.fill;
        syncSubbarUI();
      });
    });

    // Bucket tolerance & Font size
    document.getElementById('slider-tolerance').addEventListener('input', (e) => {
      state.bucketTolerance = Number(e.target.value);
      document.getElementById('label-tolerance').textContent = state.bucketTolerance;
    });
    document.getElementById('slider-font-size').addEventListener('input', (e) => {
      state.fontSize = Number(e.target.value);
      document.getElementById('label-font-size').textContent = `${state.fontSize}px`;
    });

    // Selection actions
    document.getElementById('btn-pop-part').addEventListener('click', () => {
      const created = PaintTools.popSelectionToNewPart();
      if (created) {
        showToast(`✨ Created "${created.name}" — ready to rig or tween separately!`);
        syncAllUI();
        scheduleThumbRefresh();
        requestRender();
      }
    });
    document.getElementById('btn-stamp-sel').addEventListener('click', () => {
      PaintTools.commitSelection();
      syncSubbarUI();
      scheduleThumbRefresh();
      requestRender();
    });
    document.getElementById('btn-del-sel').addEventListener('click', () => {
      PaintTools.deleteSelectionPixels();
      syncSubbarUI();
      scheduleThumbRefresh();
      requestRender();
    });

    // Clear layer
    document.getElementById('btn-clear-layer').addEventListener('click', () => {
      pushHistory('Clear Layer');
      if (state.editingBackdrop) {
        state.backdropCtx.clearRect(0, 0, STAGE_W, STAGE_H);
      } else {
        const part = getActivePart();
        if (part) {
          part.ctx.clearRect(0, 0, STAGE_W, STAGE_H);
          markPartDirty(part);
        }
      }
      scheduleThumbRefresh();
      requestRender();
    });

    // Rig Subbar Controls
    document.querySelectorAll('[data-rigtool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.rigTool = btn.dataset.rigtool;
        syncSubbarUI();
      });
    });
    document.querySelectorAll('[data-stamp]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pushHistory('Auto-Rig Stamp');
        stampSkeleton(btn.dataset.stamp);
        showToast('⚡ Skeleton stamped! Drag joints to fine-tune, or click 3. Animate!');
        syncAllUI();
        scheduleThumbRefresh();
        requestRender();
      });
    });
    document.getElementById('chk-wireframe').addEventListener('change', (e) => {
      state.showMeshWireframe = e.target.checked;
      requestRender();
    });
    document.getElementById('btn-clear-rig').addEventListener('click', () => {
      if (state.bones.length === 0) return;
      pushHistory('Clear Rig');
      state.joints = [];
      state.bones = [];
      for (const p of state.poses) {
        p.bonePose = {};
        p.rootOffsets = {};
      }
      markAllMeshesDirty();
      syncAllUI();
      scheduleThumbRefresh();
      requestRender();
    });

    // Animate Subbar Controls
    document.querySelectorAll('[data-animtool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.animTool = btn.dataset.animtool;
        syncSubbarUI();
        updateCoachBanner();
        requestRender();
      });
    });
    document.getElementById('chk-stretch').addEventListener('change', (e) => {
      state.stretchBones = e.target.checked;
    });
    document.querySelectorAll('[data-motion]').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyMagicMotion(btn.dataset.motion);
        showToast('✨ Magic motion created! Press Space to pause & customize any pose.');
        syncAllUI();
        scheduleThumbRefresh();
        requestRender();
      });
    });
    document.getElementById('btn-reset-pose').addEventListener('click', () => {
      pushHistory('Reset Pose');
      resetPoseToRest(getActivePose());
      state.scrubPreviewPose = null;
      scheduleThumbRefresh();
      requestRender();
    });

    // Right Dock: Parts & Backdrop
    document.getElementById('btn-add-part').addEventListener('click', () => {
      commitPendingEdits();
      pushHistory('Add Part');
      const p = createPart(`Part ${state.parts.length + 1}`, 'auto');
      state.parts.push(p);
      state.activePartId = p.id;
      state.editingBackdrop = false;
      syncAllUI();
      requestRender();
    });

    document.getElementById('backdrop-card').addEventListener('click', (e) => {
      if (e.target.closest('input') || e.target.closest('button')) return;
      commitPendingEdits();
      state.editingBackdrop = true;
      if (state.mode !== 'draw') setMode('draw');
      else {
        syncAllUI();
        requestRender();
      }
    });
    document.getElementById('input-bg-color').addEventListener('input', (e) => {
      state.stageBgColor = e.target.value;
      scheduleThumbRefresh();
      requestRender();
    });
    document.getElementById('btn-toggle-backdrop').addEventListener('click', (e) => {
      e.stopPropagation();
      state.backdropVisible = !state.backdropVisible;
      document.getElementById('btn-toggle-backdrop').style.opacity = state.backdropVisible ? '1' : '0.35';
      scheduleThumbRefresh();
      requestRender();
    });

    // Topbar: New, Examples, Undo/Redo, Save/Open, Export
    document.getElementById('btn-new').addEventListener('click', () => {
      commitPendingEdits();
      resetProject();
      setMode('draw');
      showToast('Fresh canvas ready!');
      scheduleThumbRefresh();
    });

    const menuExamples = document.getElementById('menu-examples');
    document.getElementById('btn-examples').addEventListener('click', (e) => {
      e.stopPropagation();
      menuExamples.classList.toggle('hidden');
      document.getElementById('menu-export').classList.add('hidden');
    });
    menuExamples.querySelectorAll('[data-template]').forEach((btn) => {
      btn.addEventListener('click', () => {
        menuExamples.classList.add('hidden');
        const t = btn.dataset.template;
        if (t === 'buddy') Templates.loadWavingBuddy();
        else if (t === 'dino') Templates.loadBouncyDino();
        else if (t === 'slime') Templates.loadSlimeAndBall();
        document.body.dataset.mode = state.mode;
        syncAllUI();
        scheduleThumbRefresh(true);
        requestRender();
      });
    });

    const menuExport = document.getElementById('menu-export');
    document.getElementById('btn-more-export').addEventListener('click', (e) => {
      e.stopPropagation();
      menuExport.classList.toggle('hidden');
      menuExamples.classList.add('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.dropdown-wrap')) {
        menuExamples.classList.add('hidden');
        menuExport.classList.add('hidden');
      }
      if (!e.target.closest('#tween-popover') && !e.target.closest('.tween-pill-btn')) {
        document.getElementById('tween-popover').classList.add('hidden');
        activePopoverPoseIdx = null;
      }
    });

    document.getElementById('btn-undo').addEventListener('click', () => {
      commitPendingEdits();
      if (undo()) {
        syncAllUI();
        scheduleThumbRefresh(true);
        requestRender();
      }
    });
    document.getElementById('btn-redo').addEventListener('click', () => {
      commitPendingEdits();
      if (redo()) {
        syncAllUI();
        scheduleThumbRefresh(true);
        requestRender();
      }
    });

    // Save / Open JSON Project
    document.getElementById('btn-save').addEventListener('click', () => {
      commitPendingEdits();
      const json = serializeProject();
      const blob = new Blob([json], { type: 'application/json' });
      triggerDownload(blob, 'my-animation.wiggle.json');
      showToast('💾 Project saved!');
    });

    const fileInput = document.getElementById('file-open-input');
    document.getElementById('btn-open').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const txt = await file.text();
        await deserializeProject(txt);
        syncAllUI();
        scheduleThumbRefresh(true);
        requestRender();
        showToast('📂 Project loaded!');
      } catch (err) {
        showToast('Could not read project file.');
      }
      fileInput.value = '';
    });

    // Exports
    document.getElementById('btn-export-gif').addEventListener('click', exportAnimatedGIF);
    document.getElementById('btn-export-webm').addEventListener('click', () => {
      menuExport.classList.add('hidden');
      exportWebMVideo();
    });
    document.getElementById('btn-export-png').addEventListener('click', () => {
      menuExport.classList.add('hidden');
      exportPNGFrame();
    });

    // Timeline Transport
    document.getElementById('btn-play').addEventListener('click', togglePlayback);
    document.getElementById('chk-loop-seamless').addEventListener('change', (e) => {
      state.loopSeamless = e.target.checked;
      syncTimelineUI();
    });
    document.getElementById('chk-onion').addEventListener('change', (e) => {
      state.onionSkin = e.target.checked;
      requestRender();
    });
    document.getElementById('select-speed').addEventListener('change', (e) => {
      state.playbackSpeed = Number(e.target.value) || 1;
    });

    // Scrubber
    const scrubber = document.getElementById('timeline-scrubber');
    scrubber.addEventListener('input', (e) => {
      state.isPlaying = false;
      if (state.mode !== 'animate') {
        state.mode = 'animate';
        document.body.dataset.mode = 'animate';
      }
      const frac = Number(e.target.value) / 1000;
      const total = getTotalDuration();
      state.playTime = frac * total;
      const ev = evaluatePoseAtTime(state.playTime);
      state.scrubPreviewPose = ev.pose;
      document.getElementById('time-readout').textContent = `${ev.wrappedTime.toFixed(2)}s / ${total.toFixed(2)}s`;
      syncSubbarUI();
      syncModeButtons();
      updateCoachBanner();
      requestRender();
    });

    // Tween Easing & Duration Popover Buttons
    document.querySelectorAll('#popover-easing-btns .ease-choice').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (activePopoverPoseIdx === null || !state.poses[activePopoverPoseIdx]) return;
        pushHistory('Change Tween Easing');
        state.poses[activePopoverPoseIdx].easing = btn.dataset.ease;
        syncTimelineUI();
        openTweenPopoverForPose(activePopoverPoseIdx);
      });
    });
    document.querySelectorAll('#popover-dur-btns button').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (activePopoverPoseIdx === null || !state.poses[activePopoverPoseIdx]) return;
        pushHistory('Change Tween Duration');
        state.poses[activePopoverPoseIdx].duration = Number(btn.dataset.dur);
        syncTimelineUI();
        openTweenPopoverForPose(activePopoverPoseIdx);
      });
    });

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select')) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey ? redo() : undo()) {
          syncAllUI();
          scheduleThumbRefresh(true);
          requestRender();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        if (redo()) {
          syncAllUI();
          scheduleThumbRefresh(true);
          requestRender();
        }
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayback();
        return;
      }

      const k = e.key.toLowerCase();
      if (k === '1') setMode('draw');
      else if (k === '2') setMode('rig');
      else if (k === '3') setMode('animate');
      else if (k === 'x') {
        const t = state.primaryColor;
        state.primaryColor = state.secondaryColor;
        state.secondaryColor = t;
        syncColorUI();
      } else if (k === '[') {
        state.brushSize = Math.max(1, state.brushSize - 2);
        syncSubbarUI();
        requestRender();
      } else if (k === ']') {
        state.brushSize = Math.min(60, state.brushSize + 2);
        syncSubbarUI();
        requestRender();
      } else if (k === 'delete' || k === 'backspace') {
        if (state.selection) {
          PaintTools.deleteSelectionPixels();
          syncSubbarUI();
          requestRender();
        }
      } else if (state.mode === 'draw') {
        const map = {
          b: 'brush', p: 'pencil', g: 'bucket', a: 'spray',
          e: 'eraser', s: 'select', l: 'line', r: 'rect',
          o: 'ellipse', t: 'text', i: 'eyedropper'
        };
        if (map[k]) {
          state.tool = map[k];
          syncAllUI();
          requestRender();
        }
      }
    });
  }

  function togglePlayback() {
    commitPendingEdits();
    if (state.poses.length < 2 && !state.isPlaying) {
      showToast('💡 Tip: Click "+ Add Pose" below and move your character to see tweening — or try "1-Click Motion"!');
    }
    state.isPlaying = !state.isPlaying;
    if (state.isPlaying) {
      if (state.mode !== 'animate') {
        state.mode = 'animate';
        document.body.dataset.mode = 'animate';
      }
      state.playTime = getPoseStartTime(state.activePoseIndex);
    } else {
      state.scrubPreviewPose = null;
    }
    syncAllUI();
    requestRender();
  }

  // --------------------------------------------------------------------------
  // UI Synchronization (Mode, Subbar, Parts List, Timeline Strip)
  // --------------------------------------------------------------------------
  function syncModeButtons() {
    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
    });
    const boneBadge = document.getElementById('badge-bones');
    boneBadge.textContent = state.bones.length;
    boneBadge.classList.toggle('hidden', state.bones.length === 0);

    document.getElementById('badge-poses').textContent = state.poses.length;
    document.getElementById('btn-undo').disabled = state.undoStack.length === 0;
    document.getElementById('btn-redo').disabled = state.redoStack.length === 0;
  }

  function syncSubbarUI() {
    document.getElementById('subbar-draw').classList.toggle('hidden', state.mode !== 'draw');
    document.getElementById('subbar-rig').classList.toggle('hidden', state.mode !== 'rig');
    document.getElementById('subbar-animate').classList.toggle('hidden', state.mode !== 'animate');

    // Left Paint Tool active highlight
    document.querySelectorAll('#paint-tool-grid .tool-btn').forEach((btn) => {
      btn.classList.toggle('active', state.mode === 'draw' && btn.dataset.tool === state.tool);
    });

    // Draw subbar visibility per tool
    const isShape = ['line', 'rect', 'ellipse', 'star'].includes(state.tool);
    document.getElementById('cluster-shape-fill').classList.toggle('hidden', !isShape || state.tool === 'line');
    document.getElementById('cluster-bucket-tol').classList.toggle('hidden', state.tool !== 'bucket');
    document.getElementById('cluster-font-size').classList.toggle('hidden', state.tool !== 'text');
    document.getElementById('chip-smoothing').classList.toggle('hidden', state.tool !== 'brush');
    document.getElementById('cluster-selection-actions').classList.toggle('hidden', !state.selection);

    document.getElementById('slider-brush-size').value = state.brushSize;
    document.getElementById('label-brush-size').textContent = `${state.brushSize}px`;
    document.querySelectorAll('#size-quick-dots .size-dot-btn').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.size) === state.brushSize);
    });
    document.querySelectorAll('#cluster-shape-fill .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.fill === state.shapeFillMode);
    });

    // Rig subbar
    document.querySelectorAll('[data-rigtool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.rigtool === state.rigTool);
    });
    document.getElementById('chk-wireframe').checked = state.showMeshWireframe;

    // Animate subbar
    const effectiveAnimTool = state.bones.length === 0 ? 'transform' : state.animTool;
    document.querySelectorAll('[data-animtool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.animtool === effectiveAnimTool);
    });
    document.getElementById('chk-stretch').checked = state.stretchBones;
  }

  function syncPartsUI() {
    const list = document.getElementById('parts-list');
    list.innerHTML = '';

    const bindLabels = {
      auto: 'Auto Rig',
      bendy: 'Puppet Rig',
      rigid: '1-Bone Lock',
      none: 'Free Prop'
    };
    const bindCycle = ['auto', 'bendy', 'rigid', 'none'];

    // Display top-to-bottom (reverse of render order so front-most part is on top!)
    for (let i = state.parts.length - 1; i >= 0; i--) {
      const part = state.parts[i];
      const card = document.createElement('div');
      card.className = `part-card ${!state.editingBackdrop && part.id === state.activePartId ? 'active' : ''}`;

      const thumb = document.createElement('canvas');
      thumb.width = 52;
      thumb.height = 34;
      thumb.className = 'part-thumb';
      thumb.dataset.partThumbId = part.id;
      thumb.getContext('2d').drawImage(part.canvas, 0, 0, 52, 34);

      const meta = document.createElement('div');
      meta.className = 'part-meta';

      const titleRow = document.createElement('div');
      titleRow.className = 'part-title-row';

      const nameEl = document.createElement('strong');
      nameEl.textContent = part.name;
      nameEl.title = 'Double-click to rename Part';
      nameEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const next = prompt('Rename Part:', part.name);
        if (next && next.trim()) {
          part.name = next.trim();
          syncPartsUI();
        }
      });

      const visBtn = document.createElement('button');
      visBtn.className = 'tiny-icon-btn';
      visBtn.textContent = part.visible ? '👁️' : '🙈';
      visBtn.title = 'Toggle Part visibility';
      visBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        part.visible = !part.visible;
        syncPartsUI();
        scheduleThumbRefresh();
        requestRender();
      });

      titleRow.appendChild(nameEl);
      titleRow.appendChild(visBtn);

      const actionsRow = document.createElement('div');
      actionsRow.className = 'part-actions-row';

      const bindBtn = document.createElement('button');
      bindBtn.className = 'part-bind-pill';
      bindBtn.textContent = bindLabels[part.bindMode] || 'Auto Rig';
      bindBtn.title = 'Click to switch how this Part reacts to Bones (Auto / Bendy / Rigid Cutout / Free Prop)';
      bindBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nextIdx = (bindCycle.indexOf(part.bindMode) + 1) % bindCycle.length;
        part.bindMode = bindCycle[nextIdx];
        part.dirtyMesh = true;
        showToast(`${part.name}: ${bindLabels[part.bindMode]}`);
        syncPartsUI();
        scheduleThumbRefresh();
        requestRender();
      });

      actionsRow.appendChild(bindBtn);

      if (state.parts.length > 1) {
        const delBtn = document.createElement('button');
        delBtn.className = 'tiny-icon-btn';
        delBtn.textContent = '🗑️';
        delBtn.title = 'Delete Part';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          pushHistory('Delete Part');
          state.parts = state.parts.filter((p) => p.id !== part.id);
          if (state.activePartId === part.id) {
            state.activePartId = state.parts[state.parts.length - 1].id;
          }
          syncAllUI();
          scheduleThumbRefresh();
          requestRender();
        });
        actionsRow.appendChild(delBtn);
      }

      meta.appendChild(titleRow);
      meta.appendChild(actionsRow);

      card.appendChild(thumb);
      card.appendChild(meta);

      card.addEventListener('click', () => {
        commitPendingEdits();
        state.editingBackdrop = false;
        state.activePartId = part.id;
        syncAllUI();
        requestRender();
      });

      list.appendChild(card);
    }

    const bgCard = document.getElementById('backdrop-card');
    bgCard.classList.toggle('active', state.editingBackdrop);
    drawBackdropThumb();
  }

  function drawBackdropThumb() {
    const c = document.getElementById('backdrop-thumb');
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.fillStyle = state.stageBgColor || '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    if (state.backdropVisible) {
      ctx.drawImage(state.backdropCanvas, 0, 0, c.width, c.height);
    }
  }

  function syncTimelineUI() {
    const playBtn = document.getElementById('btn-play');
    playBtn.classList.toggle('playing', state.isPlaying);
    document.getElementById('play-icon').textContent = state.isPlaying ? '⏸' : '▶';
    document.getElementById('play-label').textContent = state.isPlaying ? 'Pause' : 'Play';
    document.getElementById('chk-loop-seamless').checked = state.loopSeamless;
    document.getElementById('chk-onion').checked = state.onionSkin;

    const total = getTotalDuration();
    if (!state.isPlaying && !state.scrubPreviewPose) {
      const startT = getPoseStartTime(state.activePoseIndex);
      document.getElementById('timeline-scrubber').value = Math.round((startT / total) * 1000);
      document.getElementById('time-readout').textContent = `${startT.toFixed(2)}s / ${total.toFixed(2)}s`;
    }

    const strip = document.getElementById('poses-strip');
    strip.innerHTML = '';

    state.poses.forEach((pose, idx) => {
      // Pose Card
      const card = document.createElement('div');
      card.className = `pose-card ${idx === state.activePoseIndex && !state.isPlaying ? 'active' : ''}`;

      const thumb = document.createElement('canvas');
      thumb.width = 96;
      thumb.height = 58;
      thumb.className = 'pose-thumb';
      thumb.dataset.poseThumbIdx = idx;

      const footer = document.createElement('div');
      footer.className = 'pose-footer';

      const title = document.createElement('span');
      title.className = 'pose-title';
      title.textContent = `${idx + 1}. ${pose.name || 'Pose'}`;

      const btns = document.createElement('div');
      btns.className = 'pose-card-btns';

      const dupBtn = document.createElement('button');
      dupBtn.className = 'pose-mini-btn';
      dupBtn.textContent = '⧉';
      dupBtn.title = 'Duplicate this Pose';
      dupBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushHistory('Duplicate Pose');
        const copy = clonePose(pose, `Pose ${state.poses.length + 1}`);
        state.poses.splice(idx + 1, 0, copy);
        state.activePoseIndex = idx + 1;
        state.scrubPreviewPose = null;
        syncAllUI();
        scheduleThumbRefresh(true);
        requestRender();
      });
      btns.appendChild(dupBtn);

      if (state.poses.length > 1) {
        const delBtn = document.createElement('button');
        delBtn.className = 'pose-mini-btn';
        delBtn.textContent = '✕';
        delBtn.title = 'Delete Pose';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          pushHistory('Delete Pose');
          state.poses.splice(idx, 1);
          state.activePoseIndex = Math.min(state.activePoseIndex, state.poses.length - 1);
          state.scrubPreviewPose = null;
          syncAllUI();
          scheduleThumbRefresh(true);
          requestRender();
        });
        btns.appendChild(delBtn);
      }

      footer.appendChild(title);
      footer.appendChild(btns);
      card.appendChild(thumb);
      card.appendChild(footer);

      card.addEventListener('click', () => {
        commitPendingEdits();
        state.isPlaying = false;
        state.scrubPreviewPose = null;
        state.activePoseIndex = idx;
        if (state.mode !== 'animate') {
          setMode('animate');
        } else {
          syncAllUI();
          requestRender();
        }
      });

      strip.appendChild(card);

      // Tween Connector Bridge (between Pose i and Pose i+1, or loop-back on last pose!)
      const hasBridge = idx < state.poses.length - 1 || (state.poses.length >= 2 && state.loopSeamless);
      if (hasBridge) {
        const isLoopBack = idx === state.poses.length - 1;
        const bridge = document.createElement('div');
        bridge.className = 'tween-bridge';

        const meta = EASING_META[pose.easing] || EASING_META.smooth;
        const pill = document.createElement('button');
        pill.className = 'tween-pill-btn';
        pill.dataset.tweenPoseIdx = idx;
        pill.title = isLoopBack
          ? 'Click to customize Loop-back Tween into Pose 1!'
          : 'Click to change Tween style (Smooth / Springy / Bouncy) & speed!';
        pill.textContent = `${meta.icon} ${(pose.duration || 0.45).toFixed(2).replace(/0$/, '')}s ${isLoopBack ? '↺' : '→'}`;

        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          openTweenPopoverForPose(idx, pill);
        });

        bridge.appendChild(pill);
        strip.appendChild(bridge);
      }
    });

    // "+ Add Pose" Inviting Card
    const addCard = document.createElement('button');
    addCard.className = 'add-pose-card';
    addCard.title = 'Add a new keyframe Pose (duplicates current pose so you just move what changes!)';
    addCard.innerHTML = '<span class="add-pose-plus">＋</span><span>Add Pose</span>';
    addCard.addEventListener('click', () => {
      commitPendingEdits();
      pushHistory('Add Pose');
      const basePose = getActivePose();
      const nextPose = clonePose(basePose, `Pose ${state.poses.length + 1}`);
      state.poses.splice(state.activePoseIndex + 1, 0, nextPose);
      state.activePoseIndex += 1;
      state.isPlaying = false;
      state.scrubPreviewPose = null;
      if (state.mode !== 'animate') {
        state.mode = 'animate';
        document.body.dataset.mode = 'animate';
      }
      showToast(`✨ Pose ${state.activePoseIndex + 1} added! Drag bones or character to pose — tweening is automatic!`);
      syncAllUI();
      scheduleThumbRefresh(true);
      requestRender();
    });
    strip.appendChild(addCard);

    renderPoseThumbnails();
  }

  function openTweenPopoverForPose(poseIdx, anchorEl) {
    activePopoverPoseIdx = poseIdx;
    const pose = state.poses[poseIdx];
    if (!pose) return;
    const pop = document.getElementById('tween-popover');
    pop.classList.remove('hidden');

    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      const left = clamp(r.left + r.width * 0.5 - 124, 10, window.innerWidth - 260);
      const top = Math.max(10, r.top - pop.offsetHeight - 10);
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    }

    document.querySelectorAll('#popover-easing-btns .ease-choice').forEach((b) => {
      b.classList.toggle('active', b.dataset.ease === (pose.easing || 'smooth'));
    });
    document.querySelectorAll('#popover-dur-btns button').forEach((b) => {
      b.classList.toggle('active', Math.abs(Number(b.dataset.dur) - (pose.duration || 0.45)) < 0.03);
    });
  }

  // Offscreen full-size scratch canvas scaled down into crisp thumbnails
  const thumbScratch = createOffscreenCanvas(STAGE_W, STAGE_H);
  const thumbScratchCtx = thumbScratch.getContext('2d');

  function renderPoseThumbnails() {
    // Update Part Thumbs
    for (const part of state.parts) {
      const c = document.querySelector(`canvas[data-part-thumb-id="${part.id}"]`);
      if (c) {
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(part.canvas, 0, 0, c.width, c.height);
      }
    }
    drawBackdropThumb();

    // Update Pose Card Thumbs
    const poseCanvases = document.querySelectorAll('canvas[data-pose-thumb-idx]');
    poseCanvases.forEach((c) => {
      const idx = Number(c.dataset.poseThumbIdx);
      const pose = state.poses[idx];
      if (!pose) return;
      renderPoseToContext(thumbScratchCtx, pose);
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(thumbScratch, 0, 0, c.width, c.height);
    });
  }

  function scheduleThumbRefresh(immediate = false) {
    clearTimeout(thumbTimer);
    if (immediate) {
      renderPoseThumbnails();
    } else {
      thumbTimer = setTimeout(renderPoseThumbnails, 85);
    }
  }

  function syncAllUI() {
    syncModeButtons();
    syncColorUI();
    syncSubbarUI();
    syncPartsUI();
    syncTimelineUI();
    updateCoachBanner();
  }

  // --------------------------------------------------------------------------
  // Export GIF / WebM / PNG
  // --------------------------------------------------------------------------
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function exportAnimatedGIF() {
    commitPendingEdits();
    const labelEl = document.getElementById('export-btn-label');
    const origText = labelEl.textContent;
    labelEl.textContent = 'Encoding...';

    // Let UI paint button state before encoding
    await new Promise((r) => setTimeout(r, 30));

    try {
      const exportW = 600;
      const exportH = 390;
      const expCanvas = createOffscreenCanvas(exportW, exportH);
      const expCtx = expCanvas.getContext('2d', { willReadFrequently: true });
      const fullCanvas = createOffscreenCanvas(STAGE_W, STAGE_H);
      const fullCtx = fullCanvas.getContext('2d');

      const fps = 20;
      const delayCs = Math.round(100 / fps);
      const totalDur = getTotalDuration() / (state.playbackSpeed || 1);
      const frameCount = state.poses.length <= 1
        ? 1
        : clamp(Math.round(totalDur * fps), 6, 90);

      const framesRgba = [];
      for (let f = 0; f < frameCount; f++) {
        const t = (f / frameCount) * getTotalDuration();
        const ev = evaluatePoseAtTime(t);
        renderPoseToContext(fullCtx, ev.pose);
        expCtx.clearRect(0, 0, exportW, exportH);
        expCtx.drawImage(fullCanvas, 0, 0, exportW, exportH);
        framesRgba.push(expCtx.getImageData(0, 0, exportW, exportH).data);
      }

      const gifBlob = window.WPGif.encodeGIF(exportW, exportH, framesRgba, delayCs);
      triggerDownload(gifBlob, 'wigglepaint-animation.gif');
      showToast(`🎉 Exported animated GIF (${frameCount} frames)!`, 3200);
    } catch (err) {
      console.error(err);
      showToast('GIF export encountered an error.');
    } finally {
      labelEl.textContent = origText;
    }
  }

  function exportPNGFrame() {
    commitPendingEdits();
    const out = createOffscreenCanvas(STAGE_W, STAGE_H);
    const outCtx = out.getContext('2d');
    const pose = state.mode === 'animate' ? (state.scrubPreviewPose || getActivePose()) : null;
    renderPoseToContext(outCtx, pose, { useRestSpace: state.mode !== 'animate' });
    out.toBlob((blob) => {
      if (blob) {
        triggerDownload(blob, 'wigglepaint-frame.png');
        showToast('🖼️ Saved PNG snapshot!');
      }
    }, 'image/png');
  }

  function exportWebMVideo() {
    if (typeof MediaRecorder === 'undefined') {
      showToast('WebM recording is not supported in this browser — use Export GIF!');
      return;
    }
    commitPendingEdits();
    const recCanvas = createOffscreenCanvas(STAGE_W, STAGE_H);
    const recCtx = recCanvas.getContext('2d');
    const stream = recCanvas.captureStream(60);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_500_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      triggerDownload(blob, 'wigglepaint-video.webm');
      showToast('🎬 Exported 60fps WebM Video!');
    };

    const baseDur = getTotalDuration() / (state.playbackSpeed || 1);
    const loops = baseDur < 1.5 ? 2 : 1;
    const recordDuration = Math.min(12, baseDur * loops);

    showToast('🎬 Recording smooth 60fps clip...');
    recorder.start();
    const startTs = performance.now();

    function stepRecord(now) {
      const elapsed = (now - startTs) / 1000;
      if (elapsed >= recordDuration) {
        recorder.stop();
        return;
      }
      const animT = elapsed * (state.playbackSpeed || 1);
      const ev = evaluatePoseAtTime(animT);
      renderPoseToContext(recCtx, ev.pose);
      requestAnimationFrame(stepRecord);
    }
    requestAnimationFrame(stepRecord);
  }

  // --------------------------------------------------------------------------
  // 60FPS Render & Animation Loop
  // --------------------------------------------------------------------------
  let renderQueued = false;
  let lastFrameTs = performance.now();

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderStageAndOverlay(stageCtx, overlayCtx, uiHintState);
    });
  }

  function tickLoop(now) {
    const dt = Math.min(0.1, (now - lastFrameTs) / 1000);
    lastFrameTs = now;

    if (state.isPlaying) {
      state.playTime += dt * (state.playbackSpeed || 1);
      const ev = evaluatePoseAtTime(state.playTime);
      state.scrubPreviewPose = ev.pose;

      const scrubber = document.getElementById('timeline-scrubber');
      scrubber.value = Math.round((ev.wrappedTime / ev.totalDuration) * 1000);
      document.getElementById('time-readout').textContent =
        `${ev.wrappedTime.toFixed(2)}s / ${ev.totalDuration.toFixed(2)}s`;

      renderStageAndOverlay(stageCtx, overlayCtx, uiHintState);
    } else if (state.mode === 'draw' && state.selection) {
      // Animate marching ants on active selection
      renderStageAndOverlay(stageCtx, overlayCtx, uiHintState);
    }

    requestAnimationFrame(tickLoop);
  }

  onChange((reason) => {
    if (reason === 'color-picked') {
      syncColorUI();
    } else if (reason === 'spray-tick') {
      requestRender();
    } else if (reason === 'history-push') {
      syncModeButtons();
    } else if (reason === 'template-loaded' || reason === 'reset' || reason === 'magic-motion' || reason === 'history') {
      document.body.dataset.mode = state.mode;
      syncAllUI();
      scheduleThumbRefresh(true);
      requestRender();
    }
  });

  // Boot!
  initPalette();
  wireControls();
  fitStageToViewport();
  syncAllUI();
  requestRender();
  requestAnimationFrame(tickLoop);
})();
