/**
 * Oracle engine module.
 * Loads oracle data and resolves star selections into structured readings.
 * The API is intentionally small so future keyword/category strategies can plug in.
 */

export async function loadOracleData(path = "./data/oracle.json") {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load oracle data: ${response.status}`);
  }
  return response.json();
}

function randomFromArray(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const index = Math.floor(Math.random() * items.length);
  return items[index];
}

const PROFILE_CONFIG = {
  decisive_circle: {
    label: "Decisive Circle",
    tone: "confident",
    weights: {
      yes: 3.8,
      move_forward: 3.4,
      trust: 3.3,
      clarity: 2.9,
      reveal: 2.8,
      commitment: 2.8,
      caution: 0.7,
      not_yet: 0.7,
    },
  },
  hesitant_circle: {
    label: "Hesitant Circle",
    tone: "tentative",
    weights: {
      unclear: 3.7,
      not_yet: 3.5,
      hidden: 3.2,
      caution: 2.9,
      reflection: 2.5,
      patience: 2.5,
      trust: 0.8,
      yes: 0.75,
    },
  },
  expansive_circle: {
    label: "Expansive Circle",
    tone: "possibility-driven",
    weights: {
      opportunity: 3.7,
      emergence: 3.3,
      transformation: 3.2,
      invitation: 2.8,
      seek: 2.8,
      expansion: 3.5,
      restraint: 0.75,
      pause: 0.75,
    },
  },
  fragmented_circle: {
    label: "Fragmented Circle",
    tone: "interrupted",
    weights: {
      obscured: 3.6,
      hidden: 3.2,
      ask_again_later: 3.3,
      fractured_path: 2.9,
      caution: 2.7,
      wait: 2.3,
      revelation: 0.7,
      trust: 0.7,
    },
  },
  deliberate_circle: {
    label: "Deliberate Circle",
    tone: "measured",
    weights: {
      patience: 3.8,
      timing: 3.3,
      reflection: 3.1,
      subtle_yes: 2.8,
      gather_more: 2.8,
      trust_slow_path: 2.9,
      strong_action: 0.7,
      immediate_movement: 0.7,
    },
  },
};

const DEFAULT_WEIGHT = 0.95;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function deriveGestureSignals(metrics = null) {
  const safe = metrics ?? {};
  const size = safe.sizeScore ?? 0.5;
  const circularity = safe.circularityScore ?? safe.circularity ?? 0.5;
  const speed = safe.speedScore ?? clamp01((safe.speed ?? 0.55) / 0.95);
  const steadiness = safe.steadinessScore ?? safe.steadiness ?? 0.5;
  const closure = safe.closureScore ?? safe.closureCompleteness ?? 0.5;
  const continuity = safe.continuityScore ?? clamp01(1 - (safe.discontinuityIndex ?? 0.25));
  const discontinuity = safe.discontinuityIndex ?? clamp01(1 - continuity);
  const jumpRatio = safe.jumpRatio ?? 0;
  const jumpSeverity = clamp01(jumpRatio / 0.22);
  const radialSpread = safe.radialSpread ?? clamp01((1 - circularity) * 0.62);
  const radialInstability = clamp01((radialSpread - 0.25) / 0.5);
  const fragmentedSignal = clamp01(
    (1 - closure) * 0.26 +
      (1 - continuity) * 0.22 +
      discontinuity * 0.18 +
      jumpSeverity * 0.18 +
      radialInstability * 0.1 +
      (1 - circularity) * 0.06,
  );
  const coherence = clamp01(
    closure * 0.34 + circularity * 0.28 + continuity * 0.24 + steadiness * 0.14,
  );
  const expansiveReadiness = clamp01(size * 0.46 + coherence * 0.54);

  return {
    size,
    circularity,
    speed,
    steadiness,
    closure,
    continuity,
    discontinuity,
    jumpRatio,
    jumpSeverity,
    radialSpread,
    radialInstability,
    fragmentedSignal,
    coherence,
    expansiveReadiness,
  };
}

function scoreProfiles(metrics = null) {
  const s = deriveGestureSignals(metrics);
  const expansivePenalty = clamp01(
    s.fragmentedSignal * 0.58 + s.jumpSeverity * 0.22 + s.radialInstability * 0.2,
  );
  let expansiveScore =
    s.size * 0.34 +
    s.circularity * 0.2 +
    s.closure * 0.17 +
    s.continuity * 0.16 +
    s.steadiness * 0.07 +
    s.coherence * 0.06;
  expansiveScore *= 1 - expansivePenalty * 0.62;

  let hesitantScore =
    (1 - s.speed) * 0.32 +
    (1 - s.size) * 0.22 +
    (1 - s.steadiness) * 0.13 +
    s.closure * 0.15 +
    s.continuity * 0.12 +
    s.circularity * 0.06;
  hesitantScore *= 1 - s.fragmentedSignal * 0.45;

  return {
    decisive_circle:
      s.circularity * 0.27 +
      s.speed * 0.23 +
      s.steadiness * 0.18 +
      s.closure * 0.2 +
      s.continuity * 0.08 +
      s.size * 0.04,
    hesitant_circle: hesitantScore,
    expansive_circle: expansiveScore,
    fragmented_circle:
      s.fragmentedSignal * 0.38 +
      clamp01((0.5 - s.closure) / 0.5) * 0.18 +
      clamp01((0.5 - s.continuity) / 0.5) * 0.16 +
      s.jumpSeverity * 0.14 +
      s.radialInstability * 0.08 +
      clamp01((0.48 - s.circularity) / 0.48) * 0.06,
    deliberate_circle:
      (1 - s.speed) * 0.32 +
      s.steadiness * 0.24 +
      s.closure * 0.22 +
      s.circularity * 0.14 +
      s.continuity * 0.08,
  };
}

function classifySummonStyle(metrics = null) {
  const scores = scoreProfiles(metrics);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const signals = deriveGestureSignals(metrics);
  let chosenRankIndex = 0;
  if (
    ranked[0]?.[0] === "expansive_circle" &&
    signals.fragmentedSignal >= 0.52 &&
    ranked.some(([id, score]) => id === "fragmented_circle" && ranked[0][1] - score <= 0.09)
  ) {
    const fragmentedIndex = ranked.findIndex(([id]) => id === "fragmented_circle");
    if (fragmentedIndex >= 0) {
      // Broad but broken gestures should prefer Fragmented over Expansive.
      chosenRankIndex = fragmentedIndex;
    }
  }
  if (
    ranked[chosenRankIndex]?.[0] === "fragmented_circle" &&
    ranked[1] &&
    signals.coherence >= 0.53 &&
    signals.fragmentedSignal <= 0.44
  ) {
    // Guardrail: avoid over-triggering Fragmented for coherent imperfect circles.
    chosenRankIndex = 1;
  }
  const [profileId, rawScore] = ranked[chosenRankIndex];
  const [, secondScore = 0] = ranked[1] ?? [];
  const config = PROFILE_CONFIG[profileId] ?? PROFILE_CONFIG.deliberate_circle;
  const confidence = clamp01(0.52 + (rawScore - secondScore) * 0.9);

  const reason =
    `coherence:${Number(signals.coherence.toFixed(2))} ` +
    `fragmented:${Number(signals.fragmentedSignal.toFixed(2))} ` +
    `size:${Number(signals.size.toFixed(2))} ` +
    `closure:${Number(signals.closure.toFixed(2))} ` +
    `continuity:${Number(signals.continuity.toFixed(2))} ` +
    `jump:${Number(signals.jumpRatio.toFixed(2))} ` +
    `radial:${Number(signals.radialSpread.toFixed(2))}`;

  return {
    profileId,
    profileLabel: config.label,
    tone: config.tone,
    confidence: Number(confidence.toFixed(3)),
    scores: Object.fromEntries(
      Object.entries(scores).map(([key, value]) => [key, Number(value.toFixed(3))]),
    ),
    scoreSignals: Object.fromEntries(
      Object.entries(signals).map(([key, value]) => [key, Number(value.toFixed(3))]),
    ),
    rankedCandidates: ranked.slice(0, 3).map(([id, score]) => ({
      profileId: id,
      profileLabel: PROFILE_CONFIG[id]?.label ?? id,
      score: Number(score.toFixed(3)),
    })),
    reason,
    categoryWeights: { ...config.weights },
  };
}

function weightedSampleWithoutReplacement(items, count, getWeight) {
  const pool = [...items];
  const picks = [];
  while (pool.length > 0 && picks.length < count) {
    const weights = pool.map((item) => Math.max(0.0001, getWeight(item)));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let roll = Math.random() * total;
    let chosenIndex = 0;
    for (let i = 0; i < pool.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) {
        chosenIndex = i;
        break;
      }
    }
    picks.push(pool[chosenIndex]);
    pool.splice(chosenIndex, 1);
  }
  return picks;
}

function inferVerdictFromCategory(category = "") {
  const map = {
    yes: "Yes",
    move_forward: "Yes",
    immediate_movement: "Yes",
    subtle_yes: "Yes",
    trust: "Trust It",
    trust_slow_path: "Trust It",
    commitment: "Proceed Carefully",
    clarity: "Proceed Carefully",
    reveal: "Hidden",
    revelation: "Hidden",
    hidden: "Hidden",
    obscured: "Hidden",
    caution: "Proceed Carefully",
    restraint: "Proceed Carefully",
    not_yet: "Not Yet",
    wait: "Wait",
    pause: "Wait",
    timing: "Not Yet",
    patience: "Not Yet",
    ask_again_later: "Wait",
    unclear: "Maybe",
    fractured_path: "Maybe",
    gather_more: "Maybe",
    reflection: "Maybe",
    seek: "Maybe",
    opportunity: "Yes",
    emergence: "Yes",
    transformation: "Proceed Carefully",
    invitation: "Yes",
    expansion: "Yes",
    strong_action: "Proceed Carefully",
  };
  return map[category] ?? "Maybe";
}

export function createOracleEngine(dataset) {
  const stars = Array.isArray(dataset?.stars)
    ? dataset.stars
    : Array.isArray(dataset?.divinations)
      ? dataset.divinations
      : [];
  const starsById = new Map(stars.map((star) => [star.id, star]));

  function buildReadingFromStar(star) {
    const shortAnswer =
      randomFromArray(star.short_answers) ??
      star.short_answer ??
      randomFromArray(star.answers) ??
      star.answer ??
      "The signal is faint. Ask again gently.";
    const interpretation =
      star.interpretation ??
      "The constellation answers, but softly. Stay with the question a little longer and let a clearer pattern gather.";
    const verdict = star.verdict ?? inferVerdictFromCategory(star.category);

    return {
      starId: star.id,
      title: star.title ?? "Unknown Star",
      category: star.category ?? "unclear",
      verdict,
      shortAnswer,
      interpretation,
      answerText: shortAnswer,
      symbol: star.symbol ?? "sigil",
      color: star.color ?? "#cfd8f2",
    };
  }

  function getWeightForCategory(category, weightMap) {
    return weightMap?.[category] ?? DEFAULT_WEIGHT;
  }

  return {
    classifySummon(metrics) {
      return classifySummonStyle(metrics);
    },
    getBiasedStars({ summonMetrics = null, count = 8 } = {}) {
      const summon = classifySummonStyle(summonMetrics);
      const targetCount = Math.max(1, Math.min(count, stars.length));
      const preferredCategories = Object.entries(summon.categoryWeights)
        .filter(([, weight]) => weight >= 2.4)
        .map(([category]) => category);

      const preferredPool = stars.filter((star) => preferredCategories.includes(star.category));
      const primaryCount = Math.max(1, Math.min(targetCount, Math.round(targetCount * 0.72)));
      const primary = weightedSampleWithoutReplacement(
        preferredPool.length > 0 ? preferredPool : stars,
        primaryCount,
        (star) => getWeightForCategory(star.category, summon.categoryWeights),
      );

      const primaryIds = new Set(primary.map((star) => star.id));
      const remainingPool = stars.filter((star) => !primaryIds.has(star.id));
      const remainder = weightedSampleWithoutReplacement(
        remainingPool,
        targetCount - primary.length,
        (star) => {
          const base = getWeightForCategory(star.category, summon.categoryWeights);
          // Keep mystery: lower-weight categories are slightly boosted in remainder picks.
          return base < 1.2 ? base + 0.35 : base;
        },
      );
      const sampled = [...primary, ...remainder];
      return {
        stars: sampled,
        trace: {
          summonMetrics,
          profile: summon,
          preferredCategories,
          sampledCategories: sampled.map((star) => star.category),
          sampledIds: sampled.map((star) => star.id),
        },
      };
    },
    getStars() {
      return stars;
    },
    getStarById(starId) {
      return starsById.get(starId) ?? null;
    },
    /**
     * Resolve a reading from a selected star.
     * `context` is reserved for future expansion (question keywords, category weighting, etc).
     */
    getReading({ starId, context = {} } = {}) {
      const star = starsById.get(starId);
      if (!star) {
        return {
          starId: starId ?? null,
          title: "Uncharted Star",
          category: "unclear",
          verdict: "Hidden",
          shortAnswer: "The sky is unreadable in this moment. Trace the circle once more.",
          interpretation:
            "Your question has touched a threshold where the symbols are not stable yet. Return after one intentional pause, and ask the same question with cleaner language and steadier breath.",
          answerText: "The sky is unreadable in this moment. Trace the circle once more.",
          symbol: "veil",
          color: "#cfd8f2",
          context,
        };
      }

      return {
        ...buildReadingFromStar(star),
        context: {
          ...context,
          summon: classifySummonStyle(context?.summonMetrics ?? null),
        },
      };
    },
    // Backward-compatible helper while the rest of the app migrates.
    getAnswer({ starId }) {
      return this.getReading({ starId }).answerText;
    },
  };
}
