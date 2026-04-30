/**
 * Practical circle gesture detector for index fingertip traces.
 *
 * Input expectation:
 * - x/y are normalized screen coordinates (MediaPipe style: roughly 0..1).
 * - timestamp is milliseconds (performance.now or Date.now).
 *
 * The detector uses simple heuristics:
 * 1) Enough movement traveled
 * 2) Path starts and ends near each other (closure)
 * 3) Path covers many directions around its center (angular coverage)
 * 4) Gesture is recent (time window), so stale traces do not trigger
 */

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export class CircleGestureDetector {
  constructor(options = {}) {
    this.maxPoints = options.maxPoints ?? 90;
    this.maxDurationMs = options.maxDurationMs ?? 1900;
    this.minDurationMs = options.minDurationMs ?? 280;
    this.minPoints = options.minPoints ?? 18;
    this.minTravelDistance = options.minTravelDistance ?? 0.42;
    this.angleBins = options.angleBins ?? 12;
    this.minCoverage = options.minCoverage ?? 0.68;
    this.minWindingTurns = options.minWindingTurns ?? 0.7;
    this.maxClosureRatio = options.maxClosureRatio ?? 1.05;

    this.points = [];
    this.lastMetrics = null;
  }

  /**
   * Add one fingertip sample to the rolling buffer.
   * Points that are too close to the previous point are ignored
   * to reduce tiny jitter from camera noise.
   */
  addPoint(x, y, timestamp) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(timestamp)) {
      return;
    }

    const next = { x, y, t: timestamp };
    const prev = this.points[this.points.length - 1];
    if (prev && dist(prev, next) < 0.0025) {
      return;
    }

    this.points.push(next);
    this.#prune(timestamp);
  }

  reset() {
    this.points = [];
    this.lastMetrics = null;
  }

  /**
   * Evaluate the current buffer and return detection confidence.
   * Returns:
   * - success: true if heuristics pass
   * - confidence: 0..1 combined score
   */
  detect() {
    if (this.points.length < this.minPoints) {
      this.lastMetrics = null;
      return { success: false, confidence: 0 };
    }

    const first = this.points[0];
    const last = this.points[this.points.length - 1];
    const duration = last.t - first.t;
    if (duration < this.minDurationMs || duration > this.maxDurationMs) {
      this.lastMetrics = null;
      return { success: false, confidence: 0.05 };
    }

    const center = this.#computeCenter(this.points);
    const movement = this.#computeTravelDistance(this.points);
    const radii = this.points.map((p) => dist(p, center));
    const meanRadius = radii.reduce((sum, r) => sum + r, 0) / radii.length;

    if (meanRadius < 0.035) {
      this.lastMetrics = null;
      return { success: false, confidence: 0.05 };
    }

    const closureDistance = dist(first, last);
    const closureRatio = closureDistance / meanRadius;
    const coverage = this.#computeAngularCoverage(this.points, center, meanRadius);
    const windingInfo = this.#computeWindingInfo(this.points, center);
    const windingTurns = windingInfo.turns;
    const roundness = this.#computeRoundness(radii, meanRadius);
    const steadiness = this.#computeSteadiness(this.points);
    const closureCompleteness = clamp01(1 - closureRatio / this.maxClosureRatio);
    const speed = movement / Math.max(duration / 1000, 0.0001);
    const sizeScore = clamp01((meanRadius - 0.04) / 0.2);
    const circularityScore = roundness;
    const speedScore = clamp01(speed / 0.95);
    const steadinessScore = steadiness;
    const closureScoreMetric = closureCompleteness;
    const decisiveness = clamp01(speedScore * 0.7 + closureScoreMetric * 0.3);

    const movementScore = clamp01(
      (movement - this.minTravelDistance) / (this.minTravelDistance * 1.2),
    );
    const closureScore = clamp01(1 - closureRatio / this.maxClosureRatio);
    const coverageScore = clamp01((coverage - this.minCoverage) / (1 - this.minCoverage));
    const windingScore = clamp01(windingTurns / 1.05);
    const roundnessScore = roundness;

    // Weighted average: movement + coverage + closure are the strongest signals.
    const confidence =
      movementScore * 0.26 +
      coverageScore * 0.26 +
      closureScore * 0.24 +
      windingScore * 0.14 +
      roundnessScore * 0.1;

    const success =
      movement >= this.minTravelDistance &&
      closureRatio <= this.maxClosureRatio &&
      coverage >= this.minCoverage &&
      windingTurns >= this.minWindingTurns &&
      confidence >= 0.68;

    this.lastMetrics = {
      pointCount: this.points.length,
      durationMs: duration,
      travelDistance: Number(movement.toFixed(4)),
      meanRadius: Number(meanRadius.toFixed(4)),
      circularity: Number(circularityScore.toFixed(3)),
      coverage: Number(coverage.toFixed(3)),
      windingTurns: Number(windingTurns.toFixed(3)),
      direction: windingInfo.direction,
      signedWindingTurns: Number(windingInfo.signedTurns.toFixed(3)),
      closureRatio: Number(closureRatio.toFixed(3)),
      closureCompleteness: Number(closureCompleteness.toFixed(3)),
      decisiveness: Number(decisiveness.toFixed(3)),
      steadiness: Number(steadinessScore.toFixed(3)),
      speed: Number(speed.toFixed(3)),
      sizeScore: Number(sizeScore.toFixed(3)),
      circularityScore: Number(circularityScore.toFixed(3)),
      speedScore: Number(speedScore.toFixed(3)),
      steadinessScore: Number(steadinessScore.toFixed(3)),
      closureScore: Number(closureScoreMetric.toFixed(3)),
      confidence: Number(confidence.toFixed(3)),
      success,
    };

    return {
      success,
      confidence: Number(confidence.toFixed(3)),
      metrics: this.lastMetrics,
    };
  }

  getMetrics() {
    return this.lastMetrics ? { ...this.lastMetrics } : null;
  }

  getTracePoints() {
    return this.points.map((p) => ({ ...p }));
  }

  #prune(latestTimestamp) {
    const cutoff = latestTimestamp - this.maxDurationMs;
    this.points = this.points.filter((p) => p.t >= cutoff);
    if (this.points.length > this.maxPoints) {
      this.points = this.points.slice(this.points.length - this.maxPoints);
    }
  }

  #computeCenter(points) {
    const sum = points.reduce(
      (acc, p) => {
        acc.x += p.x;
        acc.y += p.y;
        return acc;
      },
      { x: 0, y: 0 },
    );

    return {
      x: sum.x / points.length,
      y: sum.y / points.length,
    };
  }

  #computeTravelDistance(points) {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      total += dist(points[i - 1], points[i]);
    }
    return total;
  }

  #computeAngularCoverage(points, center, meanRadius) {
    const bins = new Array(this.angleBins).fill(false);
    const minUsefulRadius = meanRadius * 0.45;

    for (const point of points) {
      const radius = dist(point, center);
      if (radius < minUsefulRadius) continue;

      const angle = Math.atan2(point.y - center.y, point.x - center.x);
      const normalized = (angle + Math.PI) / (Math.PI * 2);
      const bin = Math.min(this.angleBins - 1, Math.floor(normalized * this.angleBins));
      bins[bin] = true;
    }

    const covered = bins.filter(Boolean).length;
    return covered / this.angleBins;
  }

  #computeWindingInfo(points, center) {
    let totalDelta = 0;

    for (let i = 1; i < points.length; i += 1) {
      const prevAngle = Math.atan2(points[i - 1].y - center.y, points[i - 1].x - center.x);
      const nextAngle = Math.atan2(points[i].y - center.y, points[i].x - center.x);
      let delta = nextAngle - prevAngle;

      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      totalDelta += delta;
    }

    const signedTurns = totalDelta / (Math.PI * 2);
    const turns = Math.abs(signedTurns);
    const direction = signedTurns < 0 ? "clockwise" : "counterclockwise";
    return { turns, signedTurns, direction };
  }

  #computeRoundness(radii, meanRadius) {
    const variance =
      radii.reduce((sum, r) => sum + (r - meanRadius) ** 2, 0) / Math.max(radii.length, 1);
    const stdDev = Math.sqrt(variance);
    const normalizedSpread = stdDev / Math.max(meanRadius, 0.0001);
    return clamp01(1 - normalizedSpread / 0.65);
  }

  #computeSteadiness(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    const segments = [];
    for (let i = 1; i < points.length; i += 1) {
      segments.push(dist(points[i - 1], points[i]));
    }
    const mean = average(segments);
    if (mean <= 0.0001) return 0;
    const variance = average(segments.map((value) => (value - mean) ** 2));
    const stdDev = Math.sqrt(variance);
    const normalizedJitter = stdDev / mean;
    return clamp01(1 - normalizedJitter / 1.2);
  }
}

/**
 * Compatibility wrapper for existing app wiring.
 * Existing code can feed MediaPipe landmarks and get a callback when a circle is detected.
 */
export function createGestureCircleDetector({ onCircleDetected } = {}) {
  const detector = new CircleGestureDetector();
  let fired = false;

  return {
    update({ landmarks, timestamp }) {
      if (!landmarks || !landmarks[8] || fired) return;

      const tip = landmarks[8];
      const t = Number.isFinite(timestamp) ? timestamp : performance.now();
      detector.addPoint(tip.x, tip.y, t);

      const result = detector.detect();
      if (result.success) {
        fired = true;
        onCircleDetected?.(result);
      }
    },
    reset() {
      fired = false;
      detector.reset();
    },
    detect() {
      return detector.detect();
    },
  };
}
