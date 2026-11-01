// ============================================================================
// WigglePaint — Zero-Warp Puppet Rigging, Silhouette Auto-Rig & Smart IK/FK
// ============================================================================
(function (global) {
  'use strict';

  const { clamp, shortAngleDiff, dist, pointToSegment, rgbToHex, uid } = global.WPUtils;
  const {
    STAGE_W,
    STAGE_H,
    state,
    createOffscreenCanvas,
    ensureBonePose,
    ensureRootOffset,
    recomputeRestSkeleton
  } = global.WPState;

  const GRID_STEP = 2; // 2px high-precision segmentation grid (400 x 260)
  const AUTO_BIND_MAX_DIST = 58;

  // Color tint palette for "Show Rig Zones" visualization
  const ZONE_TINTS = [
    [59, 130, 246],
    [168, 85, 247],
    [236, 72, 153],
    [249, 115, 22],
    [16, 185, 129],
    [6, 182, 212],
    [234, 179, 8],
    [239, 68, 68]
  ];

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
      // Structural socket links (childJoint.pinned) stay rigidly locked to parent torso angle!
      const localDelta = restC.pinned && b.parentBoneId ? 0 : (bp.dAngle || 0);
      const worldAngle = baseAngle + localDelta;
      const scale = restC.pinned && b.parentBoneId ? 1 : (bp.scale !== undefined ? bp.scale : 1);
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
  // Hit-Testing Joints & Bones & Semantic Role Classification
  // --------------------------------------------------------------------------
  function classifyBoneRole(bone, bounds = null) {
    if (bone && bone.role) return bone.role;
    const jointMap = new Map(state.joints.map((j) => [j.id, j]));
    const pj = jointMap.get(bone.parentJointId);
    const cj = jointMap.get(bone.childJointId);
    if (!pj || !cj) return 'trunk';

    const b = bounds || (state.parts[0] && state.parts[0].bounds ? state.parts[0].bounds : null);
    if (!b) return 'trunk';

    const midX = (pj.x + cj.x) * 0.5;
    const midY = (pj.y + cj.y) * 0.5;
    const cx = b.cx !== undefined ? b.cx : (b.minX !== undefined && b.maxX !== undefined ? (b.minX + b.maxX) * 0.5 : (b.x + b.w * 0.5));
    const top = b.top !== undefined ? b.top : (b.minY !== undefined ? b.minY : (b.y || 0));
    const h = b.h || 100;
    const w = b.w || 100;

    // Head bone detection: upper ~40% of silhouette, near horizontal center, or child points upward
    const isUpper = midY < top + h * 0.40 || cj.y < top + h * 0.28;
    const isCentered = Math.abs(midX - cx) < w * 0.32;
    const pointsUp = cj.y <= pj.y + 12;

    if (isUpper && isCentered && (pointsUp || cj.y < top + h * 0.22)) {
      return 'head';
    }

    // Upper lateral or extremities -> arm / hand
    if (midY < top + h * 0.68 && Math.abs(midX - cx) > w * 0.20) {
      const isLeaf = !state.bones.some((ob) => ob.parentJointId === cj.id && ob.id !== bone.id);
      return isLeaf ? 'hand' : 'arm';
    }

    // Lower body -> leg / foot
    if (midY > top + h * 0.55) {
      const isLeaf = !state.bones.some((ob) => ob.parentJointId === cj.id && ob.id !== bone.id);
      return isLeaf ? 'foot' : 'leg';
    }

    return 'trunk';
  }

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
      if (seg.dist <= bestD) {
        bestD = seg.dist;
        best = { bone: b, bt, t: seg.t, dist: seg.dist };
      }
    }
    return best;
  }

  // --------------------------------------------------------------------------
  // Adding, Moving, and Deleting Bones
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
      restLocalAngle: 0,
      role: classifyBoneRole({ parentJointId: startJoint.id, childJointId: endJoint.id })
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
  // Silhouette-Aware 1-Click Auto-Rig Stamps!
  // Scans actual painted pixels so bones land INSIDE drawn arms, legs & head!
  // --------------------------------------------------------------------------
  function getCombinedAlphaAndBounds() {
    const temp = createOffscreenCanvas(STAGE_W, STAGE_H);
    const tctx = temp.getContext('2d', { willReadFrequently: true });
    let hasAny = false;
    let minX = STAGE_W, minY = STAGE_H, maxX = 0, maxY = 0;

    for (const p of state.parts) {
      if (!p.visible || !p.bounds) continue;
      hasAny = true;
      tctx.drawImage(p.canvas, 0, 0);
      minX = Math.min(minX, p.bounds.x);
      minY = Math.min(minY, p.bounds.y);
      maxX = Math.max(maxX, p.bounds.x + p.bounds.w);
      maxY = Math.max(maxY, p.bounds.y + p.bounds.h);
    }

    if (!hasAny || maxX - minX < 30 || maxY - minY < 30) {
      return {
        data: null,
        cx: STAGE_W / 2,
        cy: STAGE_H / 2 + 10,
        w: 180,
        h: 260,
        minX: STAGE_W / 2 - 90,
        maxX: STAGE_W / 2 + 90,
        top: STAGE_H / 2 - 120,
        bottom: STAGE_H / 2 + 140
      };
    }

    const data = tctx.getImageData(0, 0, STAGE_W, STAGE_H).data;
    return {
      data,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      w: Math.max(60, maxX - minX),
      h: Math.max(80, maxY - minY),
      minX,
      maxX,
      top: minY,
      bottom: maxY
    };
  }

  function findRowSpanCentroid(data, x0, x1, y0, y1) {
    if (!data) return null;
    x0 = clamp(Math.floor(x0), 0, STAGE_W - 1);
    x1 = clamp(Math.ceil(x1), 0, STAGE_W - 1);
    y0 = clamp(Math.floor(y0), 0, STAGE_H - 1);
    y1 = clamp(Math.ceil(y1), 0, STAGE_H - 1);
    let sx = 0, sy = 0, count = 0;
    for (let y = y0; y <= y1; y += 2) {
      const row = y * STAGE_W;
      for (let x = x0; x <= x1; x += 2) {
        if (data[(row + x) * 4 + 3] > 16) {
          sx += x;
          sy += y;
          count++;
        }
      }
    }
    return count > 3 ? { x: sx / count, y: sy / count, count } : null;
  }

  function stampSkeleton(kind = 'biped') {
    state.joints = [];
    state.bones = [];
    for (const pose of state.poses) {
      pose.bonePose = {};
      pose.rootOffsets = {};
    }

    const info = getCombinedAlphaAndBounds();
    const { data, top, h, w, minX, maxX } = info;
    let cx = info.cx;

    function mkJoint(x, y, pinned = false) {
      const j = { id: uid('jnt'), x: Math.round(x), y: Math.round(y), pinned };
      state.joints.push(j);
      return j;
    }
    function link(j1, j2, role = null) {
      const b = {
        id: uid('bone'),
        parentJointId: j1.id,
        childJointId: j2.id,
        restLength: dist(j1.x, j1.y, j2.x, j2.y),
        restWorldAngle: 0,
        restLocalAngle: 0,
        role: role || 'trunk'
      };
      state.bones.push(b);
      return b;
    }

    if (kind === 'biped') {
      // Detect true head & torso centerlines from painted silhouette!
      const headScan = findRowSpanCentroid(data, minX + w * 0.18, maxX - w * 0.18, top + h * 0.04, top + h * 0.24);
      const chestScan = findRowSpanCentroid(data, minX + w * 0.22, maxX - w * 0.22, top + h * 0.28, top + h * 0.46);
      const pelvisScan = findRowSpanCentroid(data, minX + w * 0.22, maxX - w * 0.22, top + h * 0.50, top + h * 0.65);

      if (chestScan) cx = chestScan.x;

      // Measure torso half-width at chest height so shoulders sit right at torso edges
      let torsoLeft = cx - Math.min(w * 0.16, 38);
      let torsoRight = cx + Math.min(w * 0.16, 38);
      const chestY = chestScan ? Math.round(chestScan.y) : Math.round(top + h * 0.35);
      if (data) {
        let lEdge = cx, rEdge = cx;
        for (let x = Math.round(cx); x >= minX; x--) {
          if (data[(chestY * STAGE_W + x) * 4 + 3] > 16) lEdge = x;
          else if (cx - x > 10) break;
        }
        for (let x = Math.round(cx); x <= maxX; x++) {
          if (data[(chestY * STAGE_W + x) * 4 + 3] > 16) rEdge = x;
          else if (x - cx > 10) break;
        }
        const halfT = clamp((rEdge - lEdge) * 0.44, 10, 56);
        torsoLeft = cx - halfT;
        torsoRight = cx + halfT;
      }

      const pelvis = mkJoint(pelvisScan ? pelvisScan.x : cx, pelvisScan ? pelvisScan.y : top + h * 0.56);
      const chest = mkJoint(cx, chestY);
      const head = mkJoint(headScan ? headScan.x : cx, headScan ? headScan.y : top + h * 0.13);

      // Scan outermost left & right painted arm extremities in upper/mid body band!
      let lHandPos = { x: cx - w * 0.44, y: top + h * 0.44 };
      let rHandPos = { x: cx + w * 0.44, y: top + h * 0.44 };
      if (data) {
        const armY0 = Math.floor(top + h * 0.05);
        const armY1 = Math.ceil(top + h * 0.66);
        let bestLX = torsoLeft - 8, bestLY = chestY, foundL = false;
        let bestRX = torsoRight + 8, bestRY = chestY, foundR = false;

        for (let y = armY0; y <= armY1; y += 2) {
          const row = y * STAGE_W;
          for (let x = minX; x < torsoLeft - 6; x += 2) {
            if (data[(row + x) * 4 + 3] > 20 && x < bestLX) {
              bestLX = x; bestLY = y; foundL = true;
            }
          }
          for (let x = maxX; x > torsoRight + 6; x -= 2) {
            if (data[(row + x) * 4 + 3] > 20 && x > bestRX) {
              bestRX = x; bestRY = y; foundR = true;
            }
          }
        }
        if (foundL) {
          const tipL = findRowSpanCentroid(data, bestLX, bestLX + 24, bestLY - 22, bestLY + 22);
          lHandPos = tipL || { x: bestLX + 8, y: bestLY };
        }
        if (foundR) {
          const tipR = findRowSpanCentroid(data, bestRX - 24, bestRX, bestRY - 22, bestRY + 22);
          rHandPos = tipR || { x: bestRX - 8, y: bestRY };
        }
      }

      // Trace mid-arm elbow centroids inside the actual painted arms!
      const lMidX = (torsoLeft + lHandPos.x) * 0.5;
      const lMidY = (chestY + lHandPos.y) * 0.5;
      const lElbowScan = findRowSpanCentroid(data, lMidX - 18, lMidX + 18, lMidY - 28, lMidY + 28);

      const rMidX = (torsoRight + rHandPos.x) * 0.5;
      const rMidY = (chestY + rHandPos.y) * 0.5;
      const rElbowScan = findRowSpanCentroid(data, rMidX - 18, rMidX + 18, rMidY - 28, rMidY + 28);

      const lShoulder = mkJoint(torsoLeft, chestY, true);
      const lElbow = mkJoint(lElbowScan ? lElbowScan.x : lMidX, lElbowScan ? lElbowScan.y : lMidY);
      const lHand = mkJoint(lHandPos.x, lHandPos.y);

      const rShoulder = mkJoint(torsoRight, chestY, true);
      const rElbow = mkJoint(rElbowScan ? rElbowScan.x : rMidX, rElbowScan ? rElbowScan.y : rMidY);
      const rHand = mkJoint(rHandPos.x, rHandPos.y);

      // Scan Left & Right Feet and Knees in lower body!
      const footBandL = findRowSpanCentroid(data, minX, cx - 2, top + h * 0.85, top + h * 0.99);
      const footBandR = findRowSpanCentroid(data, cx + 2, maxX, top + h * 0.85, top + h * 0.99);
      const kneeBandL = findRowSpanCentroid(data, minX, cx - 2, top + h * 0.68, top + h * 0.83);
      const kneeBandR = findRowSpanCentroid(data, cx + 2, maxX, top + h * 0.68, top + h * 0.83);

      const defLegSpread = Math.min(w * 0.18, 32);
      const lFootX = footBandL ? footBandL.x : cx - defLegSpread;
      const lFootY = footBandL ? footBandL.y : top + h * 0.93;
      const rFootX = footBandR ? footBandR.x : cx + defLegSpread;
      const rFootY = footBandR ? footBandR.y : top + h * 0.93;

      const lHip = mkJoint(kneeBandL ? (pelvis.x * 0.35 + kneeBandL.x * 0.65) : cx - defLegSpread * 0.8, pelvis.y + h * 0.04, true);
      const lKnee = mkJoint(kneeBandL ? kneeBandL.x : (lHip.x + lFootX) * 0.5, kneeBandL ? kneeBandL.y : top + h * 0.76);
      const lFoot = mkJoint(lFootX, lFootY);

      const rHip = mkJoint(kneeBandR ? (pelvis.x * 0.35 + kneeBandR.x * 0.65) : cx + defLegSpread * 0.8, pelvis.y + h * 0.04, true);
      const rKnee = mkJoint(kneeBandR ? kneeBandR.x : (rHip.x + rFootX) * 0.5, kneeBandR ? kneeBandR.y : top + h * 0.76);
      const rFoot = mkJoint(rFootX, rFootY);

      link(pelvis, chest, 'spine');
      link(chest, head, 'head');
      link(chest, lShoulder, 'shoulder');
      link(lShoulder, lElbow, 'arm');
      link(lElbow, lHand, 'hand');
      link(chest, rShoulder, 'shoulder');
      link(rShoulder, rElbow, 'arm');
      link(rElbow, rHand, 'hand');
      link(pelvis, lHip, 'hip');
      link(lHip, lKnee, 'leg');
      link(lKnee, lFoot, 'foot');
      link(pelvis, rHip, 'hip');
      link(rHip, rKnee, 'leg');
      link(rKnee, rFoot, 'foot');
    } else if (kind === 'bounce_spine') {
      const base = mkJoint(cx, top + h * 0.88);
      const mid1 = mkJoint(cx, top + h * 0.64);
      const mid2 = mkJoint(cx, top + h * 0.38);
      const tip = mkJoint(cx, top + h * 0.12);
      link(base, mid1, 'spine');
      link(mid1, mid2, 'spine');
      link(mid2, tip, 'head');
    } else if (kind === 'quad') {
      const hip = mkJoint(cx - w * 0.14, top + h * 0.52);
      const shoulder = mkJoint(cx + w * 0.12, top + h * 0.45);
      const head = mkJoint(cx + w * 0.30, top + h * 0.22);
      const tailMid = mkJoint(cx - w * 0.30, top + h * 0.48);
      const tailTip = mkJoint(cx - w * 0.44, top + h * 0.38);
      const bFoot = mkJoint(cx - w * 0.16, top + h * 0.90);
      const fFoot = mkJoint(cx + w * 0.14, top + h * 0.90);

      link(hip, shoulder, 'spine');
      link(shoulder, head, 'head');
      link(hip, tailMid, 'tail');
      link(tailMid, tailTip, 'tail');
      link(hip, bFoot, 'leg');
      link(shoulder, fFoot, 'leg');
    }

    recomputeRestSkeleton();
  }

  // --------------------------------------------------------------------------
  // Smart Inverse Kinematics (Damped CCD with Natural Joint Comfort Limits)
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

    // 1. Dragging a Root Joint moves the whole character!
    if (!incomingByChild.has(targetJointId)) {
      const ro = ensureRootOffset(pose, targetJointId);
      ro.dx = mouseX - targetJoint.x;
      ro.dy = mouseY - targetJoint.y;
      return;
    }

    // If user clicked directly on a pinned shoulder/hip socket, move the root or parent instead of nothing
    if (targetJoint.pinned) {
      const inc = incomingByChild.get(targetJointId);
      if (inc) solveIKDrag(pose, inc.parentJointId, mouseX, mouseY, options);
      return;
    }

    // 2. Build ancestor limb bone chain (skipping pinned socket connectors)
    const fullChain = options.fullChain || state.ikMode === 'chain';
    const maxBones = fullChain ? 5 : 2;
    const chain = [];
    let curJointId = targetJointId;

    while (chain.length < maxBones) {
      const incBone = incomingByChild.get(curJointId);
      if (!incBone) break;
      const cJoint = jointMap.get(incBone.childJointId);
      if (cJoint && cJoint.pinned && incBone.parentBoneId) break;

      // Smart IK Head Protection: Never allow a limb/hand drag to pull or rotate the head!
      const role = incBone.role || classifyBoneRole(incBone);
      if (role === 'head') break;

      chain.push(incBone);

      const parentJoint = jointMap.get(incBone.parentJointId);
      if (!parentJoint || parentJoint.pinned) break;
      if (!fullChain && (outgoingCount.get(parentJoint.id) || 0) > 1) break;
      curJointId = parentJoint.id;
    }

    if (chain.length === 0) return;

    // 3. Smooth damped CCD iterations
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
          diff = clamp(diff * 0.72, -0.35, 0.35);
        }

        const bp = ensureBonePose(pose, bone.id);
        let nextAngle = (bp.dAngle || 0) + diff;
        // Prevent elbows/knees (non-base bones in a 2+ bone chain) from folding 180° backwards inside themselves!
        if (chain.length > 1 && i < chain.length - 1) {
          nextAngle = clamp(nextAngle, -2.55, 2.55);
        } else {
          nextAngle = shortAngleDiff(0, nextAngle);
        }
        bp.dAngle = nextAngle;
      }
    }

    // 4. Optional Rubber-Hose Stretch (only along bone axis!)
    if (options.stretch || state.stretchBones) {
      const fkFinal = solveForwardKinematics(pose);
      const tipBone = chain[0];
      const basePiv = fkFinal.jointPositions.get(chain[chain.length - 1].parentJointId);
      if (basePiv) {
        const totalRest = chain.reduce((acc, b) => acc + b.restLength, 0);
        const totalDist = dist(basePiv.x, basePiv.y, mouseX, mouseY);
        const stretchRatio = totalDist > totalRest ? clamp(totalDist / totalRest, 1, 2.0) : 1;
        for (const b of chain) {
          ensureBonePose(pose, b.id).scale = stretchRatio;
        }
      }
    } else {
      for (const b of chain) {
        if (pose.bonePose && pose.bonePose[b.id]) pose.bonePose[b.id].scale = 1;
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
  // ZERO-WARP PUPPET RIGGING ENGINE:
  // Pixel-Connected Silhouette Segmentation + Seamless Circular Joint Hinges!
  // Every body piece renders 100% rigidly (no triangle shear, no face/eye warp,
  // and legs/arms overlap cleanly across each other!).
  // --------------------------------------------------------------------------
  function computeDistanceToTransparent(alphaGrid, gw, gh) {
    const INF = 1e5;
    const dt = new Float32Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) {
      dt[i] = alphaGrid[i] ? INF : 0;
    }
    // Forward chamfer pass
    for (let y = 0; y < gh; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        const idx = row + x;
        let d = dt[idx];
        if (d === 0) continue;
        if (x > 0) d = Math.min(d, dt[idx - 1] + 1);
        if (y > 0) {
          d = Math.min(d, dt[idx - gw] + 1);
          if (x > 0) d = Math.min(d, dt[idx - gw - 1] + 1.4142);
          if (x < gw - 1) d = Math.min(d, dt[idx - gw + 1] + 1.4142);
        }
        dt[idx] = d;
      }
    }
    // Backward chamfer pass
    for (let y = gh - 1; y >= 0; y--) {
      const row = y * gw;
      for (let x = gw - 1; x >= 0; x--) {
        const idx = row + x;
        let d = dt[idx];
        if (d === 0) continue;
        if (x < gw - 1) d = Math.min(d, dt[idx + 1] + 1);
        if (y < gh - 1) {
          d = Math.min(d, dt[idx + gw] + 1);
          if (x < gw - 1) d = Math.min(d, dt[idx + gw + 1] + 1.4142);
          if (x > 0) d = Math.min(d, dt[idx + gw - 1] + 1.4142);
        }
        dt[idx] = d;
      }
    }
    // Convert grid units to stage pixels
    for (let i = 0; i < dt.length; i++) dt[i] *= GRID_STEP;
    return dt;
  }

  function classifyBoneZOrder(bones, jointMap) {
    const boneById = new Map(bones.map((b) => [b.id, b]));
    const incoming = new Set(bones.map((b) => b.childJointId));
    const roots = state.joints.filter((j) => !incoming.has(j.id));
    const rootY = roots.length > 0 ? roots[0].y : STAGE_H * 0.55;
    const rootIds = new Set(roots.map((r) => r.id));

    function getAnchorJoint(bone) {
      let cur = bone;
      while (cur) {
        const pj = jointMap.get(cur.parentJointId);
        if (!pj || !pj.pinned || !cur.parentBoneId || !boneById.has(cur.parentBoneId)) {
          return pj || null;
        }
        cur = boneById.get(cur.parentBoneId);
      }
      return null;
    }

    const zMap = new Map();
    for (let idx = 0; idx < bones.length; idx++) {
      const b = bones[idx];
      const pj = jointMap.get(b.parentJointId);
      const cj = jointMap.get(b.childJointId);
      if (!pj || !cj) { zMap.set(b.id, 20); continue; }

      // Structural pinned socket links belong to the trunk core (20) so they don't skew child limb Z-order
      if (cj.pinned) {
        zMap.set(b.id, 20);
        continue;
      }

      const parentZ = b.parentBoneId && zMap.has(b.parentBoneId) ? zMap.get(b.parentBoneId) : null;
      const sinA = Math.sin(b.restWorldAngle);
      const cosA = Math.cos(b.restWorldAngle);
      const midY = (pj.y + cj.y) * 0.5;
      const anchor = getAnchorJoint(b) || pj;

      // Inherit limb family from parent if already on a moving limb chain!
      if (parentZ !== null && (parentZ < 18 || parentZ >= 40)) {
        zMap.set(b.id, parentZ + 1);
        continue;
      }

      // Trunk / Spine bone starting at root pointing upward
      if (rootIds.has(anchor.id) && sinA < -0.25 && Math.abs(cosA) < 0.88) {
        zMap.set(b.id, 20);
      } else if (sinA > 0.42 && midY >= rootY - 12 && anchor.y >= rootY - 32) {
        // Leg chain (tucks cleanly behind waist/torso hem; L vs R slightly offset so legs cross cleanly!)
        const sideOffset = cj.x < anchor.x ? 0 : 2;
        zMap.set(b.id, 10 + sideOffset);
      } else if (rootIds.has(anchor.id) && Math.abs(cosA) > 0.5) {
        // Tail chain anchored at hip/root -> behind body
        zMap.set(b.id, 8);
      } else if (sinA < -0.55 && Math.abs(cosA) < 0.65) {
        // Head / Neck pointing upward from chest -> overlaps collar!
        zMap.set(b.id, 30);
      } else {
        // Arms / Front limbs -> wave freely in front of torso & head!
        zMap.set(b.id, 40 + (idx % 2));
      }
    }
    return zMap;
  }

  function sampleRegionColor(imgData, cx, cy, maxRadius) {
    const rInt = Math.max(1, Math.min(8, Math.floor(maxRadius)));
    let sr = 0, sg = 0, sb = 0, count = 0;
    const x0 = clamp(Math.round(cx) - rInt, 0, STAGE_W - 1);
    const x1 = clamp(Math.round(cx) + rInt, 0, STAGE_W - 1);
    const y0 = clamp(Math.round(cy) - rInt, 0, STAGE_H - 1);
    const y1 = clamp(Math.round(cy) + rInt, 0, STAGE_H - 1);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > rInt * rInt) continue;
        const p = (y * STAGE_W + x) * 4;
        if (imgData[p + 3] > 200) {
          sr += imgData[p];
          sg += imgData[p + 1];
          sb += imgData[p + 2];
          count++;
        }
      }
    }
    if (count === 0) return null;
    return [Math.round(sr / count), Math.round(sg / count), Math.round(sb / count)];
  }

  function analyzeJointCapStyle(imgData, jx, jy, radiusPx, boneAngle) {
    const fillRgb = sampleRegionColor(imgData, jx, jy, radiusPx * 0.35);
    if (!fillRgb) return null;

    // Probe perpendicular to bone axis near outer boundary (radiusPx - 1.5px) to detect outline stroke!
    const perpAngles = [boneAngle + Math.PI * 0.5, boneAngle - Math.PI * 0.5];
    let rimColor = null;
    let strokeW = 0;

    for (const ang of perpAngles) {
      const ux = Math.cos(ang);
      const uy = Math.sin(ang);
      // Scan inward from radiusPx + 1 down to radiusPx * 0.45
      let foundEdgeR = -1;
      let innerTransitionR = -1;
      let edgeSample = null;

      for (let r = radiusPx + 1.5; r >= radiusPx * 0.35; r -= 0.75) {
        const px = clamp(Math.round(jx + ux * r), 0, STAGE_W - 1);
        const py = clamp(Math.round(jy + uy * r), 0, STAGE_H - 1);
        const p = (py * STAGE_W + px) * 4;
        if (imgData[p + 3] > 180) {
          const dr = imgData[p] - fillRgb[0];
          const dg = imgData[p + 1] - fillRgb[1];
          const db = imgData[p + 2] - fillRgb[2];
          const cDist = Math.sqrt(dr * dr + dg * dg + db * db);
          if (foundEdgeR < 0) {
            foundEdgeR = r;
            edgeSample = [imgData[p], imgData[p + 1], imgData[p + 2]];
          }
          if (cDist < 42) {
            innerTransitionR = r;
            break;
          }
        }
      }

      if (foundEdgeR > 0 && innerTransitionR > 0 && edgeSample) {
        const dr = edgeSample[0] - fillRgb[0];
        const dg = edgeSample[1] - fillRgb[1];
        const db = edgeSample[2] - fillRgb[2];
        if (Math.sqrt(dr * dr + dg * dg + db * db) >= 45) {
          rimColor = edgeSample;
          strokeW = clamp(foundEdgeR - innerTransitionR, 1.8, Math.min(6.5, radiusPx * 0.42));
          break;
        }
      }
    }

    return {
      fillHex: rgbToHex(fillRgb[0], fillRgb[1], fillRgb[2]),
      fillRgb,
      rimHex: rimColor ? rgbToHex(rimColor[0], rimColor[1], rimColor[2]) : null,
      strokeW
    };
  }

  function ensurePartMesh(part) {
    if (!part.dirtyMesh && part.mesh) return part.mesh;
    part.dirtyMesh = false;

    if (state.bones.length === 0 || part.bindMode === 'none' || !part.bounds) {
      part.mesh = { bound: false };
      return part.mesh;
    }

    const jointMap = new Map(state.joints.map((j) => [j.id, j]));

    // Rigid Single-Bone Cutout Mode (entire Part follows 1 bone)
    if (part.bindMode === 'rigid') {
      let chosenBoneId = part.rigidBoneId;
      if (!chosenBoneId || !state.bones.some((b) => b.id === chosenBoneId)) {
        let bestD = Infinity;
        for (const b of state.bones) {
          const pj = jointMap.get(b.parentJointId);
          const cj = jointMap.get(b.childJointId);
          if (!pj || !cj) continue;
          const d = pointToSegment(part.bounds.cx, part.bounds.cy, pj.x, pj.y, cj.x, cj.y).dist;
          if (d < bestD) { bestD = d; chosenBoneId = b.id; }
        }
      }
      part.mesh = { bound: !!chosenBoneId, mode: 'rigid', rigidBoneId: chosenBoneId };
      return part.mesh;
    }

    // Merge structural pinned socket links (e.g., chest->rShoulder, pelvis->lHip) into their parent trunk bone!
    // If root has no parent bone (e.g., pelvis->lHip), attach to the primary trunk bone starting at pelvis!
    const boneById = new Map(state.bones.map((b) => [b.id, b]));
    const rootTrunkBone = new Map();
    for (const b of state.bones) {
      const cj = jointMap.get(b.childJointId);
      if (cj && !cj.pinned && !rootTrunkBone.has(b.parentJointId)) {
        rootTrunkBone.set(b.parentJointId, b.id);
      }
    }

    function resolveOwnerBoneId(bone) {
      const cj = jointMap.get(bone.childJointId);
      if (cj && cj.pinned) {
        if (bone.parentBoneId && boneById.has(bone.parentBoneId)) {
          return resolveOwnerBoneId(boneById.get(bone.parentBoneId));
        }
        if (rootTrunkBone.has(bone.parentJointId)) {
          return rootTrunkBone.get(bone.parentJointId);
        }
      }
      return bone.id;
    }

    const activeBones = [];
    const activeIdxById = new Map();
    for (const b of state.bones) {
      if (resolveOwnerBoneId(b) === b.id) {
        const pj = jointMap.get(b.parentJointId);
        const cj = jointMap.get(b.childJointId);
        if (!pj || !cj) continue;
        activeIdxById.set(b.id, activeBones.length);
        const role = b.role || classifyBoneRole(b, part.bounds);
        activeBones.push({
          bone: b,
          id: b.id,
          role,
          isHead: role === 'head',
          isHand: role === 'hand',
          isLimb: role === 'hand' || role === 'arm' || role === 'leg' || role === 'foot',
          ax: pj.x,
          ay: pj.y,
          bx: cj.x,
          by: cj.y,
          angle: b.restWorldAngle,
          segments: [{ ax: pj.x, ay: pj.y, bx: cj.x, by: cj.y, isPrimary: true }]
        });
      }
    }

    // Attach merged pinned socket segments (e.g. chest->rShoulder, pelvis->lHip) onto their owner trunk bone!
    for (const b of state.bones) {
      const ownerId = resolveOwnerBoneId(b);
      if (ownerId !== b.id && activeIdxById.has(ownerId)) {
        const pj = jointMap.get(b.parentJointId);
        const cj = jointMap.get(b.childJointId);
        if (pj && cj) {
          activeBones[activeIdxById.get(ownerId)].segments.push({
            ax: pj.x, ay: pj.y, bx: cj.x, by: cj.y, isPrimary: false
          });
        }
      }
    }

    if (activeBones.length === 0) {
      part.mesh = { bound: false };
      return part.mesh;
    }

    function distToActiveBone(ab, x, y) {
      let best = Infinity;
      let bestT = 0.5;
      for (let s = 0; s < ab.segments.length; s++) {
        const seg = ab.segments[s];
        const res = pointToSegment(x, y, seg.ax, seg.ay, seg.bx, seg.by);
        if (res.dist < best) {
          best = res.dist;
          bestT = seg.isPrimary ? res.t : 0.5;
        }
      }
      return { dist: best, t: bestT };
    }

    // Build 2px alpha mask + Distance-to-Transparent field
    const gw = Math.ceil(STAGE_W / GRID_STEP);
    const gh = Math.ceil(STAGE_H / GRID_STEP);
    const imgData = part.ctx.getImageData(0, 0, STAGE_W, STAGE_H).data;
    const alphaGrid = new Uint8Array(gw * gh);

    let minBoneDist = Infinity;
    const gx0 = Math.max(0, Math.floor((part.bounds.x - 2) / GRID_STEP));
    const gy0 = Math.max(0, Math.floor((part.bounds.y - 2) / GRID_STEP));
    const gx1 = Math.min(gw - 1, Math.ceil((part.bounds.x + part.bounds.w + 2) / GRID_STEP));
    const gy1 = Math.min(gh - 1, Math.ceil((part.bounds.y + part.bounds.h + 2) / GRID_STEP));

    for (let gy = gy0; gy <= gy1; gy++) {
      const py0 = gy * GRID_STEP;
      for (let gx = gx0; gx <= gx1; gx++) {
        const px0 = gx * GRID_STEP;
        let maxA = 0;
        for (let dy = 0; dy < GRID_STEP && py0 + dy < STAGE_H; dy++) {
          for (let dx = 0; dx < GRID_STEP && px0 + dx < STAGE_W; dx++) {
            const a = imgData[((py0 + dy) * STAGE_W + (px0 + dx)) * 4 + 3];
            if (a > maxA) maxA = a;
          }
        }
        if (maxA > 6) {
          alphaGrid[gy * gw + gx] = 1;
          const cx = px0 + 1;
          const cy = py0 + 1;
          for (let i = 0; i < activeBones.length; i++) {
            const ab = activeBones[i];
            const d = pointToSegment(cx, cy, ab.ax, ab.ay, ab.bx, ab.by).dist;
            if (d < minBoneDist) minBoneDist = d;
          }
        }
      }
    }

    if (part.bindMode === 'auto' && minBoneDist > AUTO_BIND_MAX_DIST) {
      part.mesh = { bound: false };
      return part.mesh;
    }

    // If there is only 1 active bone:
    // Check if the single bone covers the entire Part or is a local limb/hand!
    let isSingleBoneRigid = false;
    if (activeBones.length === 1) {
      const ab = activeBones[0];
      const boneSpan = dist(ab.ax, ab.ay, ab.bx, ab.by);
      const partDiag = Math.hypot(part.bounds.w, part.bounds.h);
      if (partDiag < 80 || (boneSpan >= partDiag * 0.65 && !ab.isHand)) {
        isSingleBoneRigid = true;
      }
    }

    if (isSingleBoneRigid) {
      part.mesh = { bound: true, mode: 'rigid', rigidBoneId: activeBones[0].id };
      return part.mesh;
    }

    const distTrans = computeDistanceToTransparent(alphaGrid, gw, gh);
    const zOrderMap = classifyBoneZOrder(state.bones, jointMap);

    // 1. Measure characteristic silhouette radius (median distToTransparent) for each active bone!
    const boneRadius = new Float32Array(activeBones.length);
    for (let i = 0; i < activeBones.length; i++) {
      const ab = activeBones[i];
      const samples = [];
      for (const t of [0.15, 0.3, 0.5, 0.7, 0.85]) {
        const sx = ab.ax + (ab.bx - ab.ax) * t;
        const sy = ab.ay + (ab.by - ab.ay) * t;
        const gx = clamp(Math.floor(sx / GRID_STEP), 0, gw - 1);
        const gy = clamp(Math.floor(sy / GRID_STEP), 0, gh - 1);
        samples.push(distTrans[gy * gw + gx]);
      }
      samples.sort((a, b) => a - b);
      boneRadius[i] = Math.max(3, samples[3]); // 65th percentile thickness
    }

    // Map each active bone's effective parent active bone index
    const parentActiveIdx = new Int16Array(activeBones.length);
    parentActiveIdx.fill(-1);
    for (let i = 0; i < activeBones.length; i++) {
      const cb = activeBones[i].bone;
      const pb = cb.parentBoneId ? boneById.get(cb.parentBoneId) : null;
      let pOwnerId = null;
      if (pb) pOwnerId = resolveOwnerBoneId(pb);
      else if (rootTrunkBone.has(cb.parentJointId) && rootTrunkBone.get(cb.parentJointId) !== activeBones[i].id) {
        pOwnerId = rootTrunkBone.get(cb.parentJointId);
      }
      if (pOwnerId && pOwnerId !== activeBones[i].id && activeIdxById.has(pOwnerId)) {
        parentActiveIdx[i] = activeIdxById.get(pOwnerId);
      }
    }

    const STATIC_ANCHOR_IDX = -99;

    // Detect Head Region in drawing
    let headCenter = null;
    let headRadius = 0;
    const hgx0 = Math.max(0, Math.floor(part.bounds.x / GRID_STEP));
    const hgx1 = Math.min(gw - 1, Math.ceil((part.bounds.x + part.bounds.w) / GRID_STEP));
    const hgy0 = Math.max(0, Math.floor(part.bounds.y / GRID_STEP));
    const hgy1 = Math.min(gh - 1, Math.ceil((part.bounds.y + part.bounds.h * 0.38) / GRID_STEP));
    let maxHeadDT = 0;
    let bestHeadGX = 0, bestHeadGY = 0;

    for (let gy = hgy0; gy <= hgy1; gy++) {
      for (let gx = hgx0; gx <= hgx1; gx++) {
        const dtVal = distTrans[gy * gw + gx];
        if (dtVal > maxHeadDT) {
          maxHeadDT = dtVal;
          bestHeadGX = gx;
          bestHeadGY = gy;
        }
      }
    }
    if (maxHeadDT >= 7) {
      headCenter = { x: bestHeadGX * GRID_STEP + 1, y: bestHeadGY * GRID_STEP + 1 };
      headRadius = maxHeadDT;
    }

    let headBoneIdx = activeBones.findIndex((ab) => ab.isHead);
    if (headBoneIdx < 0 && headCenter) {
      for (let i = 0; i < activeBones.length; i++) {
        const ab = activeBones[i];
        const dChild = dist(ab.bx, ab.by, headCenter.x, headCenter.y);
        const dParent = dist(ab.ax, ab.ay, headCenter.x, headCenter.y);
        if (dChild <= headRadius * 1.3 || dParent <= headRadius * 0.8) {
          headBoneIdx = i;
          ab.isHead = true;
          ab.role = 'head';
          break;
        }
      }
    }

    const maxBodyR = Math.max(...boneRadius);
    const thickBoneIndices = [];
    const bodyDisks = []; // [{ x, y, r, ownerIdx }]

    for (let i = 0; i < activeBones.length; i++) {
      const ab = activeBones[i];
      if (ab.isHand || (ab.isLimb && !ab.isHead)) continue;

      if (i === headBoneIdx) {
        thickBoneIndices.push(i);
        if (headCenter) {
          bodyDisks.push({ x: headCenter.x, y: headCenter.y, r: headRadius * 0.96, ownerIdx: i });
        }
        for (const seg of ab.segments) {
          const steps = 8;
          for (let k = 0; k <= steps; k++) {
            const t = k / steps;
            const sx = seg.ax + (seg.bx - seg.ax) * t;
            const sy = seg.ay + (seg.by - seg.ay) * t;
            const gx = clamp(Math.floor(sx / GRID_STEP), 0, gw - 1);
            const gy = clamp(Math.floor(sy / GRID_STEP), 0, gh - 1);
            const rLocal = Math.min(distTrans[gy * gw + gx], Math.max(headRadius, boneRadius[i] * 1.35));
            if (rLocal >= 8) {
              bodyDisks.push({ x: sx, y: sy, r: rLocal * 0.94, ownerIdx: i });
            }
          }
        }
      } else if (boneRadius[i] >= 14 && boneRadius[i] >= maxBodyR * 0.38) {
        thickBoneIndices.push(i);
        for (const seg of ab.segments) {
          if (!seg.isPrimary) continue;
          const steps = 10;
          for (let k = 0; k <= steps; k++) {
            const t = k / steps;
            const sx = seg.ax + (seg.bx - seg.ax) * t;
            const sy = seg.ay + (seg.by - seg.ay) * t;
            const gx = clamp(Math.floor(sx / GRID_STEP), 0, gw - 1);
            const gy = clamp(Math.floor(sy / GRID_STEP), 0, gh - 1);
            const rLocal = Math.min(distTrans[gy * gw + gx], boneRadius[i] * 1.32);
            if (rLocal >= 10) {
              bodyDisks.push({ x: sx, y: sy, r: rLocal * 0.96, ownerIdx: i });
            }
          }
        }
      }
    }

    // If no head bone exists, protect unrigged head with STATIC ANCHOR disks
    if (headBoneIdx < 0 && headCenter) {
      bodyDisks.push({ x: headCenter.x, y: headCenter.y, r: headRadius * 0.96, ownerIdx: STATIC_ANCHOR_IDX });
    }

    // Multi-Source Geodesic Voronoi strictly through painted silhouette!
    const ownerGrid = new Int16Array(gw * gh);
    ownerGrid.fill(-1);
    const coreLocked = new Uint8Array(gw * gh);
    const bestDist = new Float32Array(gw * gh);
    bestDist.fill(1e6);

    const queue = [];
    for (let gy = gy0; gy <= gy1; gy++) {
      const cy = gy * GRID_STEP + 1;
      for (let gx = gx0; gx <= gx1; gx++) {
        const idx = gy * gw + gx;
        if (!alphaGrid[idx]) continue;
        const cx = gx * GRID_STEP + 1;

        // 1. Check Volumetric Body/Head Core first!
        if (bodyDisks.length > 0) {
          let insideCore = false;
          let matchedOwner = -1;
          for (let d = 0; d < bodyDisks.length; d++) {
            const dk = bodyDisks[d];
            if ((cx - dk.x) * (cx - dk.x) + (cy - dk.y) * (cy - dk.y) <= dk.r * dk.r) {
              insideCore = true;
              matchedOwner = dk.ownerIdx;
              break;
            }
          }
          if (insideCore) {
            let winCoreIdx = matchedOwner;
            if (matchedOwner >= 0 && thickBoneIndices.length > 1) {
              let bestCoreD = Infinity;
              for (const ti of thickBoneIndices) {
                const d = distToActiveBone(activeBones[ti], cx, cy).dist;
                if (d < bestCoreD) {
                  bestCoreD = d;
                  winCoreIdx = ti;
                }
              }
            }
            ownerGrid[idx] = winCoreIdx;
            coreLocked[idx] = 1;
            bestDist[idx] = 0;
            queue.push(idx);
            continue;
          }
        }

        // 2. Seed cells along bone cores (with Outward Half-Space Gate for limbs attached to thicker trunks!)
        let minD = 5.0;
        let winIdx = -1;
        for (let i = 0; i < activeBones.length; i++) {
          const ab = activeBones[i];

          // Smart Hand & Limb Protection: Hand bones cannot seed inside the head zone!
          if (ab.isHand || (ab.isLimb && !ab.isHead)) {
            if (headCenter) {
              const dToHead = dist(cx, cy, headCenter.x, headCenter.y);
              if (dToHead < headRadius + 4) continue;
            }
            const ux = Math.cos(ab.angle);
            const uy = Math.sin(ab.angle);
            const proj = (cx - ab.ax) * ux + (cy - ab.ay) * uy;
            if (proj < -Math.max(6, boneRadius[i] * 0.6)) continue;
          }

          const pIdx = parentActiveIdx[i];
          if (pIdx >= 0 && boneRadius[pIdx] > boneRadius[i] * 1.35) {
            // Do not seed a narrow limb while still deep inside a fat parent body silhouette!
            if (distTrans[idx] > boneRadius[i] * 1.42 + 3) continue;
            const ux = Math.cos(ab.angle);
            const uy = Math.sin(ab.angle);
            const proj = (cx - ab.ax) * ux + (cy - ab.ay) * uy;
            const perp = Math.abs(-(cx - ab.ax) * uy + (cy - ab.ay) * ux);
            if (proj < 1 || perp > boneRadius[i] * 1.32 + 3) continue;
          }
          const seg = distToActiveBone(ab, cx, cy);
          const endPenalty = (seg.t < 0.08 || seg.t > 0.92) ? 1.2 : 0;
          if (seg.dist + endPenalty < minD) {
            minD = seg.dist + endPenalty;
            winIdx = i;
          }
        }
        if (winIdx >= 0) {
          ownerGrid[idx] = winIdx;
          bestDist[idx] = minD;
          queue.push(idx);
        }
      }
    }

    const dirs = [
      [-1, 0, GRID_STEP], [1, 0, GRID_STEP], [0, -1, GRID_STEP], [0, 1, GRID_STEP],
      [-1, -1, GRID_STEP * 1.4142], [1, -1, GRID_STEP * 1.4142],
      [-1, 1, GRID_STEP * 1.4142], [1, 1, GRID_STEP * 1.4142]
    ];

    let qHead = 0;
    while (qHead < queue.length) {
      const u = queue[qHead++];
      const ux = u % gw;
      const uy = (u / gw) | 0;
      const curD = bestDist[u];
      const own = ownerGrid[u];

      for (let d = 0; d < 8; d++) {
        const nx = ux + dirs[d][0];
        const ny = uy + dirs[d][1];
        if (nx < gx0 || nx > gx1 || ny < gy0 || ny > gy1) continue;
        const v = ny * gw + nx;
        if (!alphaGrid[v] || coreLocked[v]) continue;
        const nd = curD + dirs[d][2];
        if (nd + 0.05 < bestDist[v]) {
          // Smart Hand & Limb Protection during propagation: enforce reach limit and head barrier!
          if (own >= 0 && own < activeBones.length) {
            const ab = activeBones[own];
            if (ab.isHand || (ab.isLimb && !ab.isHead)) {
              const maxReach = ab.bone.restLength * 1.6 + boneRadius[own] * 2.2 + 20;
              if (nd > maxReach) continue;

              const vcx = nx * GRID_STEP + 1;
              const vcy = ny * GRID_STEP + 1;
              if (headCenter) {
                const dToHead = dist(vcx, vcy, headCenter.x, headCenter.y);
                if (dToHead < headRadius + 4) continue;
              }

              const bux = Math.cos(ab.angle);
              const buy = Math.sin(ab.angle);
              const bProj = (vcx - ab.ax) * bux + (vcy - ab.ay) * buy;
              if (bProj < -Math.max(8, boneRadius[own] * 0.8)) continue;
            }
          }

          bestDist[v] = nd;
          ownerGrid[v] = own;
          queue.push(v);
        }
      }
    }

    // Assign any unseeded connected painted islands (e.g. floating eyes, eyebrows, hats, or offset strokes!)
    // as whole rigid islands to their nearest bone so ZERO pixels are ever left behind!
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const startIdx = gy * gw + gx;
        if (!alphaGrid[startIdx] || ownerGrid[startIdx] !== -1) continue;

        const comp = [startIdx];
        ownerGrid[startIdx] = -2;
        let cHead = 0;
        let closestBone = 0;
        let closestDist = Infinity;

        while (cHead < comp.length) {
          const u = comp[cHead++];
          const ux = u % gw;
          const uy = (u / gw) | 0;
          const cx = ux * GRID_STEP + 1;
          const cy = uy * GRID_STEP + 1;

          for (let i = 0; i < activeBones.length; i++) {
            const ab = activeBones[i];
            let bd = distToActiveBone(ab, cx, cy).dist;
            // If this island is in the head region, heavily penalize hand bones and favor head!
            if (headCenter && dist(cx, cy, headCenter.x, headCenter.y) < headRadius * 1.5) {
              if (ab.isHead) bd *= 0.2;
              else if (ab.isHand || ab.isLimb) bd += 2000;
            }
            if (bd < closestDist) {
              closestDist = bd;
              closestBone = i;
            }
          }

          for (let d = 0; d < 8; d++) {
            const nx = ux + dirs[d][0];
            const ny = uy + dirs[d][1];
            if (nx < gx0 || nx > gx1 || ny < gy0 || ny > gy1) continue;
            const v = ny * gw + nx;
            if (alphaGrid[v] && ownerGrid[v] === -1) {
              ownerGrid[v] = -2;
              comp.push(v);
            }
          }
        }

        // If no head bone exists, islands near headCenter belong to static anchor!
        if (headBoneIdx < 0 && headCenter && comp.length > 0) {
          const u0 = comp[0];
          const cx0 = (u0 % gw) * GRID_STEP + 1;
          const cy0 = ((u0 / gw) | 0) * GRID_STEP + 1;
          if (dist(cx0, cy0, headCenter.x, headCenter.y) < headRadius * 1.5) {
            closestBone = STATIC_ANCHOR_IDX;
          }
        }

        for (let k = 0; k < comp.length; k++) {
          ownerGrid[comp[k]] = closestBone;
        }
      }
    }

    // Build shared joint hinge caps & hidden under-torso tongues!
    const jointCapsForBone = Array.from({ length: activeBones.length }, () => []);
    const debugHinges = [];

    for (let i = 0; i < activeBones.length; i++) {
      const childAb = activeBones[i];
      const parentIdx = parentActiveIdx[i];
      if (parentIdx < 0) continue;
      const parentAb = activeBones[parentIdx];

      const hingeJoint = jointMap.get(childAb.bone.parentJointId);
      if (!hingeJoint) continue;

      // Locate actual boundary point along childAb where ownership transitions from parentIdx to i!
      let exitX = hingeJoint.x;
      let exitY = hingeJoint.y;
      for (let step = 0; step <= 24; step++) {
        const t = step / 24;
        const sx = childAb.ax + (childAb.bx - childAb.ax) * t;
        const sy = childAb.ay + (childAb.by - childAb.ay) * t;
        const gx = clamp(Math.floor(sx / GRID_STEP), 0, gw - 1);
        const gy = clamp(Math.floor(sy / GRID_STEP), 0, gh - 1);
        if (ownerGrid[gy * gw + gx] === i) {
          exitX = sx;
          exitY = sy;
          break;
        }
      }

      // Nudge cap center toward local perpendicular medial peak of the limb (never drifting into coreLocked torso!)
      const ux = Math.cos(childAb.angle);
      const uy = Math.sin(childAb.angle);
      const perpX = -uy;
      const perpY = ux;
      const maxCapR = Math.min(32, Math.max(boneRadius[i], Math.min(boneRadius[parentIdx], boneRadius[i] * 1.5)) * 1.22);

      function centerOnLimbMedial(bx, by) {
        const bgx = clamp(Math.floor(bx / GRID_STEP), 0, gw - 1);
        const bgy = clamp(Math.floor(by / GRID_STEP), 0, gh - 1);
        let bestX = bx, bestY = by;
        let bestDT = distTrans[bgy * gw + bgx];
        for (const dir of [-1, 1]) {
          for (let s = 2; s <= 14; s += 2) {
            const tx = bx + perpX * dir * s;
            const ty = by + perpY * dir * s;
            const tgx = clamp(Math.floor(tx / GRID_STEP), 0, gw - 1);
            const tgy = clamp(Math.floor(ty / GRID_STEP), 0, gh - 1);
            const tidx = tgy * gw + tgx;
            if (!alphaGrid[tidx] || coreLocked[tidx]) break;
            const dtVal = distTrans[tidx];
            if (dtVal > maxCapR + 4) break;
            if (dtVal > bestDT) {
              bestDT = dtVal;
              bestX = tx;
              bestY = ty;
            }
          }
        }
        return { x: bestX, y: bestY, dt: bestDT };
      }

      const medExit = centerOnLimbMedial(exitX, exitY);
      exitX = medExit.x;
      exitY = medExit.y;
      const rExit = Math.min(30, medExit.dt, maxCapR);
      if (rExit < 2.2) continue;

      const zParent = zOrderMap.get(parentAb.id) || 20;
      const zChild = zOrderMap.get(childAb.id) || 20;
      const underIdx = zParent <= zChild ? parentIdx : i;
      const overIdx = zParent <= zChild ? i : parentIdx;
      const underAb = activeBones[underIdx];

      // Sample true colors just inside parent and just inside child around the seam!
      const colParent = sampleRegionColor(imgData, exitX - ux * 8, exitY - uy * 8, 4);
      const colChild = sampleRegionColor(imgData, exitX + ux * 8, exitY + uy * 8, 4);
      const styleAtExit = analyzeJointCapStyle(imgData, exitX + ux * 6, exitY + uy * 6, rExit, childAb.angle)
        || analyzeJointCapStyle(imgData, hingeJoint.x, hingeJoint.y, rExit, underAb.angle);
      if (!styleAtExit) continue;

      let sameColor = true;
      if (colParent && colChild) {
        const dc = Math.hypot(colParent[0] - colChild[0], colParent[1] - colChild[1], colParent[2] - colChild[2]);
        sameColor = dc < 52;
      }

      const underFillHex = underIdx === i
        ? (colChild ? rgbToHex(...colChild) : styleAtExit.fillHex)
        : (colParent ? rgbToHex(...colParent) : styleAtExit.fillHex);

      // Stamp rounded tongue disks from exitX,exitY back toward hingeJoint on the Under-Piece
      // (strictly clamped to distTrans at each point so it NEVER pokes outside silhouette in rest pose!)
      const medHinge = centerOnLimbMedial(hingeJoint.x, hingeJoint.y);
      const spanDist = dist(medHinge.x, medHinge.y, exitX, exitY);
      const numTongueSteps = spanDist > 3 && underIdx === i ? Math.min(6, Math.ceil(spanDist / 5)) : 1;
      for (let s = 0; s < numTongueSteps; s++) {
        const frac = numTongueSteps === 1 ? 1 : (s + 1) / numTongueSteps;
        const cx = medHinge.x + (exitX - medHinge.x) * frac;
        const cy = medHinge.y + (exitY - medHinge.y) * frac;
        const cgx = clamp(Math.floor(cx / GRID_STEP), 0, gw - 1);
        const cgy = clamp(Math.floor(cy / GRID_STEP), 0, gh - 1);
        const safeR = Math.min(rExit, distTrans[cgy * gw + cgx] - 0.5);
        if (safeR >= 2.0) {
          jointCapsForBone[underIdx].push({
            x: cx,
            y: cy,
            r: safeR,
            fillHex: underFillHex,
            rimHex: styleAtExit.rimHex,
            strokeW: styleAtExit.strokeW,
            role: 'under'
          });
        }
      }

      // If same-color joint (like elbow, knee, or yellow sleeve meeting yellow shoulder!),
      // give Over-Piece a clean inner-fill disk so there is ZERO outline crease inside the limb!
      if (sameColor) {
        const jgx = clamp(Math.floor(exitX / GRID_STEP), 0, gw - 1);
        const jgy = clamp(Math.floor(exitY / GRID_STEP), 0, gh - 1);
        const safeOverR = Math.min(rExit, distTrans[jgy * gw + jgx]) - Math.max(2.4, styleAtExit.strokeW + 0.8);
        if (safeOverR >= 1.5) {
          jointCapsForBone[overIdx].push({
            x: exitX,
            y: exitY,
            r: safeOverR,
            fillHex: colChild ? rgbToHex(...colChild) : styleAtExit.fillHex,
            rimHex: null,
            strokeW: 0,
            role: 'over-inner'
          });
        }
      }

      debugHinges.push({ x: exitX, y: exitY, r: rExit });
    }

    // Bake each Active Bone's crisp rigid offscreen cropped sprite!
    const pieces = [];
    for (let i = 0; i < activeBones.length; i++) {
      const ab = activeBones[i];
      const zOrder = zOrderMap.get(ab.id) || 20;

      // Compute tight pixel bounding box for this bone's owned pixels + joint caps
      let bMinX = STAGE_W, bMinY = STAGE_H, bMaxX = -1, bMaxY = -1;
      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          if (ownerGrid[gy * gw + gx] !== i) continue;
          const px = gx * GRID_STEP;
          const py = gy * GRID_STEP;
          if (px < bMinX) bMinX = px;
          if (py < bMinY) bMinY = py;
          if (px + GRID_STEP > bMaxX) bMaxX = px + GRID_STEP;
          if (py + GRID_STEP > bMaxY) bMaxY = py + GRID_STEP;
        }
      }

      for (const cap of jointCapsForBone[i]) {
        bMinX = Math.min(bMinX, Math.floor(cap.x - cap.r - 2));
        bMinY = Math.min(bMinY, Math.floor(cap.y - cap.r - 2));
        bMaxX = Math.max(bMaxX, Math.ceil(cap.x + cap.r + 2));
        bMaxY = Math.max(bMaxY, Math.ceil(cap.y + cap.r + 2));
      }

      if (bMaxX <= bMinX || bMaxY <= bMinY) continue;
      bMinX = clamp(bMinX - 2, 0, STAGE_W);
      bMinY = clamp(bMinY - 2, 0, STAGE_H);
      bMaxX = clamp(bMaxX + 2, 0, STAGE_W);
      bMaxY = clamp(bMaxY + 2, 0, STAGE_H);

      const pw = bMaxX - bMinX;
      const ph = bMaxY - bMinY;
      const pieceCanvas = createOffscreenCanvas(pw, ph);
      const pctx = pieceCanvas.getContext('2d');
      const pImg = pctx.createImageData(pw, ph);
      const pData = pImg.data;

      // Copy exact MS-Paint pixels owned by bone `i` (plus 1-grid-cell under-bleed into higher-Z neighbors to prevent bilinear AA gaps!)
      for (let py = bMinY; py < bMaxY; py++) {
        const gy = (py / GRID_STEP) | 0;
        for (let px = bMinX; px < bMaxX; px++) {
          const gx = (px / GRID_STEP) | 0;
          const gIdx = gy * gw + gx;
          let take = ownerGrid[gIdx] === i;

          if (!take && alphaGrid[gIdx] && ownerGrid[gIdx] >= 0) {
            const otherIdx = ownerGrid[gIdx];
            const otherZ = zOrderMap.get(activeBones[otherIdx].id) || 20;
            // Under-bleed by 2px underneath higher-Z pieces so rotated seams never show subpixel gaps!
            if (zOrder <= otherZ) {
              if (
                (gx > 0 && ownerGrid[gIdx - 1] === i) ||
                (gx < gw - 1 && ownerGrid[gIdx + 1] === i) ||
                (gy > 0 && ownerGrid[gIdx - gw] === i) ||
                (gy < gh - 1 && ownerGrid[gIdx + gw] === i)
              ) {
                take = true;
              }
            }
          }

          if (take) {
            const srcOff = (py * STAGE_W + px) * 4;
            const dstOff = ((py - bMinY) * pw + (px - bMinX)) * 4;
            pData[dstOff] = imgData[srcOff];
            pData[dstOff + 1] = imgData[srcOff + 1];
            pData[dstOff + 2] = imgData[srcOff + 2];
            pData[dstOff + 3] = imgData[srcOff + 3];
          }
        }
      }
      pctx.putImageData(pImg, 0, 0);

      // Composite rounded joint caps UNDERNEATH this bone's crisp original pixels!
      if (jointCapsForBone[i].length > 0) {
        pctx.save();
        pctx.globalCompositeOperation = 'destination-over';
        for (const cap of jointCapsForBone[i]) {
          const lx = cap.x - bMinX;
          const ly = cap.y - bMinY;
          if (cap.rimHex && cap.strokeW > 0) {
            const innerR = Math.max(0.5, cap.r - cap.strokeW);
            pctx.fillStyle = cap.fillHex;
            pctx.beginPath();
            pctx.arc(lx, ly, innerR + 0.6, 0, Math.PI * 2);
            pctx.fill();

            pctx.fillStyle = cap.rimHex;
            pctx.beginPath();
            pctx.arc(lx, ly, cap.r, 0, Math.PI * 2);
            pctx.fill();
          } else {
            pctx.fillStyle = cap.fillHex;
            pctx.beginPath();
            pctx.arc(lx, ly, cap.r, 0, Math.PI * 2);
            pctx.fill();
          }
        }
        pctx.restore();
      }

      pieces.push({
        boneId: ab.id,
        zOrder,
        canvas: pieceCanvas,
        offsetX: bMinX,
        offsetY: bMinY,
        w: pw,
        h: ph,
        tint: ZONE_TINTS[i % ZONE_TINTS.length]
      });
    }

    // Static Base piece: if the user only rigged a limb/hand or partial skeleton,
    // all unassigned / static anchor pixels remain anchored at rest as a stable body piece!
    let sMinX = STAGE_W, sMinY = STAGE_H, sMaxX = -1, sMaxY = -1;
    let staticPixelCount = 0;
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const own = ownerGrid[gy * gw + gx];
        if (own < 0 || own === STATIC_ANCHOR_IDX) {
          const px0 = gx * GRID_STEP;
          const py0 = gy * GRID_STEP;
          for (let dy = 0; dy < GRID_STEP && py0 + dy < STAGE_H; dy++) {
            const py = py0 + dy;
            for (let dx = 0; dx < GRID_STEP && px0 + dx < STAGE_W; dx++) {
              const px = px0 + dx;
              const off = (py * STAGE_W + px) * 4;
              if (imgData[off + 3] > 20) {
                if (px < sMinX) sMinX = px;
                if (px > sMaxX) sMaxX = px;
                if (py < sMinY) sMinY = py;
                if (py > sMaxY) sMaxY = py;
                staticPixelCount++;
              }
            }
          }
        }
      }
    }

    if (staticPixelCount > 0 && sMaxX >= sMinX && sMaxY >= sMinY) {
      sMinX = clamp(sMinX - 2, 0, STAGE_W);
      sMinY = clamp(sMinY - 2, 0, STAGE_H);
      sMaxX = clamp(sMaxX + 2, 0, STAGE_W);
      sMaxY = clamp(sMaxY + 2, 0, STAGE_H);
      const spw = sMaxX - sMinX + 1;
      const sph = sMaxY - sMinY + 1;
      const sPieceCanvas = createOffscreenCanvas(spw, sph);
      const spctx = sPieceCanvas.getContext('2d');
      const spImg = spctx.createImageData(spw, sph);
      const spd = spImg.data;

      for (let py = sMinY; py <= sMaxY; py++) {
        const gy = Math.floor(py / GRID_STEP);
        for (let px = sMinX; px <= sMaxX; px++) {
          const off = (py * STAGE_W + px) * 4;
          const a = imgData[off + 3];
          if (a <= 0) continue;
          const gx = Math.floor(px / GRID_STEP);
          const own = ownerGrid[gy * gw + gx];
          const lx = px - sMinX;
          const ly = py - sMinY;
          const spOff = (ly * spw + lx) * 4;

          if (own < 0 || own === STATIC_ANCHOR_IDX) {
            spd[spOff] = imgData[off];
            spd[spOff + 1] = imgData[off + 1];
            spd[spOff + 2] = imgData[off + 2];
            spd[spOff + 3] = a;
          } else {
            // Under-bleed 2px under neighbor rigged pieces to avoid seam gaps at boundary
            const dist = hingeDistGrid[gy * gw + gx];
            if (dist <= 2.2) {
              spd[spOff] = imgData[off];
              spd[spOff + 1] = imgData[off + 1];
              spd[spOff + 2] = imgData[off + 2];
              spd[spOff + 3] = a;
            }
          }
        }
      }
      spctx.putImageData(spImg, 0, 0);

      pieces.push({
        boneId: null, // null boneId means rendered stably at rest offset in drawPuppetPieces!
        zOrder: 15,
        canvas: sPieceCanvas,
        offsetX: sMinX,
        offsetY: sMinY,
        w: spw,
        h: sph,
        tint: [148, 163, 184] // Slate tint for static anchor
      });
    }

    // Sort pieces back-to-front by zOrder!
    pieces.sort((a, b) => a.zOrder - b.zOrder);

    // Optional debug visualization canvas for "Show Rig Zones"
    let zoneOverlayCanvas = null;
    if (pieces.length > 0) {
      zoneOverlayCanvas = createOffscreenCanvas(STAGE_W, STAGE_H);
      const zctx = zoneOverlayCanvas.getContext('2d');
      const zImg = zctx.createImageData(STAGE_W, STAGE_H);
      const zd = zImg.data;
      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const own = ownerGrid[gy * gw + gx];
          let tint = null;
          let alpha = 105;
          if (own >= 0 && own < activeBones.length) {
            tint = ZONE_TINTS[own % ZONE_TINTS.length];
          } else if (own === STATIC_ANCHOR_IDX || (staticPixelCount > 0 && own < 0)) {
            tint = [148, 163, 184];
            alpha = 75;
          } else {
            continue;
          }
          for (let dy = 0; dy < GRID_STEP; dy++) {
            const py = gy * GRID_STEP + dy;
            if (py >= STAGE_H) continue;
            for (let dx = 0; dx < GRID_STEP; dx++) {
              const px = gx * GRID_STEP + dx;
              if (px >= STAGE_W) continue;
              const off = (py * STAGE_W + px) * 4;
              if (imgData[off + 3] > 20) {
                zd[off] = tint[0];
                zd[off + 1] = tint[1];
                zd[off + 2] = tint[2];
                zd[off + 3] = alpha;
              }
            }
          }
        }
      }
      zctx.putImageData(zImg, 0, 0);
      // Draw hinge circles on zone overlay
      zctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      zctx.lineWidth = 1.6;
      zctx.setLineDash([3, 3]);
      for (const h of debugHinges) {
        zctx.beginPath();
        zctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
        zctx.stroke();
      }
    }

    part.mesh = {
      bound: pieces.length > 0,
      mode: 'puppet',
      pieces,
      zoneOverlayCanvas
    };
    return part.mesh;
  }

  global.WPRigging = {
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
  };
})(window);
