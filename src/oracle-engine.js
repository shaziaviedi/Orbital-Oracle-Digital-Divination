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

function scoreProfiles(metrics = null) {
  const safe = metrics ?? {};
  const size = safe.sizeScore ?? 0.5;
  const circularity = safe.circularityScore ?? safe.circularity ?? 0.5;
  const speed = safe.speedScore ?? clamp01((safe.speed ?? 0.55) / 0.95);
  const steadiness = safe.steadinessScore ?? safe.steadiness ?? 0.5;
  const closure = safe.closureScore ?? safe.closureCompleteness ?? 0.5;
  const continuity = safe.continuityScore ?? clamp01(1 - (safe.discontinuityIndex ?? 0.25));
  const fragmentedSignal = clamp01(
    (1 - closure) * 0.32 +
      (1 - circularity) * 0.3 +
      (1 - continuity) * 0.28 +
      (1 - steadiness) * 0.1,
  );

  return {
    decisive_circle:
      circularity * 0.27 +
      speed * 0.23 +
      steadiness * 0.18 +
      closure * 0.2 +
      continuity * 0.08 +
      size * 0.04,
    hesitant_circle:
      (1 - speed) * 0.26 +
      (1 - closure) * 0.22 +
      (1 - steadiness) * 0.22 +
      (1 - size) * 0.2 +
      (1 - continuity) * 0.1,
    expansive_circle:
      size * 0.38 + circularity * 0.24 + steadiness * 0.18 + closure * 0.14 + continuity * 0.06,
    fragmented_circle:
      fragmentedSignal * 0.42 +
      clamp01((0.45 - closure) / 0.45) * 0.23 +
      clamp01((0.42 - circularity) / 0.42) * 0.2 +
      clamp01((0.48 - continuity) / 0.48) * 0.15,
    deliberate_circle:
      (1 - speed) * 0.32 +
      steadiness * 0.24 +
      closure * 0.22 +
      circularity * 0.14 +
      continuity * 0.08,
  };
}

function classifySummonStyle(metrics = null) {
  const scores = scoreProfiles(metrics);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const safe = metrics ?? {};
  const closure = safe.closureScore ?? safe.closureCompleteness ?? 0.5;
  const circularity = safe.circularityScore ?? safe.circularity ?? 0.5;
  const continuity = safe.continuityScore ?? clamp01(1 - (safe.discontinuityIndex ?? 0.25));
  let chosenRankIndex = 0;
  if (
    ranked[0]?.[0] === "fragmented_circle" &&
    ranked[1] &&
    closure >= 0.36 &&
    circularity >= 0.44 &&
    continuity >= 0.4
  ) {
    // Guardrail: avoid over-triggering fragmented for normal imperfect circles.
    chosenRankIndex = 1;
  }
  const [profileId, rawScore] = ranked[chosenRankIndex];
  const [, secondScore = 0] = ranked[1] ?? [];
  const config = PROFILE_CONFIG[profileId] ?? PROFILE_CONFIG.deliberate_circle;
  const confidence = clamp01(0.52 + (rawScore - secondScore) * 0.9);

  const reason = `circularity:${Number(circularity.toFixed(2))} closure:${Number(closure.toFixed(2))} steadiness:${Number((safe.steadinessScore ?? safe.steadiness ?? 0).toFixed(2))} continuity:${Number(continuity.toFixed(2))}`;

  return {
    profileId,
    profileLabel: config.label,
    tone: config.tone,
    confidence: Number(confidence.toFixed(3)),
    scores: Object.fromEntries(
      Object.entries(scores).map(([key, value]) => [key, Number(value.toFixed(3))]),
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

export function createOracleEngine(dataset) {
  const stars = Array.isArray(dataset?.stars)
    ? dataset.stars
    : Array.isArray(dataset?.divinations)
      ? dataset.divinations
      : [];
  const starsById = new Map(stars.map((star) => [star.id, star]));

  function buildReadingFromStar(star) {
    const selectedAnswer =
      randomFromArray(star.answers) ??
      star.answer ??
      "The signal is faint. Ask again gently.";

    return {
      starId: star.id,
      title: star.title ?? "Unknown Star",
      category: star.category ?? "unclear",
      answerText: selectedAnswer,
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
