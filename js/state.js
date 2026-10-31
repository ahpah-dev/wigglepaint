// ============================================================================
// WigglePaint — Central State, Parts, Skeleton, Poses & Fast Undo/Redo
// ============================================================================
(function (global) {
  'use strict';

  const { uid, getCanvasContentBounds } = global.WPUtils;

  const STAGE_W = 800;
  const STAGE_H = 520;
  const MAX_HISTORY = 30;

  function createOffscreenCanvas(w = STAGE_W, h = STAGE_H) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function cloneCanvas(src) {
    const c = createOffscreenCanvas(src.width, src.height);
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  function createDefaultPartTransform() {
    return { dx: 0, dy: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 };
  }

  function createPart(name = 'Character', bindMode = 'auto') {
    const canvas = createOffscreenCanvas();
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return {
      id: uid('part'),
      name,
      visible: true,
      bindMode, // 'auto' | 'bendy' | 'rigid' | 'none'
      rigidBoneId: null,
      canvas,
      ctx,
      bounds: null,
      mesh: null,
      dirtyMesh: true
    };
  }

  function createEmptyPose(name = 'Pose 1') {
    return {
      id: uid('pose'),
      name,
      duration: 0.45,
      easing: 'smooth',
      rootOffsets: {},    // { [jointId]: { dx, dy } }
      bonePose: {},       // { [boneId]: { dAngle, scale } }
      partTransforms: {}  // { [partId]: { dx, dy, rotation, scaleX, scaleY, opacity } }
    };
  }

  function clonePose(pose, newName) {
    return {
      id: uid('pose'),
      name: newName || pose.name,
      duration: pose.duration,
      easing: pose.easing,
      rootOffsets: JSON.parse(JSON.stringify(pose.rootOffsets || {})),
      bonePose: JSON.parse(JSON.stringify(pose.bonePose || {})),
      partTransforms: JSON.parse(JSON.stringify(pose.partTransforms || {}))
    };
  }

  const backdropCanvas = createOffscreenCanvas();
  const backdropCtx = backdropCanvas.getContext('2d', { willReadFrequently: true });

  const state = {
    stageW: STAGE_W,
    stageH: STAGE_H,
    stageBgColor: '#ffffff',

    // Modes: 'draw' | 'rig' | 'animate'
    mode: 'draw',

    // Draw tool state
    tool: 'brush', // brush | pencil | bucket | spray | eraser | line | rect | ellipse | star | select | text | eyedropper
    primaryColor: '#1e2430',
    secondaryColor: '#ff5964',
    brushSize: 8,
    brushSmoothing: true,
    smoothingStrength: 75,
    shapeFillMode: 'both', // 'outline' | 'fill' | 'both'
    bucketTolerance: 42,
    fontSize: 28,

    // Rig tool state
    rigTool: 'bone', // 'bone' | 'move' | 'pin' | 'erase'
    selectedJointId: null,
    selectedBoneId: null,
    showMeshWireframe: false,

    // Animate tool state
    animTool: 'ik', // 'ik' | 'fk' | 'transform'
    ikMode: 'limb', // 'limb' (2-bone smart) | 'chain' (to branch/root)
    stretchBones: false,
    onionSkin: true,
    loopSeamless: true,
    pingPong: false,
    playbackSpeed: 1.0,
    isPlaying: false,
    playTime: 0, // Current playback time in seconds
    scrubPreviewPose: null, // Evaluated pose while playing or scrubbing between keyframes

    // Backdrop & Parts
    editingBackdrop: false,
    backdropVisible: true,
    backdropCanvas,
    backdropCtx,
    parts: [],
    activePartId: null,

    // Active floating lasso/rect selection in Draw mode
    selection: null,
    clipboard: null, // { canvas, w, h } copied selection buffer

    // Skeleton (Rest Pose)
    joints: [], // [{ id, x, y, pinned }]
    bones: [],  // [{ id, parentJointId, childJointId, restLength, restWorldAngle, restLocalAngle }]

    // Keyframe Poses
    poses: [],
    activePoseIndex: 0,

    // Undo / Redo Stacks
    undoStack: [],
    redoStack: [],

    // UI Callbacks registered by app.js
    listeners: new Set()
  };

  function notify(reason = 'update') {
    state.listeners.forEach((fn) => fn(reason));
  }

  function onChange(fn) {
    state.listeners.add(fn);
    return () => state.listeners.delete(fn);
  }

  function getActivePart() {
    return state.parts.find((p) => p.id === state.activePartId) || state.parts[0] || null;
  }

  function getActiveDrawTarget() {
    if (state.editingBackdrop) {
      return { isBackdrop: true, canvas: state.backdropCanvas, ctx: state.backdropCtx, part: null };
    }
    const part = getActivePart();
    if (!part) return null;
    return { isBackdrop: false, canvas: part.canvas, ctx: part.ctx, part };
  }

  function getActivePose() {
    if (state.poses.length === 0) {
      state.poses.push(createEmptyPose('Pose 1'));
      state.activePoseIndex = 0;
    }
    state.activePoseIndex = Math.max(0, Math.min(state.activePoseIndex, state.poses.length - 1));
    return state.poses[state.activePoseIndex];
  }

  function ensurePartTransform(pose, partId) {
    if (!pose.partTransforms[partId]) {
      pose.partTransforms[partId] = createDefaultPartTransform();
    }
    return pose.partTransforms[partId];
  }

  function ensureBonePose(pose, boneId) {
    if (!pose.bonePose[boneId]) {
      pose.bonePose[boneId] = { dAngle: 0, scale: 1 };
    }
    return pose.bonePose[boneId];
  }

  function ensureRootOffset(pose, rootJointId) {
    if (!pose.rootOffsets[rootJointId]) {
      pose.rootOffsets[rootJointId] = { dx: 0, dy: 0 };
    }
    return pose.rootOffsets[rootJointId];
  }

  function markPartDirty(part) {
    if (!part) return;
    part.bounds = getCanvasContentBounds(part.canvas);
    part.dirtyMesh = true;
  }

  function markAllMeshesDirty() {
    for (const part of state.parts) {
      part.dirtyMesh = true;
    }
  }

  // Recompute rest lengths, topological bone order, and rest angles after skeleton changes
  function recomputeRestSkeleton() {
    const jointMap = new Map(state.joints.map((j) => [j.id, j]));
    // Remove orphan bones
    state.bones = state.bones.filter(
      (b) => jointMap.has(b.parentJointId) && jointMap.has(b.childJointId) && b.parentJointId !== b.childJointId
    );

    // Map incoming bone for each joint (tree invariant: max 1 incoming bone per joint)
    const incomingBone = new Map();
    const validBones = [];
    for (const b of state.bones) {
      if (!incomingBone.has(b.childJointId)) {
        incomingBone.set(b.childJointId, b);
        validBones.push(b);
      }
    }
    state.bones = validBones;

    // Topological sort from root joints down so parents always precede children
    const childrenByJoint = new Map();
    for (const b of state.bones) {
      if (!childrenByJoint.has(b.parentJointId)) childrenByJoint.set(b.parentJointId, []);
      childrenByJoint.get(b.parentJointId).push(b);
    }

    const roots = state.joints.filter((j) => !incomingBone.has(j.id));
    const orderedBones = [];
    const visitedBones = new Set();

    function dfs(jointId, parentWorldAngle) {
      const kids = childrenByJoint.get(jointId) || [];
      for (const bone of kids) {
        if (visitedBones.has(bone.id)) continue;
        visitedBones.add(bone.id);
        const pj = jointMap.get(bone.parentJointId);
        const cj = jointMap.get(bone.childJointId);
        const dx = cj.x - pj.x;
        const dy = cj.y - pj.y;
        bone.restLength = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        bone.restWorldAngle = Math.atan2(dy, dx);
        bone.parentBoneId = incomingBone.has( pj.id ) ? incomingBone.get(pj.id).id : null;
        bone.restLocalAngle = parentWorldAngle === null
          ? bone.restWorldAngle
          : bone.restWorldAngle - parentWorldAngle;
        orderedBones.push(bone);
        dfs(bone.childJointId, bone.restWorldAngle);
      }
    }

    for (const r of roots) {
      dfs(r.id, null);
    }
    // Catch any disconnected loop fallback just in case
    for (const b of state.bones) {
      if (!visitedBones.has(b.id)) {
        const pj = jointMap.get(b.parentJointId);
        const cj = jointMap.get(b.childJointId);
        boneFallbackInit(b, pj, cj);
        orderedBones.push(b);
      }
    }

    state.bones = orderedBones;
    markAllMeshesDirty();
  }

  function boneFallbackInit(b, pj, cj) {
    const dx = cj.x - pj.x;
    const dy = cj.y - pj.y;
    b.restLength = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    b.restWorldAngle = Math.atan2(dy, dx);
    b.parentBoneId = null;
    b.restLocalAngle = b.restWorldAngle;
  }

  // Snapshot state for instant in-memory Undo / Redo
  function captureSnapshot(label = 'Edit') {
    return {
      label,
      stageBgColor: state.stageBgColor,
      editingBackdrop: state.editingBackdrop,
      backdropVisible: state.backdropVisible,
      backdropClone: cloneCanvas(state.backdropCanvas),
      activePartId: state.activePartId,
      parts: state.parts.map((p) => ({
        id: p.id,
        name: p.name,
        visible: p.visible,
        bindMode: p.bindMode,
        rigidBoneId: p.rigidBoneId,
        bounds: p.bounds ? { ...p.bounds } : null,
        canvasClone: cloneCanvas(p.canvas)
      })),
      joints: JSON.parse(JSON.stringify(state.joints)),
      bones: JSON.parse(JSON.stringify(state.bones)),
      poses: JSON.parse(JSON.stringify(state.poses)),
      activePoseIndex: state.activePoseIndex
    };
  }

  function restoreSnapshot(snap) {
    state.selection = null;
    state.stageBgColor = snap.stageBgColor;
    state.editingBackdrop = snap.editingBackdrop;
    state.backdropVisible = snap.backdropVisible;
    state.backdropCtx.clearRect(0, 0, STAGE_W, STAGE_H);
    state.backdropCtx.drawImage(snap.backdropClone, 0, 0);

    state.parts = snap.parts.map((sp) => {
      const canvas = cloneCanvas(sp.canvasClone);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      return {
        id: sp.id,
        name: sp.name,
        visible: sp.visible,
        bindMode: sp.bindMode,
        rigidBoneId: sp.rigidBoneId,
        canvas,
        ctx,
        bounds: sp.bounds ? { ...sp.bounds } : getCanvasContentBounds(canvas),
        mesh: null,
        dirtyMesh: true
      };
    });
    state.activePartId = snap.activePartId;
    state.joints = JSON.parse(JSON.stringify(snap.joints));
    state.bones = JSON.parse(JSON.stringify(snap.bones));
    state.poses = JSON.parse(JSON.stringify(snap.poses));
    state.activePoseIndex = snap.activePoseIndex;
    state.scrubPreviewPose = null;
    recomputeRestSkeleton();
    notify('history');
  }

  function pushHistory(label = 'Action') {
    state.undoStack.push(captureSnapshot(label));
    if (state.undoStack.length > MAX_HISTORY) {
      state.undoStack.shift();
    }
    state.redoStack.length = 0;
    notify('history-push');
  }

  function undo() {
    if (state.undoStack.length === 0) return false;
    state.redoStack.push(captureSnapshot('Redo'));
    const prev = state.undoStack.pop();
    restoreSnapshot(prev);
    return true;
  }

  function redo() {
    if (state.redoStack.length === 0) return false;
    state.undoStack.push(captureSnapshot('Undo'));
    const next = state.redoStack.pop();
    restoreSnapshot(next);
    return true;
  }

  function resetProject() {
    state.isPlaying = false;
    state.selection = null;
    state.stageBgColor = '#ffffff';
    state.editingBackdrop = false;
    state.backdropVisible = true;
    state.backdropCtx.clearRect(0, 0, STAGE_W, STAGE_H);

    const firstPart = createPart('Character', 'auto');
    state.parts = [firstPart];
    state.activePartId = firstPart.id;

    state.joints = [];
    state.bones = [];
    state.selectedJointId = null;
    state.selectedBoneId = null;

    state.poses = [createEmptyPose('Pose 1')];
    state.activePoseIndex = 0;
    state.playTime = 0;
    state.scrubPreviewPose = null;

    state.undoStack = [];
    state.redoStack = [];
    notify('reset');
  }

  // Initialize default blank state immediately
  resetProject();

  // Export / Import project JSON (for Save & Load)
  function serializeProject() {
    return JSON.stringify({
      version: 1,
      stageW: state.stageW,
      stageH: state.stageH,
      stageBgColor: state.stageBgColor,
      backdropVisible: state.backdropVisible,
      backdropDataUrl: state.backdropCanvas.toDataURL('image/png'),
      parts: state.parts.map((p) => ({
        id: p.id,
        name: p.name,
        visible: p.visible,
        bindMode: p.bindMode,
        rigidBoneId: p.rigidBoneId,
        dataUrl: p.canvas.toDataURL('image/png')
      })),
      activePartId: state.activePartId,
      joints: state.joints,
      bones: state.bones,
      poses: state.poses,
      loopSeamless: state.loopSeamless,
      pingPong: state.pingPong,
      playbackSpeed: state.playbackSpeed
    });
  }

  async function deserializeProject(jsonStr) {
    const data = JSON.parse(jsonStr);
    const loadImg = (src) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });

    state.isPlaying = false;
    state.selection = null;
    state.stageBgColor = data.stageBgColor || '#ffffff';
    state.backdropVisible = data.backdropVisible !== false;
    state.backdropCtx.clearRect(0, 0, STAGE_W, STAGE_H);
    if (data.backdropDataUrl) {
      const bgImg = await loadImg(data.backdropDataUrl);
      state.backdropCtx.drawImage(bgImg, 0, 0);
    }

    const loadedParts = [];
    for (const sp of data.parts || []) {
      const part = createPart(sp.name || 'Part', sp.bindMode || 'auto');
      part.id = sp.id || part.id;
      part.visible = sp.visible !== false;
      part.rigidBoneId = sp.rigidBoneId || null;
      if (sp.dataUrl) {
        const img = await loadImg(sp.dataUrl);
        part.ctx.drawImage(img, 0, 0);
      }
      markPartDirty(part);
      loadedParts.push(part);
    }
    state.parts = loadedParts.length > 0 ? loadedParts : [createPart('Character', 'auto')];
    state.activePartId = data.activePartId || state.parts[0].id;
    state.joints = data.joints || [];
    state.bones = data.bones || [];
    state.poses = data.poses && data.poses.length > 0 ? data.poses : [createEmptyPose('Pose 1')];
    state.activePoseIndex = 0;
    state.loopSeamless = data.loopSeamless !== false;
    state.pingPong = !!data.pingPong;
    state.playbackSpeed = data.playbackSpeed || 1.0;
    state.undoStack = [];
    state.redoStack = [];
    recomputeRestSkeleton();
    notify('reset');
  }

  global.WPState = {
    STAGE_W,
    STAGE_H,
    state,
    createOffscreenCanvas,
    cloneCanvas,
    createDefaultPartTransform,
    createPart,
    createEmptyPose,
    clonePose,
    onChange,
    notify,
    getActivePart,
    getActiveDrawTarget,
    getActivePose,
    ensurePartTransform,
    ensureBonePose,
    ensureRootOffset,
    markPartDirty,
    markAllMeshesDirty,
    recomputeRestSkeleton,
    pushHistory,
    undo,
    redo,
    resetProject,
    serializeProject,
    deserializeProject
  };
})(window);
