// ============================================================================
// WigglePaint — Smooth Pose Tweening, Timeline Evaluation & Magic Motions
// ============================================================================
(function (global) {
  'use strict';

  const { clamp, lerp, shortAngleDiff, applyEasing } = global.WPUtils;
  const {
    state,
    createEmptyPose,
    createDefaultPartTransform,
    pushHistory,
    notify
  } = global.WPState;

  function interpolatePoses(poseA, poseB, rawT, easingOverride) {
    const easingName = easingOverride || poseA.easing || 'smooth';
    const u = applyEasing(easingName, rawT);

    const out = {
      id: 'tweened',
      name: 'Tween',
      duration: poseA.duration,
      easing: easingName,
      rootOffsets: {},
      bonePose: {},
      partTransforms: {}
    };

    // 1. Root joint offsets
    const rootIds = new Set([
      ...Object.keys(poseA.rootOffsets || {}),
      ...Object.keys(poseB.rootOffsets || {})
    ]);
    for (const id of rootIds) {
      const a = (poseA.rootOffsets && poseA.rootOffsets[id]) || { dx: 0, dy: 0 };
      const b = (poseB.rootOffsets && poseB.rootOffsets[id]) || { dx: 0, dy: 0 };
      out.rootOffsets[id] = {
        dx: lerp(a.dx || 0, b.dx || 0, u),
        dy: lerp(a.dy || 0, b.dy || 0, u)
      };
    }

    // 2. Bone angles (shortest-arc angular interpolation + overshoot support) & stretch scale
    const boneIds = new Set([
      ...Object.keys(poseA.bonePose || {}),
      ...Object.keys(poseB.bonePose || {})
    ]);
    for (const id of boneIds) {
      const a = (poseA.bonePose && poseA.bonePose[id]) || { dAngle: 0, scale: 1 };
      const b = (poseB.bonePose && poseB.bonePose[id]) || { dAngle: 0, scale: 1 };
      const angA = a.dAngle || 0;
      const angB = b.dAngle || 0;
      const scA = a.scale !== undefined ? a.scale : 1;
      const scB = b.scale !== undefined ? b.scale : 1;
      out.bonePose[id] = {
        dAngle: angA + shortAngleDiff(angA, angB) * u,
        scale: Math.max(0.15, lerp(scA, scB, u))
      };
    }

    // 3. Part transforms (position, continuous rotation, squash & stretch, opacity)
    const partIds = new Set([
      ...state.parts.map((p) => p.id),
      ...Object.keys(poseA.partTransforms || {}),
      ...Object.keys(poseB.partTransforms || {})
    ]);
    for (const id of partIds) {
      const def = createDefaultPartTransform();
      const a = (poseA.partTransforms && poseA.partTransforms[id]) || def;
      const b = (poseB.partTransforms && poseB.partTransforms[id]) || def;
      out.partTransforms[id] = {
        dx: lerp(a.dx ?? 0, b.dx ?? 0, u),
        dy: lerp(a.dy ?? 0, b.dy ?? 0, u),
        rotation: lerp(a.rotation ?? 0, b.rotation ?? 0, u),
        scaleX: lerp(a.scaleX ?? 1, b.scaleX ?? 1, u),
        scaleY: lerp(a.scaleY ?? 1, b.scaleY ?? 1, u),
        opacity: clamp(lerp(a.opacity ?? 1, b.opacity ?? 1, u), 0, 1)
      };
    }

    return out;
  }

  function getTimelineSegments() {
    const poses = state.poses;
    if (poses.length <= 1) {
      return [{
        fromIdx: 0,
        toIdx: 0,
        duration: Math.max(0.1, (poses[0] && poses[0].duration) || 0.5),
        easing: 'hold'
      }];
    }

    const segments = [];
    for (let i = 0; i < poses.length - 1; i++) {
      segments.push({
        fromIdx: i,
        toIdx: i + 1,
        duration: Math.max(0.08, poses[i].duration || 0.45),
        easing: poses[i].easing || 'smooth'
      });
    }

    if (state.pingPong && poses.length >= 2) {
      for (let i = poses.length - 1; i > 0; i--) {
        segments.push({
          fromIdx: i,
          toIdx: i - 1,
          duration: Math.max(0.08, poses[i - 1].duration || 0.45),
          easing: poses[i - 1].easing || 'smooth'
        });
      }
    } else if (state.loopSeamless) {
      const last = poses[poses.length - 1];
      segments.push({
        fromIdx: poses.length - 1,
        toIdx: 0,
        duration: Math.max(0.08, last.duration || 0.45),
        easing: last.easing || 'smooth'
      });
    } else {
      // Brief hold on final pose before restarting loop
      segments.push({
        fromIdx: poses.length - 1,
        toIdx: poses.length - 1,
        duration: 0.3,
        easing: 'hold'
      });
    }

    return segments;
  }

  function getTotalDuration() {
    const segs = getTimelineSegments();
    let total = 0;
    for (const s of segs) total += s.duration;
    return Math.max(0.1, total);
  }

  function evaluatePoseAtTime(timeSec) {
    const poses = state.poses;
    if (poses.length === 0) {
      return { pose: createEmptyPose(), fromIdx: 0, toIdx: 0, localT: 0, totalDuration: 0.5, wrappedTime: 0 };
    }
    if (poses.length === 1) {
      return { pose: poses[0], fromIdx: 0, toIdx: 0, localT: 0, totalDuration: poses[0].duration || 0.5, wrappedTime: 0 };
    }

    const segs = getTimelineSegments();
    const totalDuration = segs.reduce((acc, s) => acc + s.duration, 0);
    let t = ((timeSec % totalDuration) + totalDuration) % totalDuration;
    const wrappedTime = t;

    for (const seg of segs) {
      if (t <= seg.duration + 1e-6) {
        const localT = seg.duration > 0 ? clamp(t / seg.duration, 0, 1) : 0;
        if (seg.fromIdx === seg.toIdx) {
          return { pose: poses[seg.fromIdx], fromIdx: seg.fromIdx, toIdx: seg.toIdx, localT, totalDuration, wrappedTime };
        }
        const pose = interpolatePoses(poses[seg.fromIdx], poses[seg.toIdx], localT, seg.easing);
        return { pose, fromIdx: seg.fromIdx, toIdx: seg.toIdx, localT, totalDuration, wrappedTime };
      }
      t -= seg.duration;
    }

    const lastSeg = segs[segs.length - 1];
    return {
      pose: poses[lastSeg.toIdx],
      fromIdx: lastSeg.fromIdx,
      toIdx: lastSeg.toIdx,
      localT: 1,
      totalDuration,
      wrappedTime
    };
  }

  function getPoseStartTime(poseIndex) {
    let acc = 0;
    for (let i = 0; i < poseIndex && i < state.poses.length - 1; i++) {
      acc += Math.max(0.08, state.poses[i].duration || 0.45);
    }
    return acc;
  }

  // --------------------------------------------------------------------------
  // Reset / Mirror Helpers for Active Pose
  // --------------------------------------------------------------------------
  function resetPoseToRest(pose) {
    pose.rootOffsets = {};
    pose.bonePose = {};
    pose.partTransforms = {};
  }

  // --------------------------------------------------------------------------
  // 1-Click Magic Motions (Works BOTH with Rigged Skeletons AND Unrigged Art!)
  // --------------------------------------------------------------------------
  function analyzeSkeletonRoles() {
    const jointMap = new Map(state.joints.map((j) => [j.id, j]));
    const incoming = new Set(state.bones.map((b) => b.childJointId));
    const roots = state.joints.filter((j) => !incoming.has(j.id));

    const leftArms = [];
    const rightArms = [];
    const leftLegs = [];
    const rightLegs = [];
    const spineOrHead = [];

    const rootX = roots.length > 0 ? roots[0].x : 400;
    const rootY = roots.length > 0 ? roots[0].y : 270;

    for (const b of state.bones) {
      const pj = jointMap.get(b.parentJointId);
      const cj = jointMap.get(b.childJointId);
      if (!pj || !cj) continue;
      if (cj.pinned) continue; // Keep structural shoulder/hip socket links stationary during auto-motions!
      const midX = (pj.x + cj.x) * 0.5;
      const midY = (pj.y + cj.y) * 0.5;
      const sinA = Math.sin(b.restWorldAngle);
      const cosA = Math.cos(b.restWorldAngle);

      // Downward limb starting near or below root -> Leg
      if (sinA > 0.5 && midY > rootY + 4 && Math.abs(midX - rootX) > 6) {
        if (midX < rootX) leftLegs.push(b);
        else rightLegs.push(b);
      } else if (Math.abs(cosA) > 0.42 && midY <= rootY + 25) {
        // Horizontal-ish upper limb -> Arm / Tail
        if (midX < rootX) leftArms.push(b);
        else rightArms.push(b);
      } else {
        spineOrHead.push(b);
      }
    }

    return { roots, leftArms, rightArms, leftLegs, rightLegs, spineOrHead };
  }

  function applyMagicMotion(kind) {
    pushHistory(`Magic Motion: ${kind}`);
    const hasRig = state.bones.length > 0;
    const targetParts = state.parts.filter((p) => p.visible);

    state.loopSeamless = true;
    state.pingPong = false;

    if (!hasRig) {
      // Pure Part-Transform Squash & Stretch Tweening!
      if (kind === 'breathe') {
        const p1 = createEmptyPose('Inhale');
        const p2 = createEmptyPose('Exhale');
        p1.duration = 0.75; p1.easing = 'smooth';
        p2.duration = 0.75; p2.easing = 'smooth';
        for (const p of targetParts) {
          p1.partTransforms[p.id] = { dx: 0, dy: -4, rotation: -0.02, scaleX: 0.97, scaleY: 1.05, opacity: 1 };
          p2.partTransforms[p.id] = { dx: 0, dy: 4, rotation: 0.02, scaleX: 1.04, scaleY: 0.95, opacity: 1 };
        }
        state.poses = [p1, p2];
      } else if (kind === 'jump') {
        const p1 = createEmptyPose('Squash');
        const p2 = createEmptyPose('Leap!');
        const p3 = createEmptyPose('Peak');
        const p4 = createEmptyPose('Land');
        p1.duration = 0.22; p1.easing = 'easeOut';
        p2.duration = 0.28; p2.easing = 'smooth';
        p3.duration = 0.28; p3.easing = 'easeIn';
        p4.duration = 0.26; p4.easing = 'springy';
        for (const p of targetParts) {
          p1.partTransforms[p.id] = { dx: 0, dy: 14, rotation: 0, scaleX: 1.16, scaleY: 0.84, opacity: 1 };
          p2.partTransforms[p.id] = { dx: 0, dy: -75, rotation: -0.06, scaleX: 0.88, scaleY: 1.15, opacity: 1 };
          p3.partTransforms[p.id] = { dx: 0, dy: -88, rotation: 0.06, scaleX: 1.02, scaleY: 0.98, opacity: 1 };
          p4.partTransforms[p.id] = { dx: 0, dy: 10, rotation: 0, scaleX: 1.12, scaleY: 0.88, opacity: 1 };
        }
        state.poses = [p1, p2, p3, p4];
      } else if (kind === 'wave' || kind === 'walk') {
        const p1 = createEmptyPose('Bop Left');
        const p2 = createEmptyPose('Hop');
        const p3 = createEmptyPose('Bop Right');
        const p4 = createEmptyPose('Hop');
        p1.duration = 0.26; p1.easing = 'smooth';
        p2.duration = 0.22; p2.easing = 'smooth';
        p3.duration = 0.26; p3.easing = 'smooth';
        p4.duration = 0.22; p4.easing = 'smooth';
        for (const p of targetParts) {
          p1.partTransforms[p.id] = { dx: -18, dy: 4, rotation: -0.13, scaleX: 1.05, scaleY: 0.95, opacity: 1 };
          p2.partTransforms[p.id] = { dx: 0, dy: -22, rotation: 0, scaleX: 0.96, scaleY: 1.06, opacity: 1 };
          p3.partTransforms[p.id] = { dx: 18, dy: 4, rotation: 0.13, scaleX: 1.05, scaleY: 0.95, opacity: 1 };
          p4.partTransforms[p.id] = { dx: 0, dy: -22, rotation: 0, scaleX: 0.96, scaleY: 1.06, opacity: 1 };
        }
        state.poses = [p1, p2, p3, p4];
      }
    } else {
      // Skeletal Rigged Motion!
      const roles = analyzeSkeletonRoles();

      if (kind === 'breathe') {
        const p1 = createEmptyPose('Breathe In');
        const p2 = createEmptyPose('Breathe Out');
        p1.duration = 0.8; p1.easing = 'smooth';
        p2.duration = 0.8; p2.easing = 'smooth';

        for (const r of roles.roots) {
          p1.rootOffsets[r.id] = { dx: 0, dy: -4 };
          p2.rootOffsets[r.id] = { dx: 0, dy: 3 };
        }
        roles.spineOrHead.forEach((b, idx) => {
          p1.bonePose[b.id] = { dAngle: -0.05 * (idx + 1), scale: 1.02 };
          p2.bonePose[b.id] = { dAngle: 0.05 * (idx + 1), scale: 0.98 };
        });
        for (const b of roles.leftArms) {
          p1.bonePose[b.id] = { dAngle: 0.09, scale: 1 };
          p2.bonePose[b.id] = { dAngle: -0.07, scale: 1 };
        }
        for (const b of roles.rightArms) {
          p1.bonePose[b.id] = { dAngle: -0.09, scale: 1 };
          p2.bonePose[b.id] = { dAngle: 0.07, scale: 1 };
        }
        state.poses = [p1, p2];
      } else if (kind === 'wave') {
        const p1 = createEmptyPose('Wave Out');
        const p2 = createEmptyPose('Wave In');
        p1.duration = 0.36; p1.easing = 'springy';
        p2.duration = 0.36; p2.easing = 'springy';

        const waveChain = roles.rightArms.length > 0
          ? roles.rightArms
          : roles.leftArms.length > 0
            ? roles.leftArms
            : roles.spineOrHead;
        const dir = roles.rightArms.length > 0 ? -1 : 1;

        waveChain.forEach((b, idx) => {
          if (idx === 0) {
            p1.bonePose[b.id] = { dAngle: dir * 0.72, scale: 1 };
            p2.bonePose[b.id] = { dAngle: dir * 0.55, scale: 1 };
          } else {
            p1.bonePose[b.id] = { dAngle: dir * 0.55, scale: 1 };
            p2.bonePose[b.id] = { dAngle: -dir * 0.38, scale: 1 };
          }
        });
        roles.spineOrHead.forEach((b) => {
          if (!waveChain.includes(b)) {
            p1.bonePose[b.id] = { dAngle: -dir * 0.07, scale: 1 };
            p2.bonePose[b.id] = { dAngle: dir * 0.05, scale: 1 };
          }
        });
        for (const r of roles.roots) {
          p1.rootOffsets[r.id] = { dx: 0, dy: -3 };
          p2.rootOffsets[r.id] = { dx: 0, dy: 2 };
        }
        state.poses = [p1, p2];
      } else if (kind === 'jump') {
        const p1 = createEmptyPose('Crouch');
        const p2 = createEmptyPose('Jump Up!');
        const p3 = createEmptyPose('Land');
        p1.duration = 0.25; p1.easing = 'easeOut';
        p2.duration = 0.38; p2.easing = 'easeIn';
        p3.duration = 0.30; p3.easing = 'springy';

        for (const r of roles.roots) {
          p1.rootOffsets[r.id] = { dx: 0, dy: 18 };
          p2.rootOffsets[r.id] = { dx: 0, dy: -70 };
          p3.rootOffsets[r.id] = { dx: 0, dy: 12 };
        }
        for (const b of roles.leftArms) {
          p1.bonePose[b.id] = { dAngle: -0.35, scale: 1 };
          p2.bonePose[b.id] = { dAngle: 0.75, scale: 1 };
          p3.bonePose[b.id] = { dAngle: -0.2, scale: 1 };
        }
        for (const b of roles.rightArms) {
          p1.bonePose[b.id] = { dAngle: 0.35, scale: 1 };
          p2.bonePose[b.id] = { dAngle: -0.75, scale: 1 };
          p3.bonePose[b.id] = { dAngle: 0.2, scale: 1 };
        }
        roles.leftLegs.forEach((b, i) => {
          p1.bonePose[b.id] = { dAngle: i === 0 ? 0.35 : -0.55, scale: 1 };
          p2.bonePose[b.id] = { dAngle: i === 0 ? -0.28 : 0.42, scale: 1 };
          p3.bonePose[b.id] = { dAngle: i === 0 ? 0.22 : -0.35, scale: 1 };
        });
        roles.rightLegs.forEach((b, i) => {
          p1.bonePose[b.id] = { dAngle: i === 0 ? -0.35 : 0.55, scale: 1 };
          p2.bonePose[b.id] = { dAngle: i === 0 ? 0.28 : -0.42, scale: 1 };
          p3.bonePose[b.id] = { dAngle: i === 0 ? -0.22 : 0.35, scale: 1 };
        });
        state.poses = [p1, p2, p3];
      } else if (kind === 'walk') {
        const p1 = createEmptyPose('Step L');
        const p2 = createEmptyPose('Pass Up');
        const p3 = createEmptyPose('Step R');
        const p4 = createEmptyPose('Pass Up');
        [p1, p2, p3, p4].forEach((p) => { p.duration = 0.24; p.easing = 'smooth'; });

        for (const r of roles.roots) {
          p1.rootOffsets[r.id] = { dx: 0, dy: 5 };
          p2.rootOffsets[r.id] = { dx: 0, dy: -9 };
          p3.rootOffsets[r.id] = { dx: 0, dy: 5 };
          p4.rootOffsets[r.id] = { dx: 0, dy: -9 };
        }
        roles.leftLegs.forEach((b, i) => {
          p1.bonePose[b.id] = { dAngle: i === 0 ? -0.42 : 0.15, scale: 1 };
          p2.bonePose[b.id] = { dAngle: i === 0 ? 0.05 : 0.42, scale: 1 };
          p3.bonePose[b.id] = { dAngle: i === 0 ? 0.42 : 0.2, scale: 1 };
          p4.bonePose[b.id] = { dAngle: i === 0 ? -0.1 : 0.05, scale: 1 };
        });
        roles.rightLegs.forEach((b, i) => {
          p1.bonePose[b.id] = { dAngle: i === 0 ? 0.42 : 0.2, scale: 1 };
          p2.bonePose[b.id] = { dAngle: i === 0 ? -0.1 : 0.05, scale: 1 };
          p3.bonePose[b.id] = { dAngle: i === 0 ? -0.42 : 0.15, scale: 1 };
          p4.bonePose[b.id] = { dAngle: i === 0 ? 0.05 : 0.42, scale: 1 };
        });
        roles.leftArms.forEach((b, i) => {
          p1.bonePose[b.id] = { dAngle: i === 0 ? -0.35 : -0.18, scale: 1 };
          p3.bonePose[b.id] = { dAngle: i === 0 ? 0.35 : 0.1, scale: 1 };
        });
        roles.rightArms.forEach((b, i) => {
          p1.bonePose[b.id] = { dAngle: i === 0 ? 0.35 : 0.1, scale: 1 };
          p3.bonePose[b.id] = { dAngle: i === 0 ? -0.35 : -0.18, scale: 1 };
        });
        roles.spineOrHead.forEach((b) => {
          p1.bonePose[b.id] = { dAngle: 0.05, scale: 1 };
          p3.bonePose[b.id] = { dAngle: -0.05, scale: 1 };
        });
        state.poses = [p1, p2, p3, p4];
      }
    }

    state.activePoseIndex = 0;
    state.mode = 'animate';
    state.playTime = 0;
    state.isPlaying = true;
    notify('magic-motion');
  }

  global.WPTweening = {
    interpolatePoses,
    getTimelineSegments,
    getTotalDuration,
    evaluatePoseAtTime,
    getPoseStartTime,
    resetPoseToRest,
    applyMagicMotion
  };
})(window);
