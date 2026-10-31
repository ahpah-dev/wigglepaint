// ============================================================================
// WigglePaint — Pointer Smoothing Engine
// A 1€ Filter (Casiez et al.) removes tremor without adding lag, paired with a
// Catmull-Rom spline renderer so strokes come out as one continuous, C1
// continuous curve instead of a chain of jittery chords.
// ============================================================================
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Standard exponential smoothing coefficient for a given cutoff (Hz) and dt (s)
  function smoothingAlpha(cutoff, dt) {
    const tau = 1 / (TAU * cutoff);
    return 1 / (1 + tau / dt);
  }

  // --------------------------------------------------------------------------
  // One Euro Filter — vectorised 2D variant.
  // Low cutoff while the pointer is still (kills tremor), cutoff opens up as
  // the pointer accelerates (keeps the tip under the cursor, no rubber-band).
  // --------------------------------------------------------------------------
  class OneEuroFilter {
    constructor(minCutoff = 1.6, beta = 0.025, dCutoff = 1.2) {
      this.minCutoff = minCutoff;
      this.beta = beta;
      this.dCutoff = dCutoff;
      this.reset();
    }

    reset() {
      this.hasPrev = false;
      this.xPrev = 0;
      this.yPrev = 0;
      this.xHat = 0;
      this.yHat = 0;
      this.dxHat = 0;
      this.dyHat = 0;
      this.speed = 0;
      this.cutoff = this.minCutoff;
    }

    /**
     * @param {number} x raw pointer x
     * @param {number} y raw pointer y
     * @param {number} dt seconds since previous sample
     * @returns {{x:number,y:number,speed:number,cutoff:number}}
     */
    filter(x, y, dt) {
      if (!this.hasPrev) {
        this.hasPrev = true;
        this.xPrev = x;
        this.yPrev = y;
        this.xHat = x;
        this.yHat = y;
        this.speed = 0;
        this.cutoff = this.minCutoff;
        return { x, y, speed: 0, cutoff: this.cutoff };
      }

      if (!(dt > 0)) dt = 1 / 120;
      // Guard against huge gaps (tab was backgrounded, pointer teleported).
      if (dt > 0.2) dt = 0.2;

      // 1. Low-passed derivative estimate — this is what makes the filter
      //    robust against tremor, since the raw speed of a shaky hand is large
      //    but the smoothed speed of it is small.
      const aD = smoothingAlpha(this.dCutoff, dt);
      const rawVx = (x - this.xPrev) / dt;
      const rawVy = (y - this.yPrev) / dt;
      this.dxHat = aD * rawVx + (1 - aD) * this.dxHat;
      this.dyHat = aD * rawVy + (1 - aD) * this.dyHat;
      this.xPrev = x;
      this.yPrev = y;

      this.speed = Math.sqrt(this.dxHat * this.dxHat + this.dyHat * this.dyHat);

      // 2. Speed-adaptive cutoff.
      this.cutoff = this.minCutoff + this.beta * this.speed;
      const a = smoothingAlpha(this.cutoff, dt);

      // 3. Position smoothing.
      this.xHat = a * x + (1 - a) * this.xHat;
      this.yHat = a * y + (1 - a) * this.yHat;

      return { x: this.xHat, y: this.yHat, speed: this.speed, cutoff: this.cutoff };
    }
  }

  // --------------------------------------------------------------------------
  // StrokeSmoother — per-stroke state: filtering + point history + tension.
  // --------------------------------------------------------------------------
  const NET_WINDOW_MS = 80;   // window used to measure real (non-tremor) motion
  const LEAD_TAU = 0.022;     // fast low-pass on raw velocity, drives the lead
  class StrokeSmoother {
    constructor(strength01 = 0.75) {
      this.filter = new OneEuroFilter();
      this.pts = [];
      this.setStrength(strength01);
      this.reset();
    }

    /**
     * Map the user facing 0..1 strength onto filter parameters.
     * Higher strength => lower cutoff (more tremor removal) and a stronger
     * predictive lead so the stroke tip still tracks the cursor exactly.
     */
    setStrength(s01) {
      const s = clamp(s01, 0, 1);
      this.strength = s;
      // Cutoff floor: how aggressively a stationary pointer is flattened.
      // Interpolated geometrically so the slider feels linear to the hand.
      this.minCutoff = 12 * Math.pow(0.8 / 12, s);
      // Speed adaptation. Kept deliberately small: opening the cutoff up while
      // drawing is exactly what used to let 6-12 Hz hand tremor straight
      // through, and the predictive lead below already handles the lag.
      this.beta = lerp(0.0015, 0.006, s);
      // How much of the filter's residual delay we actively cancel.
      this.leadScale = 1.0;
      this.maxLead = lerp(30, 70, s);
      // Minimum travel (px) before a new anchor point is recorded.
      this.minStep = lerp(0.3, 1.0, s);
      // Smoothing time constant of the predictive lead vector.
      this.leadTau = lerp(0.08, 0.14, s);
      // How quickly the lead is given up when the pointer slows down.
      this.leadReleaseTau = 0.03;
      // Net-speed window below which no lead is applied at all.
      this.gateLo = 2.5;
      this.gateSpan = 20;
      // Window used to measure the real (non-tremor) direction of travel.
      this.netWindow = 110;
      // The lead is derived from the filter's own smoothed velocity: a raw
      // displacement estimate still carries the tremor and would paint it
      // straight back onto the line.
      this.leadSource = 'filter';
      this.blendWeight = 0.5;

      // Keep the live filter in sync so dragging the strength slider takes
      // effect during a stroke, not just between strokes.
      if (this.filter) {
        this.filter.minCutoff = this.minCutoff;
        this.filter.beta = this.beta;
      }
    }

    reset(x, y, t) {
      this.filter.reset();
      this.filter.minCutoff = this.minCutoff;
      this.filter.beta = this.beta;
      this.filter.dCutoff = 1.2;
      this.pts.length = 0;
      this.lastTime = t || 0;
      this.prevX = x;
      this.prevY = y;
      this.prevT = t || 0;
      this.anchorX = x;
      this.anchorY = y;
      this.anchorT = t || 0;
      this.lvx = 0;
      this.lvy = 0;
      this.leadLen = 0;
      this.dirX = 1;
      this.dirY = 0;
      this.lead = { x: 0, y: 0 };
      if (x !== undefined) {
        this.pts.push({ x, y });
        this.filter.filter(x, y, 1 / 60);
      }
    }

    /**
     * Feed one raw pointer sample.
     * @returns {{x:number,y:number,rawX:number,rawY:number,speed:number,
     *            added:boolean,lag:number}}
     */
    push(rawX, rawY, t) {
      let dt = this.lastTime ? (t - this.lastTime) / 1000 : 1 / 120;
      if (!(dt > 0)) dt = 1 / 120;
      if (dt > 0.2) dt = 0.2;
      this.lastTime = t;

      // Raw velocity, lightly smoothed — reacts quickly enough to cancel the
      // filter's start-up delay without amplifying per-sample jitter.
      const rawVx = (rawX - this.prevX) / dt;
      const rawVy = (rawY - this.prevY) / dt;
      const aFast = 1 - Math.exp(-dt / LEAD_TAU);
      this.lvx = aFast * rawVx + (1 - aFast) * this.lvx;
      this.lvy = aFast * rawVy + (1 - aFast) * this.lvy;

      // Net displacement over the last ~80ms. Tremor cancels itself out in
      // this window while genuine motion survives, so it is a clean signal for
      // "is the user actually drawing right now?".
      if (t - this.anchorT >= this.netWindow) {
        this.anchorT = this.prevT;
        this.anchorX = this.prevX;
        this.anchorY = this.prevY;
      }
      const netDt = Math.max(1e-4, (t - this.anchorT) / 1000);
      const netVx = (rawX - this.anchorX) / netDt;
      const netVy = (rawY - this.anchorY) / netDt;
      const netSpeed = Math.hypot(netVx, netVy);

      this.prevX = rawX;
      this.prevY = rawY;
      this.prevT = t;

      const res = this.filter.filter(rawX, rawY, dt);

      // ---- Predictive lead: cancel the filter's group delay -------------
      // The filtered point trails the raw pointer by roughly v * tau where
      // tau = 1/(2*pi*cutoff). Advancing along the net velocity puts the tip
      // back under the cursor. The net velocity is used (rather than the
      // instantaneous one) because tremor averages out over the window, so the
      // lead stays perfectly smooth instead of re-injecting the jitter the
      // filter just removed.
      const tau = 1 / (TAU * res.cutoff);
      // A pointer that has genuinely halted must not be pushed forward by the
      // predictive lead, otherwise the stroke would sail past its end point.
      const recentMove = Math.hypot(rawVx, rawVy) * dt;
      const halted = recentMove < 0.25 && netSpeed < 10;
      const gate = halted ? 0 : clamp((netSpeed - this.gateLo) / this.gateSpan, 0, 1);
      // Lead source: the filter's own low-passed velocity is far smoother than
      // a raw displacement estimate, so it re-injects much less tremor.
      let leadSpeed = netSpeed;
      let leadVx = netVx;
      let leadVy = netVy;
      if (this.leadSource === 'filter' || this.leadSource === 'blend') {
        const fvx = this.filter.dxHat;
        const fvy = this.filter.dyHat;
        leadSpeed = Math.hypot(fvx, fvy);
        if (this.leadSource === 'filter') {
          leadVx = fvx;
          leadVy = fvy;
        } else {
          // Blend the freshly measured direction with the filter's smoother
          // one: fresh enough not to lag on curves, smooth enough not to
          // re-inject tremor.
          const nLen = Math.hypot(netVx, netVy);
          const fLen = leadSpeed;
          const wf = this.blendWeight;
          if (nLen > 1e-4 && fLen > 1e-4) {
            leadVx = (1 - wf) * (netVx / nLen) + wf * (fvx / fLen);
            leadVy = (1 - wf) * (netVy / nLen) + wf * (fvy / fLen);
          } else {
            leadVx = fvx; leadVy = fvy;
          }
        }
      }
      const targetLen = Math.min(leadSpeed * tau * this.leadScale * gate, this.maxLead);

      // Attack slowly (a rising lead must never look jumpy) but release fast:
      // when the pointer stops, the lead has to disappear quicker than the
      // filter catches up, otherwise the stroke overshoots its end point.
      const leadTau = targetLen < this.leadLen ? this.leadReleaseTau : this.leadTau;
      const aLead = 1 - Math.exp(-dt / leadTau);
      this.leadLen = aLead * targetLen + (1 - aLead) * this.leadLen;

      // Direction comes from the net velocity, which is free of tremor.
      const dirLen = Math.hypot(leadVx, leadVy);
      if (dirLen > 1e-4) {
        const aDir = 1 - Math.exp(-dt / this.leadTau);
        const dx = leadVx / dirLen;
        const dy = leadVy / dirLen;
        this.dirX = aDir * dx + (1 - aDir) * this.dirX;
        this.dirY = aDir * dy + (1 - aDir) * this.dirY;
        const dLen = Math.hypot(this.dirX, this.dirY) || 1;
        this.lead.x = (this.dirX / dLen) * this.leadLen;
        this.lead.y = (this.dirY / dLen) * this.leadLen;
      } else {
        this.lead.x = 0;
        this.lead.y = 0;
      }

      const px = res.x + this.lead.x;
      const py = res.y + this.lead.y;

      const last = this.pts[this.pts.length - 1];
      let added = false;
      if (!last || Math.hypot(px - last.x, py - last.y) >= this.minStep) {
        this.pts.push({ x: px, y: py });
        // Keep a short tail; four points is enough for the spline.
        if (this.pts.length > 6) this.pts.shift();
        added = true;
      }

      return {
        x: px,
        y: py,
        rawX,
        rawY,
        speed: res.speed,
        added,
        lag: Math.hypot(px - rawX, py - rawY)
      };
    }

    /**
     * Append the exact pointer-up position as the final anchor. The predictive
     * lead normally runs a few pixels ahead of the cursor, so without this the
     * stroke would finish slightly past the point where the user released.
     * @returns {boolean} true when a new anchor was added
     */
    finish(rawX, rawY) {
      const last = this.pts[this.pts.length - 1];
      if (!last) {
        this.pts.push({ x: rawX, y: rawY });
        return true;
      }
      if (Math.hypot(rawX - last.x, rawY - last.y) < this.minStep) return false;
      this.pts.push({ x: rawX, y: rawY });
      if (this.pts.length > 6) this.pts.shift();
      return true;
    }

    /**
     * Per-point spline tension. Sharp direction changes get a tighter tension
     * so corners keep their character instead of ballooning into arcs.
     */
    tensionAt(index) {
      const p = this.pts;
      if (index <= 0 || index >= p.length - 1) return 1;
      const a = p[index - 1];
      const b = p[index];
      const c = p[index + 1];
      const v1x = b.x - a.x;
      const v1y = b.y - a.y;
      const v2x = c.x - b.x;
      const v2y = c.y - b.y;
      const l1 = Math.hypot(v1x, v1y);
      const l2 = Math.hypot(v2x, v2y);
      if (l1 < 1e-4 || l2 < 1e-4) return 1;
      const cos = clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1);
      const turn = Math.acos(cos); // 0 = straight, PI = full reversal
      const sharp = clamp(turn / (Math.PI * 0.55), 0, 1);
      return lerp(1, 0.55, sharp);
    }
  }

  // --------------------------------------------------------------------------
  // Centripetal Catmull-Rom -> cubic Bezier.
  // Centripetal parameterisation (alpha = 0.5) is used instead of the uniform
  // one because the anchor spacing here varies with drawing speed, and only
  // the centripetal variant is guaranteed never to loop or overshoot.
  // --------------------------------------------------------------------------
  function catmullRomToBezier(p0, p1, p2, p3, alpha = 0.5) {
    const d01 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const d23 = Math.hypot(p3.x - p2.x, p3.y - p2.y);

    const t0 = 0;
    const t1 = t0 + Math.pow(d01, alpha);
    const t2 = t1 + Math.pow(d12, alpha);
    const t3 = t2 + Math.pow(d23, alpha);

    if (!(t2 > t0) || !(t3 > t1) || !(t2 > t1)) {
      // Degenerate spacing — fall back to a straight line.
      return { c1x: p1.x, c1y: p1.y, c2x: p2.x, c2y: p2.y };
    }

    const m1Scale = ((t2 - t1) / (t2 - t0)) / 3;
    const m2Scale = ((t2 - t1) / (t3 - t1)) / 3;

    return {
      c1x: p1.x + (p2.x - p0.x) * m1Scale,
      c1y: p1.y + (p2.y - p0.y) * m1Scale,
      c2x: p2.x - (p3.x - p1.x) * m2Scale,
      c2y: p2.y - (p3.y - p1.y) * m2Scale
    };
  }

  global.WPSmoothing = {
    OneEuroFilter,
    StrokeSmoother,
    catmullRomToBezier,
    smoothingAlpha
  };
})(typeof window !== 'undefined' ? window : globalThis);
