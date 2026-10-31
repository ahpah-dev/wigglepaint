// ============================================================================
// WigglePaint — Built-in Starter Templates (Procedural MS-Paint Art + Rigs)
// ============================================================================
(function (global) {
  'use strict';

  const { dist, uid } = global.WPUtils;
  const {
    STAGE_W,
    STAGE_H,
    state,
    createPart,
    createEmptyPose,
    markPartDirty,
    recomputeRestSkeleton,
    resetProject,
    notify
  } = global.WPState;

  function drawCloud(ctx, x, y, s = 1) {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, 22 * s, 0, Math.PI * 2);
    ctx.arc(x + 22 * s, y - 8 * s, 26 * s, 0, Math.PI * 2);
    ctx.arc(x + 48 * s, y, 20 * s, 0, Math.PI * 2);
    ctx.arc(x + 24 * s, y + 8 * s, 22 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function paintMeadowBackdrop(ctx) {
    const grad = ctx.createLinearGradient(0, 0, 0, STAGE_H);
    grad.addColorStop(0, '#bae6fd');
    grad.addColorStop(0.74, '#e0f2fe');
    grad.addColorStop(0.741, '#86efac');
    grad.addColorStop(1, '#4ade80');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);

    // Soft distant hills
    ctx.fillStyle = '#bbf7d0';
    ctx.beginPath();
    ctx.ellipse(210, 392, 260, 55, 0, Math.PI, 0);
    ctx.ellipse(620, 396, 280, 64, 0, Math.PI, 0);
    ctx.fill();

    // Crisp ground horizon line (MS-Paint charm!)
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 390);
    ctx.lineTo(STAGE_W, 390);
    ctx.stroke();

    drawCloud(ctx, 110, 95, 1.05);
    drawCloud(ctx, 585, 82, 0.9);
  }

  function addJoint(x, y, pinned = false) {
    const j = { id: uid('jnt'), x, y, pinned };
    state.joints.push(j);
    return j;
  }

  function addLink(j1, j2) {
    const b = {
      id: uid('bone'),
      parentJointId: j1.id,
      childJointId: j2.id,
      restLength: dist(j1.x, j1.y, j2.x, j2.y),
      restWorldAngle: 0,
      restLocalAngle: 0
    };
    state.bones.push(b);
    return b;
  }

  function loadWavingBuddy() {
    resetProject();
    paintMeadowBackdrop(state.backdropCtx);

    const charPart = state.parts[0];
    charPart.name = 'Buddy';
    const ctx = charPart.ctx;
    const ink = '#1e2430';

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Helper for outlined capsule limbs (drawn cleanly so arms & legs have clear air gaps!)
    function limbCapsule(x1, y1, x2, y2, radius, fill) {
      ctx.save();
      ctx.strokeStyle = ink;
      ctx.lineWidth = radius * 2 + 8;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      ctx.strokeStyle = fill;
      ctx.lineWidth = radius * 2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.restore();
    }

    // Left & Right Legs (with clear gap between legs!)
    limbCapsule(374, 298, 368, 396, 13, '#3b82f6');
    limbCapsule(426, 298, 432, 396, 13, '#3b82f6');

    // Sneakers
    function drawShoe(x, y, dir) {
      ctx.save();
      ctx.fillStyle = '#ef4444';
      ctx.strokeStyle = ink;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.ellipse(x + dir * 8, y + 6, 22, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 10 + dir * 6, y + 11, 24, 4);
      ctx.restore();
    }
    drawShoe(366, 398, -1);
    drawShoe(434, 398, 1);

    // Left Arm (angled out left) & Right Arm (angled out right — ready to wave!)
    limbCapsule(356, 214, 304, 244, 11, '#facc15');
    limbCapsule(304, 244, 266, 258, 10, '#facc15');
    // Left Hand
    ctx.fillStyle = '#fed7aa';
    ctx.strokeStyle = ink;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(262, 260, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    limbCapsule(444, 214, 496, 200, 11, '#facc15');
    limbCapsule(496, 200, 536, 166, 10, '#facc15');
    // Right Hand
    ctx.beginPath();
    ctx.arc(540, 162, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Torso (Sunny Yellow Hoodie)
    ctx.fillStyle = '#facc15';
    ctx.strokeStyle = ink;
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(352, 194, 96, 112, 28);
    else ctx.rect(352, 194, 96, 112);
    ctx.fill();
    ctx.stroke();

    // Hoodie pocket & star badge
    ctx.fillStyle = '#eab308';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(370, 264, 60, 26, 10);
    else ctx.rect(370, 264, 60, 26);
    ctx.fill();
    ctx.stroke();

    // Head
    ctx.fillStyle = '#fed7aa';
    ctx.strokeStyle = ink;
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.arc(400, 144, 46, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Red Cap
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(400, 128, 46, Math.PI * 1.05, Math.PI * 1.98);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(418, 118, 36, 9, -0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Eyes, Rosy Cheeks, Big Smile
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(384, 142, 5.5, 0, Math.PI * 2);
    ctx.arc(416, 142, 5.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(382, 140, 2, 0, Math.PI * 2);
    ctx.arc(414, 140, 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(251, 113, 133, 0.55)';
    ctx.beginPath();
    ctx.ellipse(370, 154, 9, 5.5, 0, 0, Math.PI * 2);
    ctx.ellipse(430, 154, 9, 5.5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = ink;
    ctx.lineWidth = 3.8;
    ctx.beginPath();
    ctx.arc(400, 150, 16, 0.2, Math.PI - 0.2);
    ctx.stroke();

    markPartDirty(charPart);

    // Build Skeleton matching Buddy with exact shoulder & hip sockets!
    const pelvis = addJoint(400, 286);
    const chest = addJoint(400, 212);
    const head = addJoint(400, 132);

    const lShoulder = addJoint(356, 214, true);
    const lElbow = addJoint(304, 244);
    const lHand = addJoint(262, 260);

    const rShoulder = addJoint(444, 214, true);
    const rElbow = addJoint(496, 200);
    const rHand = addJoint(540, 162);

    const lHip = addJoint(374, 298, true);
    const lKnee = addJoint(371, 348);
    const lFoot = addJoint(366, 400);

    const rHip = addJoint(426, 298, true);
    const rKnee = addJoint(429, 348);
    const rFoot = addJoint(434, 400);

    const bSpine = addLink(pelvis, chest);
    const bHead = addLink(chest, head);
    addLink(chest, lShoulder);
    const bLUA = addLink(lShoulder, lElbow);
    const bLFA = addLink(lElbow, lHand);
    addLink(chest, rShoulder);
    const bRUA = addLink(rShoulder, rElbow);
    const bRFA = addLink(rElbow, rHand);
    addLink(pelvis, lHip);
    const bLThigh = addLink(lHip, lKnee);
    const bLShin = addLink(lKnee, lFoot);
    addLink(pelvis, rHip);
    const bRThigh = addLink(rHip, rKnee);
    const bRShin = addLink(rKnee, rFoot);

    recomputeRestSkeleton();

    // 2-Pose Friendly Wave + Bounce!
    const p1 = createEmptyPose('Wave Hi!');
    const p2 = createEmptyPose('Wave Back');
    p1.duration = 0.42; p1.easing = 'springy';
    p2.duration = 0.42; p2.easing = 'springy';

    p1.rootOffsets[pelvis.id] = { dx: 0, dy: -4 };
    p1.bonePose[bSpine.id] = { dAngle: -0.04, scale: 1 };
    p1.bonePose[bHead.id] = { dAngle: -0.08, scale: 1 };
    p1.bonePose[bRUA.id] = { dAngle: -0.25, scale: 1 };
    p1.bonePose[bRFA.id] = { dAngle: -0.48, scale: 1 };
    p1.bonePose[bLUA.id] = { dAngle: -0.08, scale: 1 };
    p1.bonePose[bLThigh.id] = { dAngle: 0.04, scale: 1 };
    p1.bonePose[bLShin.id] = { dAngle: -0.04, scale: 1 };

    p2.rootOffsets[pelvis.id] = { dx: 0, dy: 5 };
    p2.bonePose[bSpine.id] = { dAngle: 0.04, scale: 1 };
    p2.bonePose[bHead.id] = { dAngle: 0.09, scale: 1 };
    p2.bonePose[bRUA.id] = { dAngle: 0.08, scale: 1 };
    p2.bonePose[bRFA.id] = { dAngle: 0.42, scale: 1 };
    p2.bonePose[bLUA.id] = { dAngle: 0.1, scale: 1 };
    p2.bonePose[bRThigh.id] = { dAngle: -0.05, scale: 1 };
    p2.bonePose[bRShin.id] = { dAngle: 0.05, scale: 1 };

    state.poses = [p1, p2];
    state.activePoseIndex = 0;
    state.loopSeamless = true;
    state.mode = 'animate';
    state.isPlaying = true;
    notify('template-loaded');
  }

  function loadBouncyDino() {
    resetProject();
    // Warm sunset desert backdrop
    const bctx = state.backdropCtx;
    const grad = bctx.createLinearGradient(0, 0, 0, STAGE_H);
    grad.addColorStop(0, '#fef3c7');
    grad.addColorStop(0.75, '#fde68a');
    grad.addColorStop(0.751, '#fbbf24');
    grad.addColorStop(1, '#f59e0b');
    bctx.fillStyle = grad;
    bctx.fillRect(0, 0, STAGE_W, STAGE_H);

    bctx.fillStyle = '#fcd34d';
    bctx.beginPath();
    bctx.arc(660, 110, 44, 0, Math.PI * 2);
    bctx.fill();

    const dino = state.parts[0];
    dino.name = 'Dino';
    const ctx = dino.ctx;
    const ink = '#1e293b';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Tail
    ctx.fillStyle = '#22c55e';
    ctx.strokeStyle = ink;
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.moveTo(355, 290);
    ctx.quadraticCurveTo(265, 295, 225, 248);
    ctx.quadraticCurveTo(275, 338, 365, 332);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Legs
    function leg(x, y) {
      ctx.fillStyle = '#16a34a';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - 16, y, 32, 82, 14);
      else ctx.rect(x - 16, y, 32, 82);
      ctx.fill();
      ctx.stroke();
    }
    leg(368, 322);
    leg(434, 322);

    // Chubby Dino Body + Snout
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.ellipse(404, 276, 62, 74, -0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Belly patch
    ctx.fillStyle = '#fde047';
    ctx.beginPath();
    ctx.ellipse(424, 286, 34, 48, -0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Head / Snout
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(380, 140, 112, 76, 34);
    else ctx.rect(380, 140, 112, 76);
    ctx.fill();
    ctx.stroke();

    // Cute back spikes
    ctx.fillStyle = '#f97316';
    for (const [sx, sy] of [[368, 165], [352, 205], [342, 248]]) {
      ctx.beginPath();
      ctx.moveTo(sx, sy - 14);
      ctx.lineTo(sx - 22, sy);
      ctx.lineTo(sx, sy + 14);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Tiny T-Rex Arms
    ctx.strokeStyle = ink;
    ctx.lineWidth = 14;
    ctx.beginPath(); ctx.moveTo(446, 248); ctx.lineTo(482, 258); ctx.stroke();
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(446, 248); ctx.lineTo(482, 258); ctx.stroke();

    // Eye & Happy Grin
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(432, 168, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(430, 166, 2.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = ink;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(436, 196);
    ctx.quadraticCurveTo(464, 206, 486, 192);
    ctx.stroke();

    markPartDirty(dino);

    // Skeleton
    const hip = addJoint(396, 304);
    const chest = addJoint(408, 232);
    const head = addJoint(444, 174);
    const tail1 = addJoint(312, 298);
    const tail2 = addJoint(235, 255);
    const lFoot = addJoint(368, 398);
    const rFoot = addJoint(434, 398);

    const bBody = addLink(hip, chest);
    const bHead = addLink(chest, head);
    const bT1 = addLink(hip, tail1);
    const bT2 = addLink(tail1, tail2);
    const bLF = addLink(hip, lFoot);
    const bRF = addLink(hip, rFoot);

    recomputeRestSkeleton();

    const p1 = createEmptyPose('Crouch');
    const p2 = createEmptyPose('Hop!');
    p1.duration = 0.34; p1.easing = 'easeOut';
    p2.duration = 0.38; p2.easing = 'springy';

    p1.rootOffsets[hip.id] = { dx: 0, dy: 14 };
    p1.bonePose[bBody.id] = { dAngle: 0.12, scale: 1 };
    p1.bonePose[bHead.id] = { dAngle: 0.1, scale: 1 };
    p1.bonePose[bT1.id] = { dAngle: -0.22, scale: 1 };
    p1.bonePose[bT2.id] = { dAngle: -0.28, scale: 1 };
    p1.bonePose[bLF.id] = { dAngle: 0.18, scale: 0.92 };
    p1.bonePose[bRF.id] = { dAngle: -0.18, scale: 0.92 };

    p2.rootOffsets[hip.id] = { dx: 0, dy: -52 };
    p2.bonePose[bBody.id] = { dAngle: -0.1, scale: 1 };
    p2.bonePose[bHead.id] = { dAngle: -0.14, scale: 1 };
    p2.bonePose[bT1.id] = { dAngle: 0.25, scale: 1 };
    p2.bonePose[bT2.id] = { dAngle: 0.32, scale: 1 };
    p2.bonePose[bLF.id] = { dAngle: -0.24, scale: 1 };
    p2.bonePose[bRF.id] = { dAngle: 0.26, scale: 1 };

    state.poses = [p1, p2];
    state.activePoseIndex = 0;
    state.loopSeamless = true;
    state.mode = 'animate';
    state.isPlaying = true;
    notify('template-loaded');
  }

  function loadSlimeAndBall() {
    resetProject();
    paintMeadowBackdrop(state.backdropCtx);

    // Part 1: Squishy Pink Slime (Squash & Stretch Tween without bones!)
    const slime = state.parts[0];
    slime.name = 'Pink Slime';
    slime.bindMode = 'none';
    const sctx = slime.ctx;
    sctx.fillStyle = '#f472b6';
    sctx.strokeStyle = '#1e2430';
    sctx.lineWidth = 4.5;
    sctx.beginPath();
    sctx.moveTo(210, 390);
    sctx.quadraticCurveTo(205, 290, 280, 290);
    sctx.quadraticCurveTo(355, 290, 350, 390);
    sctx.closePath();
    sctx.fill();
    sctx.stroke();

    // Slime eyes & shine
    sctx.fillStyle = 'rgba(255,255,255,0.65)';
    sctx.beginPath();
    sctx.ellipse(248, 320, 14, 7, -0.45, 0, Math.PI * 2);
    sctx.fill();

    sctx.fillStyle = '#1e2430';
    sctx.beginPath();
    sctx.arc(265, 344, 5.5, 0, Math.PI * 2);
    sctx.arc(302, 344, 5.5, 0, Math.PI * 2);
    sctx.fill();
    sctx.beginPath();
    sctx.arc(284, 352, 9, 0.15, Math.PI - 0.15);
    sctx.stroke();
    markPartDirty(slime);

    // Part 2: Beach Ball
    const ball = createPart('Beach Ball', 'none');
    const bctx = ball.ctx;
    bctx.fillStyle = '#38bdf8';
    bctx.strokeStyle = '#1e2430';
    bctx.lineWidth = 4.5;
    bctx.beginPath();
    bctx.arc(540, 355, 36, 0, Math.PI * 2);
    bctx.fill();
    bctx.stroke();

    bctx.fillStyle = '#facc15';
    bctx.beginPath();
    bctx.moveTo(540, 319);
    bctx.arc(540, 355, 36, -Math.PI * 0.5, 0.4);
    bctx.closePath();
    bctx.fill();
    bctx.stroke();

    bctx.fillStyle = '#fb7185';
    bctx.beginPath();
    bctx.moveTo(540, 355);
    bctx.arc(540, 355, 36, 1.3, 2.5);
    bctx.closePath();
    bctx.fill();
    bctx.stroke();
    markPartDirty(ball);

    state.parts.push(ball);
    state.activePartId = slime.id;

    const p1 = createEmptyPose('Bounce 1');
    const p2 = createEmptyPose('High Arc');
    const p3 = createEmptyPose('Land!');
    p1.duration = 0.35; p1.easing = 'easeOut';
    p2.duration = 0.35; p2.easing = 'easeIn';
    p3.duration = 0.24; p3.easing = 'springy';

    p1.partTransforms[slime.id] = { dx: 0, dy: 8, rotation: 0, scaleX: 1.18, scaleY: 0.82, opacity: 1 };
    p2.partTransforms[slime.id] = { dx: 20, dy: -68, rotation: 0.08, scaleX: 0.88, scaleY: 1.15, opacity: 1 };
    p3.partTransforms[slime.id] = { dx: 0, dy: 10, rotation: -0.03, scaleX: 1.2, scaleY: 0.8, opacity: 1 };

    p1.partTransforms[ball.id] = { dx: 0, dy: -95, rotation: 0, scaleX: 0.94, scaleY: 1.07, opacity: 1 };
    p2.partTransforms[ball.id] = { dx: 0, dy: 6, rotation: Math.PI, scaleX: 1.2, scaleY: 0.8, opacity: 1 };
    p3.partTransforms[ball.id] = { dx: 0, dy: -95, rotation: Math.PI * 2, scaleX: 0.94, scaleY: 1.07, opacity: 1 };

    state.poses = [p1, p2, p3];
    state.activePoseIndex = 0;
    state.loopSeamless = true;
    state.mode = 'animate';
    state.animTool = 'transform';
    state.isPlaying = true;
    notify('template-loaded');
  }

  global.WPTemplates = {
    loadWavingBuddy,
    loadBouncyDino,
    loadSlimeAndBall
  };
})(window);
