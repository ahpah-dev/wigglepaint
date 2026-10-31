// ============================================================================
// WigglePaint — Easy Rigging, Geodesic Auto-Skinning, 2D DQS & Smart IK/FK
// ============================================================================
(function (global) {
  'use strict';

  const { clamp, shortAngleDiff, dist, pointToSegment, uid } = global.WPUtils;
  const {
    STAGE_W,
    STAGE_H,
    state,
    ensureBonePose,
    ensureRootOffset,
    recomputeRestSkeleton,
    markAllMeshesDirty
  } = global.WPState;

  const CELL_SIZE = 14;
  const AUTO_BIND_MAX_DIST = 54;

  // --------------------------------------------------------------------------
  // Forward Kinematics (Rest or Posed)
  // --------------------------------------------------------------------------
  function solveForwardKinematics(pose) {
    const jointMap = new Map();
    for (const j of state.joints) jointMap.set(j.id, j);

    const incoming = new Set();
    for (const b of state.bones) incoming.add(b.childJointId);

    const jointPositions = new Map();
    for (const j of state.joints) {
      if (!incoming.has(j.id)) {
        const off = (pose && pose.rootOffsets && pose.rootOffsets[j.id]) || { dx: 0, dy: 0 };
        jointPositions.set(j.id, {
          x: j.x + (off.dx || 0),
          y: j.y + (off.dy || 0),
          restX: j.x,
          restY: j.y,
          isRoot: true,
          pinned: !!j.pinned
        });
      }
    }

    const boneTransforms = new Map();
    for (const b of state.bones) {
      let pPos = jointPositions.get(b.parentJointId);
      const restP = jointMap.get(b.parentJointId);
      const restC = jointMap.get(b.childJointId);
      if (!restP || !restC) continue;

      if (!pPos) {
        pPos = { x: restP.x, y: restP.y, restX: restP.x, restY: restP.y, isRoot: true, pinned: !!restP.pinned };
        jointPositions.set(b.parentJointId, pPos);
      }

      const parentBt = b.parentBoneId ? boneTransforms.get(b.parentBoneId) : null;
      const bp = (pose && pose.bonePose && pose.bonePose[b.id]) || { dAngle: 0, scale: 1 };
      const baseAngle = parentBt ? parentBt.worldAngle + b.restLocalAngle : b.restLocalAngle;
      const worldAngle = baseAngle + (bp.dAngle || 0);
      const scale = bp.scale !== undefined ? bp.scale : 1;
      const len = b.restLength * scale;

      const bx = pPos.x + Math.cos(worldAngle) * len;
      const by = pPos.y + Math.sin(worldAngle) * len;

      jointPositions.set(b.childJointId, {
        x: bx,
        y: by,
        restX: restC.x,
        restY: restC.y,
        isRoot: false,
        pinned: !!restC.pinned
      });

      boneTransforms.set(b.id, {
        id: b.id,
        parentJointId: b.parentJointId,
        childJointId: b.childJointId,
        ax: pPos.x,
        ay: pPos.y,
        bx,
        by,
        restAx: restP.x,
        restAy: restP.y,
        restBx: restC.x,
        restBy: restC.y,
        worldAngle,
        restWorldAngle: b.restWorldAngle,
        dPhi: worldAngle - b.restWorldAngle,
        scale
      });
    }

    return { jointPositions, boneTransforms };
  }

  // --------------------------------------------------------------------------
  // Hit-Testing Joints & Bones (works in Rest Space or Posed Space)
  // --------------------------------------------------------------------------
  function findJointAt(x, y, pose = null, radius = 15) {
    const fk = solveForwardKinematics(pose);
    let best = null;
    let bestD = radius;
    for (const j of state.joints) {
      const pos = fk.jointPositions.get(j.id) || j;
      const d = dist(x, y, pos.x, pos.y);
      if (d <= bestD) {
        bestD = d;
        best = { joint: j, x: pos.x, y: pos.y, isRoot: !!pos.isRoot, dist: d };
      }
    }
    return best;
  }

  function findBoneAt(x, y, pose = null, maxDist = 12) {
    const fk = solveForwardKinematics(pose);
    let best = null;
    let bestD = maxDist;
    for (const b of state.bones) {
      const bt = fk.boneTransforms.get(b.id);
      if (!bt) continue;
      const seg = pointToSegment(x, y, bt.ax, bt.ay, bt.bx, bt.by);
      // Prefer interior of bone shaft so joints still win near endpoints
      if (seg.dist <= bestD) {
        bestD = seg.dist;
        best = { bone: b, bt, t: seg.t, dist: seg.dist };
      }
    }
    return best;
  }

  // --------------------------------------------------------------------------
  // Adding, Moving, and Deleting Bones in Rig Mode
  // --------------------------------------------------------------------------
  function isDescendantJoint(candidateDescendantId, ancestorJointId) {
    if (candidateDescendantId === ancestorJointId) return true;
    const queue = [ancestorJointId];
    const seen = new Set([ancestorJointId]);
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const b of state.bones) {
        if (b.parentJointId === cur && !seen.has(b.childJointId)) {
          if (b.childJointId === candidateDescendantId) return true;
          seen.add(b.childJointId);
          queue.push(b.childJointId);
        }
      }
    }
    return false;
  }

  function addBone(x1, y1, x2, y2, snapRadius = 18) {
    if (dist(x1, y1, x2, y2) < 10) return null;

    const hitStart = findJointAt(x1, y1, null, snapRadius);
    let startJoint = hitStart ? hitStart.joint : null;
    if (!startJoint) {
      startJoint = {
        id: uid('jnt'),
        x: clamp(x1, 4, STAGE_W - 4),
        y: clamp(y1, 4, STAGE_H - 4),
        pinned: false
      };
      state.joints.push(startJoint);
    }

    // Check if end snaps to an existing root joint without creating a cycle
    const hitEnd = findJointAt(x2, y2, null, snapRadius);
    let endJoint = null;
    if (hitEnd && hitEnd.joint.id !== startJoint.id) {
      const hasIncoming = state.bones.some((b) => b.childJointId === hitEnd.joint.id);
      if (!hasIncoming && !isDescendantJoint(startJoint.id, hitEnd.joint.id)) {
        endJoint = hitEnd.joint;
      }
    }

    if (!endJoint) {
      endJoint = {
        id: uid('jnt'),
        x: clamp(x2, 4, STAGE_W - 4),
        y: clamp(y2, 4, STAGE_H - 4),
        pinned: false
      };
      state.joints.push(endJoint);
    }

    const bone = {
      id: uid('bone'),
      parentJointId: startJoint.id,
      childJointId: endJoint.id,
      restLength: dist(startJoint.x, startJoint.y, endJoint.x, endJoint.y),
      restWorldAngle: 0,
      restLocalAngle: 0
    };
    state.bones.push(bone);
    recomputeRestSkeleton();
    return { bone, startJoint, endJoint };
  }

  function deleteBone(boneId) {
    state.bones = state.bones.filter((b) => b.id !== boneId);
    pruneOrphanJoints();
    recomputeRestSkeleton();
  }

  function deleteJoint(jointId) {
    state.bones = state.bones.filter((b) => b.parentJointId !== jointId && b.childJointId !== jointId);
    state.joints = state.joints.filter((j) => j.id !== jointId);
    pruneOrphanJoints();
    recomputeRestSkeleton();
  }

  function pruneOrphanJoints() {
    if (state.bones.length === 0) {
      state.joints = [];
      return;
    }
    const used = new Set();
    for (const b of state.bones) {
      used.add(b.parentJointId);
      used.add(b.childJointId);
    }
    state.joints = state.joints.filter((j) => used.has(j.id));
  }

  // --------------------------------------------------------------------------
  // 1-Click Auto-Skeleton Stamps (Scaled to Drawing Content Bounds!)
  // --------------------------------------------------------------------------
  function getCombinedDrawingBounds() {
    let minX = STAGE_W, minY = STAGE_H, maxX = 0, maxY = 0;
    let found = false;
    for (const p of state.parts) {
      if (!p.visible || !p.bounds) continue;
      found = true;
      minX = Math.min(minX, p.bounds.x);
      minY = Math.min(minY, p.bounds.y);
      maxX = Math.max(maxX, p.bounds.x + p.bounds.w);
      maxY = Math.max(maxY, p.bounds.y + p.bounds.h);
    }
    if (!found || maxX - minX < 30 || maxY - minY < 30) {
      return { cx: STAGE_W / 2, cy: STAGE_H / 2 + 10, w: 180, h: 260, top: STAGE_H / 2 - 120, bottom: STAGE_H / 2 + 140 };
    }
    const w = Math.max(80, maxX - minX);
    const h = Math.max(100, maxY - minY);
    return {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      w,
      h,
      top: minY,
      bottom: maxY
    };
  }

  function stampSkeleton(kind = 'biped') {
    state.joints = [];
    state.bones = [];
    for (const pose of state.poses) {
      pose.bonePose = {};
      pose.rootOffsets = {};
    }

    const b = getCombinedDrawingBounds();
    const cx = b.cx;
    const top = b.top;
    const h = b.h;
    const w = b.w;

    function mkJoint(x, y, pinned = false) {
      const j = { id: uid('jnt'), x: Math.round(x), y: Math.round(y), pinned };
      state.joints.push(j);
      return j;
    }
    function link(j1, j2) {
      state.bones.push({
        id: uid('bone'),
        parentJointId: j1.id,
        childJointId: j2.id,
        restLength: dist(j1.x, j1.y, j2.x, j2.y),
        restWorldAngle: 0,
        restLocalAngle: 0
      });
    }

    if (kind === 'biped') {
      const pelvis = mkJoint(cx, top + h * 0.56);
      const chest = mkJoint(cx, top + h * 0.34);
      const head = mkJoint(cx, top + h * 0.12);

      const shoulderOffset = Math.min(w * 0.16, 40);
      const armSpan = Math.max(shoulderOffset + 32, Math.min(w * 0.44, h * 0.46));
      const lShoulder = mkJoint(cx - shoulderOffset, top + h * 0.35, true);
      const lElbow = mkJoint(cx - armSpan * 0.62, top + h * 0.40);
      const lHand = mkJoint(cx - armSpan, top + h * 0.45);

      const rShoulder = mkJoint(cx + shoulderOffset, top + h * 0.35, true);
      const rElbow = mkJoint(cx + armSpan * 0.62, top + h * 0.40);
      const rHand = mkJoint(cx + armSpan, top + h * 0.45);

      const legSpread = Math.min(w * 0.18, 34);
      const lHip = mkJoint(cx - legSpread * 0.85, top + h * 0.58, true);
      const lKnee = mkJoint(cx - legSpread, top + h * 0.76);
      const lFoot = mkJoint(cx - legSpread * 1.08, top + h * 0.93);

      const rHip = mkJoint(cx + legSpread * 0.85, top + h * 0.58, true);
      const rKnee = mkJoint(cx + legSpread, top + h * 0.76);
      const rFoot = mkJoint(cx + legSpread * 1.08, top + h * 0.93);

      link(pelvis, chest);
      link(chest, head);
      link(chest, lShoulder);
      link(lShoulder, lElbow);
      link(lElbow, lHand);
      link(chest, rShoulder);
      link(rShoulder, rElbow);
      link(rElbow, rHand);
      link(pelvis, lHip);
      link(lHip, lKnee);
      link(lKnee, lFoot);
      link(pelvis, rHip);
      link(rHip, rKnee);
      link(rKnee, rFoot);
    } else if (kind === 'bounce_spine') {
      // Great for blobs, trees, slimes, bouncing characters, tails!
      const base = mkJoint(cx, top + h * 0.88);
      const mid1 = mkJoint(cx, top + h * 0.64);
      const mid2 = mkJoint(cx, top + h * 0.38);
      const tip = mkJoint(cx, top + h * 0.12);
      link(base, mid1);
      link(mid1, mid2);
      link(mid2, tip);
    } else if (kind === 'quad') {
      // Cute 4-legged pet / dino stamp
      const hip = mkJoint(cx - w * 0.16, top + h * 0.52);
      const shoulder = mkJoint(cx + w * 0.14, top + h * 0.46);
      const head = mkJoint(cx + w * 0.34, top + h * 0.22);
      const tailMid = mkJoint(cx - w * 0.32, top + h * 0.48);
      const tailTip = mkJoint(cx - w * 0.45, top + h * 0.38);
      const bFoot = mkJoint(cx - w * 0.18, top + h * 0.90);
      const fFoot = mkJoint(cx + w * 0.16, top + h * 0.90);

      link(hip, shoulder);
      link(shoulder, head);
      link(hip, tailMid);
      link(tailMid, tailTip);
      link(hip, bFoot);
      link(shoulder, fFoot);
    }

    recomputeRestSkeleton();
  }

  // --------------------------------------------------------------------------
  // Smart Inverse Kinematics (Damped CCD) & Forward Kinematics Solvers
  // --------------------------------------------------------------------------
  function solveIKDrag(pose, targetJointId, mouseX, mouseY, options = {}) {
    const incomingByChild = new Map();
    const outgoingCount = new Map();
    for (const b of state.bones) {
      incomingByChild.set(b.childJointId, b);
      outgoingCount.set(b.parentJointId, (outgoingCount.get(b.parentJointId) || 0) + 1);
    }

    const jointMap = new Map(state.joints.map((j) => [j.id, j]));
    const targetJoint = jointMap.get(targetJointId);
    if (!targetJoint) return;

    // 1. Dragging a Root Joint translates that whole skeleton!
    if (!incomingByChild.has(targetJointId)) {
      const ro = ensureRootOffset(pose, targetJointId);
      ro.dx = mouseX - targetJoint.x;
      ro.dy = mouseY - targetJoint.y;
      return;
    }

    // 2. Build ancestor bone chain for Smart IK
    const fullChain = options.fullChain || state.ikMode === 'chain';
    const maxBones = fullChain ? 6 : 2;
    const chain = []; // ordered from tip bone up to base bone
    let curJointId = targetJointId;

    while (chain.length < maxBones) {
      const incBone = incomingByChild.get(curJointId);
      if (!incBone) break;
      chain.push(incBone);
      const parentJoint = jointMap.get(incBone.parentJointId);
      if (!parentJoint) break;
      // Stop at pinned joints or branching hubs (like chest/pelvis) unless fullChain is requested
      if (parentJoint.pinned) break;
      if (!fullChain && (outgoingCount.get(parentJoint.id) || 0) > 1) break;
      curJointId = parentJoint.id;
    }

    if (chain.length === 0) return;

    // 3. Damped CCD iterations
    const iterations = chain.length === 1 ? 1 : 18;
    for (let iter = 0; iter < iterations; iter++) {
      const fk = solveForwardKinematics(pose);
      const endPos = fk.jointPositions.get(targetJointId);
      if (!endPos) break;
      if (dist(endPos.x, endPos.y, mouseX, mouseY) < 0.5) break;

      for (let i = 0; i < chain.length; i++) {
        const bone = chain[i];
        const fkStep = i === 0 ? fk : solveForwardKinematics(pose);
        const eff = fkStep.jointPositions.get(targetJointId);
        const piv = fkStep.jointPositions.get(bone.parentJointId);
        if (!eff || !piv) continue;

        const curAng = Math.atan2(eff.y - piv.y, eff.x - piv.x);
        const dstAng = Math.atan2(mouseY - piv.y, mouseX - piv.x);
        let diff = shortAngleDiff(curAng, dstAng);

        if (chain.length > 1) {
          diff = clamp(diff * 0.72, -0.38, 0.38);
        }

        const bp = ensureBonePose(pose, bone.id);
        bp.dAngle = shortAngleDiff(0, (bp.dAngle || 0) + diff);
      }
    }

    // 4. Optional Rubber-Hose Stretch if enabled
    if (options.stretch || state.stretchBones) {
      const fkFinal = solveForwardKinematics(pose);
      const tipBone = chain[0];
      const piv = fkFinal.jointPositions.get(tipBone.parentJointId);
      if (piv) {
        const d = dist(piv.x, piv.y, mouseX, mouseY);
        const bp = ensureBonePose(pose, tipBone.id);
        if (chain.length === 1) {
          bp.scale = clamp(d / tipBone.restLength, 0.35, 2.4);
        } else {
          const basePiv = fkFinal.jointPositions.get(chain[chain.length - 1].parentJointId);
          const totalRest = chain.reduce((acc, b) => acc + b.restLength, 0);
          const totalDist = basePiv ? dist(basePiv.x, basePiv.y, mouseX, mouseY) : totalRest;
          if (totalDist > totalRest) {
            const stretchRatio = clamp(totalDist / totalRest, 1, 2.1);
            for (const b of chain) {
              ensureBonePose(pose, b.id).scale = stretchRatio;
            }
          } else {
            for (const b of chain) {
              ensureBonePose(pose, b.id).scale = 1;
            }
          }
        }
      }
    }
  }

  function rotateBoneFK(pose, boneId, targetWorldAngle) {
    const fk = solveForwardKinematics(pose);
    const bt = fk.boneTransforms.get(boneId);
    if (!bt) return;
    const bone = state.bones.find((b) => b.id === boneId);
    if (!bone) return;
    const parentBt = bone.parentBoneId ? fk.boneTransforms.get(bone.parentBoneId) : null;
    const baseAngle = parentBt ? parentBt.worldAngle + bone.restLocalAngle : bone.restLocalAngle;
    const bp = ensureBonePose(pose, boneId);
    bp.dAngle = shortAngleDiff(baseAngle, targetWorldAngle);
  }

  // --------------------------------------------------------------------------
  // Geodesic + Euclidean Auto-Skinning Mesh Builder
  // --------------------------------------------------------------------------
  function ensurePartMesh(part) {
    if (!part.dirtyMesh && part.mesh) return part.mesh;
    part.dirtyMesh = false;

    if (state.bones.length === 0 || part.bindMode === 'none' || !part.bounds) {
      part.mesh = { bound: false };
      return part.mesh;
    }

    const jointMap = new Map(state.joints.map((j) => [j.id, j]));
    const restBones = state.bones.map((b) => {
      const p = jointMap.get(b.parentJointId);
      const c = jointMap.get(b.childJointId);
      return { id: b.id, ax: p.x, ay: p.y, bx: c.x, by: c.y };
    });

    // Rigid Single-Bone Mode (for crisp cut-out props/limbs)
    if (part.bindMode === 'rigid') {
      let chosenBoneId = part.rigidBoneId;
      if (!chosenBoneId || !state.bones.some((b) => b.id === chosenBoneId)) {
        // Auto-pick closest bone to Part center
        let bestD = Infinity;
        for (const rb of restBones) {
          const d = pointToSegment(part.bounds.cx, part.bounds.cy, rb.ax, rb.ay, rb.bx, rb.by).dist;
          if (d < bestD) {
            bestD = d;
            chosenBoneId = rb.id;
          }
        }
      }
      part.mesh = { bound: !!chosenBoneId, mode: 'rigid', rigidBoneId: chosenBoneId };
      return part.mesh;
    }

    // Scan alpha map to locate occupied cells
    const cols = Math.ceil(STAGE_W / CELL_SIZE);
    const rows = Math.ceil(STAGE_H / CELL_SIZE);
    const imgData = part.ctx.getImageData(0, 0, STAGE_W, STAGE_H).data;

    const rawOccupied = new Uint8Array(cols * rows);
    const padX0 = Math.max(0, Math.floor((part.bounds.x - 2) / CELL_SIZE));
    const padY0 = Math.max(0, Math.floor((part.bounds.y - 2) / CELL_SIZE));
    const padX1 = Math.min(cols - 1, Math.floor((part.bounds.x + part.bounds.w + 2) / CELL_SIZE));
    const padY1 = Math.min(rows - 1, Math.floor((part.bounds.y + part.bounds.h + 2) / CELL_SIZE));

    for (let gy = padY0; gy <= padY1; gy++) {
      const yStart = gy * CELL_SIZE;
      const yEnd = Math.min(STAGE_H, yStart + CELL_SIZE);
      for (let gx = padX0; gx <= padX1; gx++) {
        const xStart = gx * CELL_SIZE;
        const xEnd = Math.min(STAGE_W, xStart + CELL_SIZE);
        let hasAlpha = 0;
        for (let py = yStart; py < yEnd && !hasAlpha; py += 2) {
          const rowOff = py * STAGE_W;
          for (let px = xStart; px < xEnd; px += 2) {
            if (imgData[(rowOff + px) * 4 + 3] > 6) {
              hasAlpha = 1;
              break;
            }
          }
        }
        // Fallback fine check if coarse 2px check missed a 1px pencil stroke
        if (!hasAlpha) {
          for (let py = yStart + 1; py < yEnd && !hasAlpha; py += 2) {
            const rowOff = py * STAGE_W;
            for (let px = xStart + 1; px < xEnd; px += 2) {
              if (imgData[(rowOff + px) * 4 + 3] > 6) {
                hasAlpha = 1;
                break;
              }
            }
          }
        }
        rawOccupied[gy * cols + gx] = hasAlpha;
      }
    }

    // Dilate occupied cells by 1 cell in 8-neighborhood so strokes never clip at cell boundaries
    const activeCell = new Uint8Array(cols * rows);
    let minBoneDist = Infinity;

    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        if (!rawOccupied[gy * cols + gx]) continue;
        const cx = (gx + 0.5) * CELL_SIZE;
        const cy = (gy + 0.5) * CELL_SIZE;
        for (const rb of restBones) {
          const d = pointToSegment(cx, cy, rb.ax, rb.ay, rb.bx, rb.by).dist;
          if (d < minBoneDist) minBoneDist = d;
        }
        for (let dy = -1; dy <= 1; dy++) {
          const ny = gy + dy;
          if (ny < 0 || ny >= rows) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = gx + dx;
            if (nx < 0 || nx >= cols) continue;
            activeCell[ny * cols + nx] = 1;
          }
        }
      }
    }

    // In 'auto' mode, keep distant independent drawings unbound so they don't warp with another character's rig!
    if (part.bindMode === 'auto' && minBoneDist > AUTO_BIND_MAX_DIST) {
      part.mesh = { bound: false };
      return part.mesh;
    }

    // Geodesic distance per bone across activeCell graph (prevents arm bones pulling torso/legs across air gaps!)
    const numBones = restBones.length;
    const totalCells = cols * rows;
    const geoDist = new Float32Array(numBones * totalCells);
    geoDist.fill(1e6);

    const neighbors = [
      [-1, 0, CELL_SIZE],
      [1, 0, CELL_SIZE],
      [0, -1, CELL_SIZE],
      [0, 1, CELL_SIZE],
      [-1, -1, CELL_SIZE * 1.4142],
      [1, -1, CELL_SIZE * 1.4142],
      [-1, 1, CELL_SIZE * 1.4142],
      [1, 1, CELL_SIZE * 1.4142]
    ];

    for (let bIdx = 0; bIdx < numBones; bIdx++) {
      const rb = restBones[bIdx];
      const baseOff = bIdx * totalCells;
      const queue = [];

      for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          const cIdx = gy * cols + gx;
          if (!activeCell[cIdx]) continue;
          const cx = (gx + 0.5) * CELL_SIZE;
          const cy = (gy + 0.5) * CELL_SIZE;
          const d = pointToSegment(cx, cy, rb.ax, rb.ay, rb.bx, rb.by).dist;
          if (d <= CELL_SIZE * 1.15) {
            geoDist[baseOff + cIdx] = d;
            queue.push(cIdx);
          }
        }
      }

      // Fast Shortest-Path Faster / BFS relaxation over tiny active cell graph (~250 cells)
      let head = 0;
      while (head < queue.length) {
        const u = queue[head++];
        const ux = u % cols;
        const uy = (u / cols) | 0;
        const curD = geoDist[baseOff + u];

        for (let n = 0; n < 8; n++) {
          const nx = ux + neighbors[n][0];
          const ny = uy + neighbors[n][1];
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const v = ny * cols + nx;
          if (!activeCell[v]) continue;
          const nd = curD + neighbors[n][2];
          if (nd + 0.01 < geoDist[baseOff + v]) {
            geoDist[baseOff + v] = nd;
            queue.push(v);
          }
        }
      }
    }

    // Create unique mesh vertices at grid corners of active cells
    const vCols = cols + 1;
    const vRows = rows + 1;
    const vertIndexMap = new Int32Array(vCols * vRows);
    vertIndexMap.fill(-1);
    const vertices = [];
    const triangles = [];

    function getOrCreateVertex(vx, vy) {
      const key = vy * vCols + vx;
      if (vertIndexMap[key] !== -1) return vertIndexMap[key];

      const u = Math.min(STAGE_W, vx * CELL_SIZE);
      const v = Math.min(STAGE_H, vy * CELL_SIZE);

      // Gather min geodesic distance from up to 4 surrounding cells
      const boneDists = new Float32Array(numBones);
      boneDists.fill(1e6);
      let anyGeoReachable = false;

      for (let cy = vy - 1; cy <= vy; cy++) {
        if (cy < 0 || cy >= rows) continue;
        for (let cx = vx - 1; cx <= vx; cx++) {
          if (cx < 0 || cx >= cols) continue;
          const cIdx = cy * cols + cx;
          if (!activeCell[cIdx]) continue;
          for (let bIdx = 0; bIdx < numBones; bIdx++) {
            const gd = geoDist[bIdx * totalCells + cIdx];
            if (gd < boneDists[bIdx]) {
              boneDists[bIdx] = gd;
              if (gd < 1e5) anyGeoReachable = true;
            }
          }
        }
      }

      // Compute smooth bone weights (blend exact Euclidean segment distance when geodesically connected,
      // or pure Euclidean fallback for floating details like hats/eyebrows!)
      const weights = [];
      for (let bIdx = 0; bIdx < numBones; bIdx++) {
        const rb = restBones[bIdx];
        const euc = pointToSegment(u, v, rb.ax, rb.ay, rb.bx, rb.by).dist;
        let effectiveDist;
        if (anyGeoReachable) {
          if (boneDists[bIdx] >= 1e5) continue; // Disconnected island — ignore unreachable bone!
          // Combine exact Euclidean smoothness near joints with Geodesic separation across gaps
          effectiveDist = euc * 0.45 + boneDists[bIdx] * 0.55;
        } else {
          effectiveDist = euc;
        }
        const w = 1 / Math.pow(effectiveDist + 7.5, 2.75);
        weights.push({ bIdx, boneId: rb.id, w });
      }

      weights.sort((a, b) => b.w - a.w);
      const top = weights.slice(0, 3);
      let sum = 0;
      for (const item of top) sum += item.w;
      if (sum <= 0) {
        top.push({ bIdx: 0, boneId: restBones[0].id, w: 1 });
        sum = 1;
      }
      for (const item of top) item.w /= sum;

      const idx = vertices.length;
      vertices.push({
        u,
        v,
        x: u,
        y: v,
        weights: top,
        neighbors: []
      });
      vertIndexMap[key] = idx;
      return idx;
    }

    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        if (!activeCell[gy * cols + gx]) continue;
        const i00 = getOrCreateVertex(gx, gy);
        const i10 = getOrCreateVertex(gx + 1, gy);
        const i01 = getOrCreateVertex(gx, gy + 1);
        const i11 = getOrCreateVertex(gx + 1, gy + 1);

        // Source patch bounds in texture space (padded by 2px for clean sub-rect sampling)
        const sx = Math.max(0, gx * CELL_SIZE - 2);
        const sy = Math.max(0, gy * CELL_SIZE - 2);
        const sw = Math.min(STAGE_W - sx, CELL_SIZE + 4);
        const sh = Math.min(STAGE_H - sy, CELL_SIZE + 4);

        if ((gx + gy) % 2 === 0) {
          triangles.push({ a: i00, b: i10, c: i11, sx, sy, sw, sh });
          triangles.push({ a: i00, b: i11, c: i01, sx, sy, sw, sh });
        } else {
          triangles.push({ a: i00, b: i10, c: i01, sx, sy, sw, sh });
          triangles.push({ a: i10, b: i11, c: i01, sx, sy, sw, sh });
        }
      }
    }

    // 1-pass Laplacian weight smoothing across triangle edges for silky joint bends
    const adj = Array.from({ length: vertices.length }, () => new Set());
    for (const tri of triangles) {
      adj[tri.a].add(tri.b); adj[tri.a].add(tri.c);
      adj[tri.b].add(tri.a); adj[tri.b].add(tri.c);
      adj[tri.c].add(tri.a); adj[tri.c].add(tri.b);
    }

    const smoothedWeights = vertices.map((vert, idx) => {
      const accum = new Map();
      for (const bw of vert.weights) {
        accum.set(bw.boneId, (accum.get(bw.boneId) || 0) + bw.w * 0.6);
      }
      const nbrs = Array.from(adj[idx]);
      if (nbrs.length > 0) {
        const share = 0.4 / nbrs.length;
        for (const nIdx of nbrs) {
          for (const bw of vertices[nIdx].weights) {
            accum.set(bw.boneId, (accum.get(bw.boneId) || 0) + bw.w * share);
          }
        }
      }
      const arr = Array.from(accum.entries()).map(([boneId, w]) => ({ boneId, w }));
      arr.sort((a, b) => b.w - a.w);
      const top = arr.slice(0, 3);
      let s = 0;
      for (const t of top) s += t.w;
      for (const t of top) t.w /= s || 1;
      return top;
    });

    for (let i = 0; i < vertices.length; i++) {
      vertices[i].weights = smoothedWeights[i];
    }

    part.mesh = {
      bound: triangles.length > 0,
      mode: 'bendy',
      cellSize: CELL_SIZE,
      vertices,
      triangles
    };
    return part.mesh;
  }

  // --------------------------------------------------------------------------
  // 2D Dual Quaternion Skinning (2D DQS) — Volume-Preserving Joint Bends!
  // --------------------------------------------------------------------------
  function deformPartVertices(mesh, fk) {
    // Precompute 2D dual-quaternion + affine params for each bone
    const boneDQ = new Map();
    for (const [boneId, bt] of fk.boneTransforms.entries()) {
      const phi = bt.dPhi;
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);
      // Point mapping: x' = ax + scale * R(phi) * (x - restAx)
      const sc = bt.scale;
      const tx = bt.ax - (cosPhi * bt.restAx - sinPhi * bt.restAy) * sc;
      const ty = bt.ay - (sinPhi * bt.restAx + cosPhi * bt.restAy) * sc;

      const c = Math.cos(phi * 0.5);
      const s = Math.sin(phi * 0.5);
      const dx = 0.5 * (tx * c + ty * s);
      const dy = 0.5 * (ty * c - tx * s);

      boneDQ.set(boneId, { c, s, dx, dy, cosPhi, sinPhi, tx, ty, sc });
    }

    const verts = mesh.vertices;
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      const ws = v.weights;

      if (ws.length === 1) {
        const dq = boneDQ.get(ws[0].boneId);
        if (!dq) { v.x = v.u; v.y = v.v; continue; }
        v.x = (dq.cosPhi * v.u - dq.sinPhi * v.v) * dq.sc + dq.tx;
        v.y = (dq.sinPhi * v.u + dq.cosPhi * v.v) * dq.sc + dq.ty;
        continue;
      }

      let C = 0, S = 0, DX = 0, DY = 0;
      let refC = 0, refS = 0;
      let hasStretch = false;

      for (let k = 0; k < ws.length; k++) {
        const w = ws[k].w;
        const dq = boneDQ.get(ws[k].boneId);
        if (!dq) continue;
        if (Math.abs(dq.sc - 1) > 0.01) hasStretch = true;

        let sign = 1;
        if (k === 0) {
          refC = dq.c;
          refS = dq.s;
        } else if (refC * dq.c + refS * dq.s < 0) {
          sign = -1;
        }

        const sw = w * sign;
        C += sw * dq.c;
        S += sw * dq.s;
        DX += sw * dq.dx;
        DY += sw * dq.dy;
      }

      if (hasStretch) {
        // Linear blend skinning when stretching rubber-hose limbs
        let lx = 0, ly = 0;
        for (let k = 0; k < ws.length; k++) {
          const w = ws[k].w;
          const dq = boneDQ.get(ws[k].boneId);
          if (!dq) continue;
          lx += w * ((dq.cosPhi * v.u - dq.sinPhi * v.v) * dq.sc + dq.tx);
          ly += w * ((dq.sinPhi * v.u + dq.cosPhi * v.v) * dq.sc + dq.ty);
        }
        v.x = lx;
        v.y = ly;
      } else {
        const len = Math.sqrt(C * C + S * S) || 1;
        const hc = C / len;
        const hs = S / len;
        const hdx = DX / len;
        const hdy = DY / len;

        const cosHat = hc * hc - hs * hs;
        const sinHat = 2 * hc * hs;
        const txHat = 2 * (hdx * hc - hdy * hs);
        const tyHat = 2 * (hdy * hc + hdx * hs);

        v.x = cosHat * v.u - sinHat * v.v + txHat;
        v.y = sinHat * v.u + cosHat * v.v + tyHat;
      }
    }
  }

  global.WPRigging = {
    CELL_SIZE,
    solveForwardKinematics,
    findJointAt,
    findBoneAt,
    addBone,
    deleteBone,
    deleteJoint,
    stampSkeleton,
    solveIKDrag,
    rotateBoneFK,
    ensurePartMesh,
    deformPartVertices
  };
})(window);
