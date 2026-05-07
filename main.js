import { createAppState, PHASES } from "./src/app-state.js";
import { createHandTracking } from "./src/hand-tracking.js";
import { CircleGestureDetector } from "./src/gesture-circle.js";
import {
  setConstellationMotionPaused,
  appendSummonTrailPoint,
  createConstellationFromData,
  getHoveredStar,
  hideConstellation,
  hideRitualCircle,
  lockSummonTrail,
  highlightStar,
  initThreeScene,
  resetSummonTrail,
  rotateConstellation,
  zoomConstellation,
  setConstellationDimmed,
  setTargetingStar,
  showConstellation,
  initLandingStarfield,
  setLandingStarfieldVisible,
} from "./src/three-scene.js";
import { createOracleEngine, loadOracleData } from "./src/oracle-engine.js";

/**
 * Main entrypoint.
 * Wires hand tracking + gesture detection into a clear ritual state flow.
 */

const CIRCLE_CONFIDENCE_THRESHOLD = 0.56;
const SUMMONING_DELAY_MS = 1100;
const STAR_HOLD_TO_SELECT_MS = 1200;
const REVEAL_DELAY_MS = 520;
const DRAW_CAPTURE_DURATION = 36000; // Safety cap; completion is gated by revolutions.
const MIN_REVOLUTIONS_REQUIRED = 3;
const SUMMON_DEBUG_LOG_INTERVAL_MS = 260;
const SUMMON_POSE_HOLD_FRAMES = 2;
const SUMMON_FINGERTIP_GRACE_FRAMES = 8;
const ROTATE_POINT_GRACE_FRAMES = 6;
const PINCH_THRESHOLD = 0.055;
const OPEN_FINGER_THRESHOLD = 1.08;
const FIST_CURLED_FINGER_THRESHOLD = 3;

// Rotation tuning values are intentionally explicit for easy classroom demos.
const rotationSensitivityX = 5.2; // Horizontal fingertip motion -> yaw
const rotationSensitivityY = 4.2; // Vertical fingertip motion -> pitch
const smoothingFactor = 0.32;
const SUMMON_INSTRUCTION =
  "Show one hand with the index and middle finger raised.";

const HAND_CONNECTIONS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
];
const PROFILE_LABEL_TO_KEY = {
  "Decisive Circle": "decisive",
  "Hesitant Circle": "hesitant",
  "Expansive Circle": "expansive",
  "Fragmented Circle": "fragmented",
  "Deliberate Circle": "deliberate",
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function drawHandOverlay({
  canvas,
  hands,
  roles = {},
}) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);

  const roleByKey = new Map([
    [roles.pauseHandKey, "pause"],
    [roles.selectionHandKey, "selection"],
    [roles.openEnablerKey, "open"],
    [roles.rotationControlKey, "rotate"],
    [roles.zoomHandAKey, "zoom"],
    [roles.zoomHandBKey, "zoom"],
  ]);

  for (const hand of hands) {
    const landmarks = hand.landmarks;
    if (!Array.isArray(landmarks) || landmarks.length < 21) continue;
    const role = roleByKey.get(hand.key) ?? "none";
    const lineColor =
      role === "pause"
        ? "rgba(255,180,180,0.86)"
        : role === "selection"
          ? "rgba(255,227,163,0.92)"
          : role === "rotate"
            ? "rgba(170,214,255,0.9)"
            : role === "zoom"
              ? "rgba(197,171,255,0.86)"
              : "rgba(194,208,241,0.6)";

    ctx.lineWidth = 1.4;
    ctx.strokeStyle = lineColor;
    for (const [a, b] of HAND_CONNECTIONS) {
      const p1 = landmarks[a];
      const p2 = landmarks[b];
      if (!p1 || !p2) continue;
      const x1 = (1 - p1.x) * width;
      const y1 = p1.y * height;
      const x2 = (1 - p2.x) * width;
      const y2 = p2.y * height;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    for (let i = 0; i < landmarks.length; i += 1) {
      const p = landmarks[i];
      const x = (1 - p.x) * width;
      const y = p.y * height;
      const isIndexTip = i === 8;
      const activeIndex =
        isIndexTip &&
        (role === "selection" || role === "rotate" || role === "zoom");
      ctx.fillStyle = activeIndex ? "rgba(255,220,120,0.96)" : "rgba(216,228,255,0.82)";
      const radius = activeIndex ? 4.5 : 2.1;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function createHoverDwellSelector({
  holdDurationMs = STAR_HOLD_TO_SELECT_MS,
  onProgress,
  onSelected,
} = {}) {
  let activeStarId = null;
  let activeSince = 0;
  let selected = false;

  function reset() {
    activeStarId = null;
    activeSince = 0;
    selected = false;
    onProgress?.(null, 0);
  }

  function update({ starId, timestamp }) {
    if (selected) return;

    if (!starId) {
      if (activeStarId !== null) {
        activeStarId = null;
        activeSince = 0;
        onProgress?.(null, 0);
      }
      return;
    }

    if (starId !== activeStarId) {
      activeStarId = starId;
      activeSince = timestamp;
      onProgress?.(activeStarId, 0);
      return;
    }

    const elapsed = Math.max(0, timestamp - activeSince);
    const progress = clamp(elapsed / holdDurationMs, 0, 1);
    onProgress?.(activeStarId, progress);

    if (progress >= 1) {
      selected = true;
      onSelected?.(activeStarId, progress);
    }
  }

  return { update, reset };
}

function normalizedToClientPoint(point, containerElement) {
  if (!point || !containerElement) return null;
  const rect = containerElement.getBoundingClientRect();
  // Camera and overlay are mirrored horizontally; hit-testing must mirror once too.
  const mirroredX = 1 - point.x;
  return {
    clientX: rect.left + mirroredX * rect.width,
    clientY: rect.top + point.y * rect.height,
  };
}

function distance2D(a, b) {
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getPalmCenter(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length === 0) return null;
  const indices = [0, 5, 9, 13, 17];
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const index of indices) {
    const point = landmarks[index];
    if (!point) continue;
    sumX += point.x;
    sumY += point.y;
    count += 1;
  }
  if (count === 0) return null;
  return { x: sumX / count, y: sumY / count };
}

function isFingerExtended(landmarks, tipIdx, pipIdx, mcpIdx, palm, ratio = 1.08) {
  const tip = landmarks?.[tipIdx];
  const pip = landmarks?.[pipIdx];
  const mcp = landmarks?.[mcpIdx];
  if (!tip || !pip || !mcp || !palm) return false;
  const tipToPalm = distance2D(tip, palm);
  const pipToPalm = distance2D(pip, palm);
  return tipToPalm > pipToPalm * ratio && tipToPalm > distance2D(mcp, palm) * 1.05;
}

function isFingerCurled(landmarks, tipIdx, pipIdx, mcpIdx, palm) {
  const tip = landmarks?.[tipIdx];
  const pip = landmarks?.[pipIdx];
  const mcp = landmarks?.[mcpIdx];
  if (!tip || !pip || !mcp || !palm) return false;
  const tipToPalm = distance2D(tip, palm);
  const pipToPalm = distance2D(pip, palm);
  const mcpToPalm = distance2D(mcp, palm);
  return tipToPalm < pipToPalm * 0.94 || tipToPalm < mcpToPalm * 0.86;
}

function getHandDebugMetrics(landmarks) {
  const palm = getPalmCenter(landmarks);
  if (!palm) return null;
  const thumbTip = landmarks?.[4];
  const indexTip = landmarks?.[8];
  const pinchDistance = thumbTip && indexTip ? distance2D(thumbTip, indexTip) : null;
  const indexExtended = isFingerExtended(landmarks, 8, 6, 5, palm, 1.08);
  const curledOthers = [
    [12, 10, 9],
    [16, 14, 13],
    [20, 18, 17],
  ].reduce((count, [tip, pip, mcp]) => {
    return count + (isFingerCurled(landmarks, tip, pip, mcp, palm) ? 1 : 0);
  }, 0);
  return {
    indexExtended,
    curledOthers,
    pinchDistance,
  };
}

function isFistRaw(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) return false;
  const palm = getPalmCenter(landmarks);
  if (!palm) return false;
  // A clear pointing index should not be swallowed by fist detection.
  if (isFingerExtended(landmarks, 8, 6, 5, palm, 1.07)) {
    return false;
  }
  const fingerTriples = [
    [8, 6, 5], // index: tip, pip, mcp
    [12, 10, 9], // middle
    [16, 14, 13], // ring
    [20, 18, 17], // pinky
  ];
  let curledCount = 0;
  for (const [tipIdx, pipIdx, mcpIdx] of fingerTriples) {
    const tip = landmarks[tipIdx];
    const pip = landmarks[pipIdx];
    const mcp = landmarks[mcpIdx];
    if (!tip || !pip || !mcp) continue;
    const tipToPalm = distance2D(tip, palm);
    const pipToPalm = distance2D(pip, palm);
    const mcpToPalm = distance2D(mcp, palm);
    // A folded finger tends to bring the tip meaningfully closer to the palm.
    const curled = tipToPalm < pipToPalm * 0.94 || tipToPalm < mcpToPalm * 0.86;
    if (curled) {
      curledCount += 1;
    }
  }
  const thumbTip = landmarks[4];
  const thumbMcp = landmarks[2];
  const indexMcp = landmarks[5];
  const thumbCurled =
    thumbTip && thumbMcp && indexMcp
      ? distance2D(thumbTip, palm) < distance2D(thumbMcp, palm) * 0.96 &&
        distance2D(thumbTip, indexMcp) < 0.19
      : false;

  // Accept a clear fist even if thumb is partially visible.
  return (
    curledCount >= FIST_CURLED_FINGER_THRESHOLD && (thumbCurled || curledCount >= 4)
  );
}

function isPointRaw(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) return false;
  const palm = getPalmCenter(landmarks);
  if (!palm) return false;
  if (isPinchRaw(landmarks)) return false;
  const indexExtended = isFingerExtended(landmarks, 8, 6, 5, palm, 1.08);
  if (!indexExtended) return false;
  const curledOthers = [
    [12, 10, 9],
    [16, 14, 13],
    [20, 18, 17],
  ].reduce((count, [tip, pip, mcp]) => {
    return count + (isFingerCurled(landmarks, tip, pip, mcp, palm) ? 1 : 0);
  }, 0);
  // Pointing is tolerant: index clearly extended, at least two fingers folded.
  return curledOthers >= 2;
}

function isSummonRaw(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) return false;
  const palm = getPalmCenter(landmarks);
  if (!palm) return false;
  if (isPinchRaw(landmarks)) return false;
  const indexExtended = isFingerExtended(landmarks, 8, 6, 5, palm, 1.08);
  const middleExtended = isFingerExtended(landmarks, 12, 10, 9, palm, 1.07);
  if (!indexExtended || !middleExtended) return false;
  const ringCurled = isFingerCurled(landmarks, 16, 14, 13, palm);
  const pinkyCurled = isFingerCurled(landmarks, 20, 18, 17, palm);
  return ringCurled && pinkyCurled;
}

function isPinchRaw(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) return false;
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  const middleTip = landmarks[12];
  const wrist = landmarks[0];
  if (!thumbTip || !indexTip || !middleTip || !wrist) return false;
  const pinchDistance = distance2D(thumbTip, indexTip);
  const middleDistance = distance2D(thumbTip, middleTip);
  return pinchDistance < PINCH_THRESHOLD && middleDistance > pinchDistance * 1.35;
}

function isOpenRaw(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) return false;
  const wrist = landmarks[0];
  const fingerPairs = [
    [8, 6],
    [12, 10],
    [16, 14],
    [20, 18],
  ];
  let extended = 0;
  for (const [tipIdx, pipIdx] of fingerPairs) {
    const tip = landmarks[tipIdx];
    const pip = landmarks[pipIdx];
    if (!tip || !pip) continue;
    if (distance2D(tip, wrist) > distance2D(pip, wrist) * OPEN_FINGER_THRESHOLD) {
      extended += 1;
    }
  }
  return extended >= 3;
}

function classifyHandRaw(landmarks) {
  // Explicit priority keeps states distinct and debuggable:
  // Pinch > Summon > Point > Fist > Open > Unknown.
  if (isPinchRaw(landmarks)) return "Pinch";
  if (isSummonRaw(landmarks)) return "Summon";
  if (isPointRaw(landmarks)) return "Point";
  if (isFistRaw(landmarks)) return "Fist";
  if (isOpenRaw(landmarks)) return "Open";
  return "Unknown";
}

function createHandStateDebouncer() {
  const perHand = new Map();

  function update(handKey, rawLabel) {
    const entry = perHand.get(handKey) ?? {
      stableLabel: rawLabel === "Unknown" ? "Unknown" : rawLabel,
      candidate: rawLabel,
      count: 1,
    };

    if (rawLabel === entry.stableLabel) {
      entry.candidate = rawLabel;
      entry.count = Math.min(10, entry.count + 1);
    } else if (rawLabel === "Unknown" && entry.stableLabel !== "Unknown") {
      // Hold onto a known state a bit longer to avoid rapid Unknown flicker.
      if (entry.candidate !== "Unknown") {
        entry.candidate = "Unknown";
        entry.count = 1;
      } else {
        entry.count += 1;
        if (entry.count >= 6) {
          entry.stableLabel = "Unknown";
        }
      }
    } else if (rawLabel === entry.candidate) {
      entry.count += 1;
      if (entry.count >= 2) {
        entry.stableLabel = rawLabel;
      }
    } else {
      entry.candidate = rawLabel;
      entry.count = 1;
    }
    perHand.set(handKey, entry);
    return entry.stableLabel;
  }
  return { update };
}

function createZoomController() {
  let prevDistance = null;
  let zoomVelocity = 0;
  const zoomDamping = 0.72;
  const zoomGain = 2.6;
  const zoomDeadzone = 0.003;

  function reset() {
    prevDistance = null;
    zoomVelocity = 0;
  }

  function update({ pointA, pointB }) {
    if (!pointA || !pointB) {
      zoomVelocity *= zoomDamping;
      return { zoomDelta: 0 };
    }
    const handDistance = distance2D(pointA, pointB);
    if (!prevDistance) {
      prevDistance = handDistance;
      return { zoomDelta: 0 };
    }
    const distDelta = handDistance - prevDistance;
    prevDistance = handDistance;
    const safeDistDelta = Math.abs(distDelta) < zoomDeadzone ? 0 : distDelta;
    zoomVelocity = zoomVelocity * zoomDamping + safeDistDelta * zoomGain;
    return { zoomDelta: clamp(zoomVelocity, -0.022, 0.022) };
  }

  return { reset, update };
}

function createRotationController({
  rotationSensitivityX: sensitivityX = rotationSensitivityX,
  rotationSensitivityY: sensitivityY = rotationSensitivityY,
  smoothing = smoothingFactor,
} = {}) {
  let prevPoint = null;
  let prevTimestamp = null;
  let smoothed = { x: 0, y: 0 };

  function reset() {
    prevPoint = null;
    prevTimestamp = null;
    smoothed = { x: 0, y: 0 };
  }

  function update({ controlPoint, timestamp }) {
    if (!controlPoint) return { rotateX: 0, rotateY: 0 };
    if (!prevPoint) {
      prevPoint = { x: controlPoint.x, y: controlPoint.y };
      prevTimestamp = timestamp;
      return { rotateX: 0, rotateY: 0 };
    }

    const dt = Math.max(8, Math.min(40, timestamp - (prevTimestamp ?? timestamp)));
    prevTimestamp = timestamp;
    const frameScale = dt / 16.67;
    const dx = controlPoint.x - prevPoint.x;
    const dy = controlPoint.y - prevPoint.y;
    prevPoint = { x: controlPoint.x, y: controlPoint.y };

    // Horizontal fingertip movement controls yaw, vertical controls pitch.
    const targetYaw = -dx * sensitivityX * frameScale;
    const targetPitch = -dy * sensitivityY * frameScale;
    smoothed.x += (targetPitch - smoothed.x) * smoothing;
    smoothed.y += (targetYaw - smoothed.y) * smoothing;

    return {
      rotateX: clamp(smoothed.x, -0.16, 0.16),
      rotateY: clamp(smoothed.y, -0.2, 0.2),
    };
  }

  return { reset, update };
}

/**
 * Single source of truth for navigation mode and hand roles.
 * Priority: pause > zoom > rotate > none.
 */
function resolveInteractionMode(hands = []) {
  const fistHand = hands.find((hand) => hand.stableLabel === "Fist") ?? null;
  if (fistHand) {
    const selectionHand =
      hands.find((hand) => hand.key !== fistHand.key && hand.stableLabel === "Point" && hand.indexTip) ??
      hands.find((hand) => hand.key !== fistHand.key && hand.indexTip) ??
      null;
    return { mode: "pause", pauseHand: fistHand, selectionHand };
  }

  const pinchHands = hands
    .filter((hand) => hand.stableLabel === "Pinch" && (hand.pinchPoint || hand.palm))
    .slice(0, 2);
  if (pinchHands.length === 2) {
    return { mode: "zoom", zoomHands: pinchHands };
  }

  const pointHands = hands.filter((hand) => hand.stableLabel === "Point" && hand.indexTip);
  if (pointHands.length > 0) {
    const rotationHand = pointHands[0];
    const anchorHand =
      hands.find((hand) => hand.key !== rotationHand.key && hand.stableLabel === "Open") ?? null;
    return { mode: "rotate", anchorHand, rotationHand };
  }

  return { mode: "none" };
}

function formatRevolutionProgress(current = 0, required = 1) {
  const whole = Math.max(0, Math.floor(current));
  return `${Math.min(whole, required)}/${required}`;
}

function mapHandsToLeftRightLabels(hands = [], getLabel = () => "Unknown") {
  let left = "Unknown";
  let right = "Unknown";
  for (const hand of hands) {
    const label = getLabel(hand);
    const side = String(hand?.handedness ?? "").toLowerCase();
    if (side.includes("left") && left === "Unknown") {
      left = label;
      continue;
    }
    if (side.includes("right") && right === "Unknown") {
      right = label;
      continue;
    }
    if (left === "Unknown") {
      left = label;
    } else if (right === "Unknown") {
      right = label;
    }
  }
  return { left, right };
}

async function bootstrap() {
  console.debug("[OrbitalOracle] bootstrap started.");
  const appState = createAppState();
  const oracleApp = document.querySelector(".oracle-app");
  const landingScreen = document.getElementById("landing-screen");
  const ritualScreen = document.getElementById("ritual-screen");
  const landingSceneContainer = document.getElementById("landing-scene-root");
  const videoElement = document.getElementById("hand-video");
  const handOverlay = document.getElementById("hand-overlay");
  const sceneContainer = document.getElementById("scene-root");
  const beginButton = document.getElementById("begin-button");
  const questionInput = document.getElementById("question-input");
  const questionError = document.getElementById("question-error");
  const statusText = document.getElementById("status-text");
  const handDetectionCard = document.getElementById("hand-detection-card");
  const hand1State = document.getElementById("hand1-state");
  const hand2State = document.getElementById("hand2-state");
  const activeModeText = document.getElementById("active-mode");
  const profileCurrent = document.getElementById("profile-current");
  const profileConfidence = document.getElementById("profile-confidence");
  const metricCircularity = document.getElementById("metric-circularity");
  const metricClosure = document.getElementById("metric-closure");
  const metricSteadiness = document.getElementById("metric-steadiness");
  const metricContinuity = document.getElementById("metric-continuity");
  const metricRevolutions = document.getElementById("metric-revolutions");
  const profileTop2 = document.getElementById("profile-top2");
  const profileReason = document.getElementById("profile-reason");
  const profileRows = {
    decisive: document.getElementById("profile-decisive"),
    hesitant: document.getElementById("profile-hesitant"),
    expansive: document.getElementById("profile-expansive"),
    fragmented: document.getElementById("profile-fragmented"),
    deliberate: document.getElementById("profile-deliberate"),
  };
  const resultPanel = document.getElementById("result-panel");
  const resultQuestion = document.getElementById("result-question");
  const resultVerdict = document.getElementById("result-verdict");
  const resultStar = document.getElementById("result-star");
  const resultShortAnswer = document.getElementById("result-short-answer");
  const oracleAnswer = document.getElementById("oracle-answer");
  const againButton = document.getElementById("again-button");
  const ritualOnboardingOverlay = document.getElementById("ritual-onboarding-overlay");
  const summonOnboardingCard = document.getElementById("summon-onboarding-card");
  const constellationOnboardingCard = document.getElementById("constellation-onboarding-card");
  const summonOnboardingContinue = document.getElementById("summon-onboarding-continue");
  const constellationOnboardingContinue = document.getElementById("constellation-onboarding-continue");

  if (
    !oracleApp ||
    !videoElement ||
    !landingScreen ||
    !ritualScreen ||
    !landingSceneContainer ||
    !handOverlay ||
    !sceneContainer ||
    !beginButton ||
    !questionInput ||
    !questionError ||
    !statusText ||
    !handDetectionCard ||
    !hand1State ||
    !hand2State ||
    !activeModeText ||
    !profileCurrent ||
    !profileConfidence ||
    !metricCircularity ||
    !metricClosure ||
    !metricSteadiness ||
    !metricContinuity ||
    !metricRevolutions ||
    !profileTop2 ||
    !profileReason ||
    Object.values(profileRows).some((node) => !node) ||
    !resultPanel ||
    !resultQuestion ||
    !resultVerdict ||
    !resultStar ||
    !resultShortAnswer ||
    !oracleAnswer ||
    !againButton ||
    !ritualOnboardingOverlay ||
    !summonOnboardingCard ||
    !constellationOnboardingCard ||
    !summonOnboardingContinue ||
    !constellationOnboardingContinue
  ) {
    throw new Error("Missing required DOM nodes for hand tracking or 3D scene.");
  }
  console.debug("[OrbitalOracle] Begin button query result:", beginButton);

  let oracleData = { stars: [] };
  try {
    oracleData = await loadOracleData();
  } catch (error) {
    console.error("Oracle data failed to load:", error);
  }
  const oracleEngine = createOracleEngine(oracleData);
  let sceneReady = true;
  let landingSceneReady = true;
  try {
    initLandingStarfield(landingSceneContainer);
  } catch (error) {
    landingSceneReady = false;
    console.error("Landing starfield initialization failed:", error);
  }
  try {
    initThreeScene(sceneContainer);
    hideRitualCircle();
    setConstellationDimmed(false);
  } catch (error) {
    sceneReady = false;
    console.error("Three.js renderer initialization failed:", error);
    ritualScreen.classList.add("scene-unavailable");
  }
  let constellationReady = false;

  const circleDetector = new CircleGestureDetector({
    maxPoints: 1800,
    maxDurationMs: DRAW_CAPTURE_DURATION,
    minDurationMs: 980,
    minCoverage: 0.54,
    minTravelDistance: 0.28,
    minWindingTurns: 0.58,
    minRevolutions: MIN_REVOLUTIONS_REQUIRED,
  });
  const zoomController = createZoomController();
  const rotationController = createRotationController();
  const handStateDebouncer = createHandStateDebouncer();
  let hoverDwellSelector = null;
  let hasSummoned = false;
  let navigationLocked = false;
  let summonTimerId = null;
  let revealTimerId = null;
  let lastStatusText = "";
  let lastControlMode = "None";
  let summonMetrics = null;
  let summonStyle = null;
  let lastSummonDebugLogMs = 0;
  let lastGesturePoint = null;
  let summonPoseStableFrames = 0;
  let summonFingertipMissingFrames = 0;
  let summonPoseLatched = false;
  let rotatePointLatchHandKey = null;
  let rotatePointMissingFrames = 0;
  let lastResolvedMode = "none";
  let onboardingStep = "none";
  let hasShownSummonIntro = false;
  let hasShownNavigationIntro = false;

  function setStatus(message) {
    if (message === lastStatusText) return;
    lastStatusText = message;
    statusText.textContent = message;
  }

  function hideOnboardingCards() {
    summonOnboardingCard.classList.add("is-hidden");
    constellationOnboardingCard.classList.add("is-hidden");
  }

  function dismissOnboarding() {
    onboardingStep = "none";
    ritualOnboardingOverlay.classList.add("is-hidden");
    hideOnboardingCards();
  }

  function showOnboarding(step) {
    hideOnboardingCards();
    onboardingStep = step;
    ritualOnboardingOverlay.classList.remove("is-hidden");
    if (step === "summon") {
      summonOnboardingCard.classList.remove("is-hidden");
      hasShownSummonIntro = true;
      return;
    }
    constellationOnboardingCard.classList.remove("is-hidden");
    hasShownNavigationIntro = true;
  }

  function getNavigationStatusLine({
    handsCount = 0,
    resolutionMode = "none",
    hoveredStarId = null,
    navigationLocked: isNavigationLocked = false,
  }) {
    if (onboardingStep === "navigation") {
      return "Navigation intro active: review the modes, then press Continue.";
    }
    if (isNavigationLocked) {
      return "Selection confirmed. Reading the sign...";
    }
    if (handsCount === 0) {
      return "No hand detected. Show your hands to continue.";
    }
    if (resolutionMode === "zoom") {
      return "Zoom mode: move your hands closer and farther away.";
    }
    if (resolutionMode === "rotate") {
      return "Rotate mode: use a pointing hand to guide the constellation.";
    }
    if (resolutionMode === "pause") {
      return hoveredStarId
        ? "Pause mode: hold on the highlighted star to reveal."
        : "Pause mode: make a fist with one hand and choose with the other.";
    }
    if (handsCount === 1) {
      return "One hand detected. Add another hand or change gesture.";
    }
    return "Mode idle: use pinch, point, or fist + point.";
  }

  function formatMetric(value, digits = 2) {
    if (!Number.isFinite(value)) return "--";
    return Number(value).toFixed(digits);
  }

  function clearProfileSelection() {
    for (const row of Object.values(profileRows)) {
      row.classList.remove("is-active");
    }
  }

  function updateProfileDebugPanel(metrics = null, style = null) {
    const currentLabel = style?.profileLabel ?? "--";
    profileCurrent.textContent = currentLabel;
    profileConfidence.textContent = Number.isFinite(style?.confidence)
      ? `${Math.round(style.confidence * 100)}%`
      : "--";
    metricCircularity.textContent = formatMetric(metrics?.circularityScore ?? metrics?.circularity);
    metricClosure.textContent = formatMetric(metrics?.closureScore ?? metrics?.closureCompleteness);
    metricSteadiness.textContent = formatMetric(metrics?.steadinessScore ?? metrics?.steadiness);
    metricContinuity.textContent = formatMetric(metrics?.continuityScore);
    metricRevolutions.textContent = formatMetric(metrics?.revolutions);

    const top = Array.isArray(style?.rankedCandidates) ? style.rankedCandidates.slice(0, 2) : [];
    profileTop2.textContent =
      top.length > 0
        ? top.map((candidate) => `${candidate.profileLabel} (${candidate.score.toFixed(2)})`).join(" | ")
        : "--";
    profileReason.textContent = style?.reason ?? "--";

    clearProfileSelection();
    const key = PROFILE_LABEL_TO_KEY[currentLabel] ?? null;
    if (key && profileRows[key]) {
      profileRows[key].classList.add("is-active");
    }
  }

  function transitionTo(phase, context = {}) {
    appState.setPhase(phase, context);
    const showDetectionCard =
      phase === PHASES.NAVIGATING || phase === PHASES.SELECTING || phase === PHASES.REVEALED;
    handDetectionCard.classList.toggle("is-hidden", !showDetectionCard);
  }

  function setQuestionValidation(message = "") {
    questionError.textContent = message;
    questionError.classList.toggle("is-visible", Boolean(message));
  }

  function showLandingScreen() {
    oracleApp.classList.remove("results-active");
    oracleApp.classList.remove("ritual-active");
    landingScreen.classList.remove("is-hidden");
    ritualScreen.classList.add("is-hidden");
    resultPanel.hidden = true;
    videoElement.classList.remove("is-hidden");
    hand1State.textContent = "Unknown";
    hand2State.textContent = "Unknown";
    activeModeText.textContent = "None";
    updateProfileDebugPanel(null, null);
    drawHandOverlay({ canvas: handOverlay, hands: [], roles: {} });
    if (landingSceneReady) {
      setLandingStarfieldVisible(true);
    }
  }

  function showRitualScreen() {
    oracleApp.classList.remove("results-active");
    oracleApp.classList.add("ritual-active");
    console.debug("[OrbitalOracle] Switching UI to ritual screen.");
    landingScreen.classList.add("is-hidden");
    ritualScreen.classList.remove("is-hidden");
    videoElement.classList.remove("is-hidden");
    // Force visible webcam layer in case previous state/styles collapsed it.
    videoElement.style.display = "block";
    videoElement.style.visibility = "visible";
    videoElement.style.opacity = "1";
    videoElement.style.width = "100%";
    videoElement.style.height = "100%";
    videoElement.style.objectFit = "cover";
    // Scene container was hidden on load; force resize so renderer gets real dimensions.
    window.dispatchEvent(new Event("resize"));
    if (landingSceneReady) {
      setLandingStarfieldVisible(false);
    }
    console.debug("[OrbitalOracle] Ritual screen shown.");
    const videoRect = videoElement.getBoundingClientRect();
    console.debug("[OrbitalOracle] Webcam element metrics", {
      width: Math.round(videoRect.width),
      height: Math.round(videoRect.height),
      opacity: getComputedStyle(videoElement).opacity,
      visibility: getComputedStyle(videoElement).visibility,
      display: getComputedStyle(videoElement).display,
      zIndex: getComputedStyle(videoElement).zIndex,
    });
  }

  function showResultPanel() {
    oracleApp.classList.add("results-active");
    if (landingSceneReady) {
      setLandingStarfieldVisible(true);
    }
    resultPanel.hidden = false;
    window.requestAnimationFrame(() => {
      resultPanel.classList.add("is-visible");
    });
  }

  function hideResultPanel() {
    oracleApp.classList.remove("results-active");
    resultPanel.classList.remove("is-visible");
    window.setTimeout(() => {
      if (!resultPanel.classList.contains("is-visible")) {
        resultPanel.hidden = true;
      }
    }, 650);
  }

  function formatQuestionForResultDisplay(question = "") {
    const trimmed = String(question ?? "").trim();
    if (!trimmed) return "";
    const withLeadingCap = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
    return withLeadingCap.endsWith("?") ? withLeadingCap : `${withLeadingCap}?`;
  }

  function applyReadingToUI({ question, reading }) {
    resultQuestion.textContent = formatQuestionForResultDisplay(question);
    resultVerdict.textContent = reading.verdict ?? "Unclear";
    resultStar.textContent = reading.title;
    resultShortAnswer.textContent = reading.shortAnswer ?? reading.answerText;
    oracleAnswer.textContent = reading.interpretation ?? reading.answerText;
    resultPanel.style.setProperty("--result-accent", reading.color ?? "#b7a171");
  }

  function revealOracleReading(starId) {
    const question = appState.getState().question;
    const reading = oracleEngine.getReading({
      starId,
      context: { question, summonMetrics, summonStyle },
    });

    applyReadingToUI({ question, reading });
    appState.setAnswer(reading.shortAnswer ?? reading.answerText);
    transitionTo(PHASES.REVEALED, { starId, category: reading.category });
    setStatus("The reading is revealed.");
    if (sceneReady) {
      setConstellationDimmed(true);
    }
    showResultPanel();
    handTracking.stop();
  }

  function clearTimers() {
    if (summonTimerId !== null) {
      clearTimeout(summonTimerId);
      summonTimerId = null;
    }
    if (revealTimerId !== null) {
      clearTimeout(revealTimerId);
      revealTimerId = null;
    }
  }

  function resetRitualInteractionState() {
    clearTimers();
    circleDetector.reset();
    zoomController.reset();
    rotationController.reset();
    hoverDwellSelector?.reset();
    hasSummoned = false;
    navigationLocked = false;
    lastControlMode = "None";
    summonMetrics = null;
    summonStyle = null;
    lastSummonDebugLogMs = 0;
    lastGesturePoint = null;
    summonPoseStableFrames = 0;
    summonFingertipMissingFrames = 0;
    summonPoseLatched = false;
    rotatePointLatchHandKey = null;
    rotatePointMissingFrames = 0;
    lastResolvedMode = "none";
    onboardingStep = "none";
    hasShownSummonIntro = false;
    hasShownNavigationIntro = false;
    dismissOnboarding();
    if (sceneReady) {
      constellationReady = false;
      setConstellationMotionPaused(false);
      resetSummonTrail();
      hideConstellation();
      setTargetingStar(null, 0);
      highlightStar(null);
      setConstellationDimmed(false);
      hideRitualCircle();
    }
    hand1State.textContent = "Unknown";
    hand2State.textContent = "Unknown";
    activeModeText.textContent = "None";
    setStatus("");
    updateProfileDebugPanel(null, null);
    drawHandOverlay({ canvas: handOverlay, hands: [], roles: {} });
  }

  hoverDwellSelector = createHoverDwellSelector({
    holdDurationMs: STAR_HOLD_TO_SELECT_MS,
    onProgress: (starId, progress) => {
      if (sceneReady) {
        setTargetingStar(starId, progress);
      }
      if (starId) {
        const pct = Math.round(progress * 100);
        setStatus(`Selection mode active: hold to reveal (${pct}%).`);
      }
    },
    onSelected: (starId) => {
      appState.setSelectedStar(starId);
      transitionTo(PHASES.SELECTING, { starId });
      if (sceneReady) {
        highlightStar(starId);
      }
      navigationLocked = true;
      zoomController.reset();
      rotationController.reset();
      setStatus("Star chosen. Reading the sign...");

      clearTimers();
      revealTimerId = window.setTimeout(() => {
        revealOracleReading(starId);
      }, REVEAL_DELAY_MS);
    },
  });

  function handleCircleRecognized(confidence, metrics = null) {
    if (hasSummoned) return;
    hasSummoned = true;
    summonMetrics = metrics ?? circleDetector.getMetrics?.() ?? null;
    summonStyle = oracleEngine.classifySummon(summonMetrics);

    transitionTo(PHASES.SUMMONING, { confidence });
    setStatus("Circle recognised. Summoning the oracle.");
    if (sceneReady) {
      lockSummonTrail();
    }

    clearTimers();

    summonTimerId = window.setTimeout(() => {
      // Keep ritual visible so Three.js can animate a smooth transformation.
      if (sceneReady) {
        if (!constellationReady) {
          try {
            const biased = oracleEngine.getBiasedStars({
              summonMetrics,
              count: 7,
            });
            createConstellationFromData({ stars: biased.stars });
            console.info("[Oracle Trace] Summon input -> constellation sampling", biased.trace);
            constellationReady = true;
          } catch (error) {
            console.error("Constellation setup failed (renderer still active):", error);
          }
        }
        if (constellationReady) {
          showConstellation();
        } else {
          console.warn("Constellation is unavailable.");
        }
        setConstellationDimmed(false);
      }
      zoomController.reset();
      rotationController.reset();
      hoverDwellSelector.reset();
      navigationLocked = false;
      transitionTo(PHASES.NAVIGATING, { source: "summoning_complete" });
      if (!hasShownNavigationIntro) {
        showOnboarding("navigation");
        setStatus("You summoned the constellation. Review the controls and continue.");
      } else {
        setStatus("Mode ready: pinch to zoom, point to rotate.");
      }
    }, SUMMONING_DELAY_MS);
  }

  const handTracking = createHandTracking({
    videoElement,
    onFrame: ({ landmarks, hands = [], timestamp }) => {
      appState.setHandFrame(landmarks);
      const phase = appState.getState().phase;

      if (phase !== PHASES.NAVIGATING) {
        rotatePointLatchHandKey = null;
        rotatePointMissingFrames = 0;
        const simpleHands = hands.map((hand, index) => ({
          ...hand,
          key: hand.handedness ?? `hand-${index}`,
          landmarks: hand.landmarks,
        }));
        drawHandOverlay({ canvas: handOverlay, hands: simpleHands, roles: {} });
        const mapped = mapHandsToLeftRightLabels(
          simpleHands,
          (hand) => classifyHandRaw(hand.landmarks) || "Unknown",
        );
        hand1State.textContent = mapped.left;
        hand2State.textContent = mapped.right;
        activeModeText.textContent = "None";
      }

      if (phase === PHASES.AWAITING_GESTURE) {
        if (onboardingStep === "summon") {
          setStatus("Summon intro active: press Begin to start.");
          return;
        }
        if (hands.length > 1) {
          setStatus("Show only one hand.");
          return;
        }
        const activeHand = hands.length === 1 ? hands[0] : null;
        const activeHandLabel = activeHand ? classifyHandRaw(activeHand.landmarks) : "Unknown";
        const indexTip = activeHand?.landmarks?.[8] ?? null;
        const middleTip = activeHand?.landmarks?.[12] ?? null;
        const hasSummonFingertips = indexTip != null && middleTip != null;
        const isSummonPoseActive =
          activeHandLabel === "Summon" && hasSummonFingertips;

        // Summon remains strict, but brief frame drops are tolerated to keep drawing smooth.
        if (isSummonPoseActive) {
          summonPoseStableFrames += 1;
          summonFingertipMissingFrames = 0;
          if (!summonPoseLatched && summonPoseStableFrames >= SUMMON_POSE_HOLD_FRAMES) {
            summonPoseLatched = true;
          }
        } else {
          summonPoseStableFrames = 0;
        }

        if (!summonPoseLatched) {
          setStatus(hands.length === 0 ? "No hand detected." : SUMMON_INSTRUCTION);
          updateProfileDebugPanel(null, null);
          return;
        }
        // After strict entry, continue drawing while fingertips remain trackable.
        if (!hasSummonFingertips) {
          summonFingertipMissingFrames += 1;
          if (summonFingertipMissingFrames > SUMMON_FINGERTIP_GRACE_FRAMES) {
            summonPoseLatched = false;
            summonFingertipMissingFrames = 0;
            lastGesturePoint = null;
            setStatus("No hand detected.");
            updateProfileDebugPanel(null, null);
          }
          return;
        }
        summonFingertipMissingFrames = 0;
        const sampleTimestamp = Number.isFinite(timestamp) ? timestamp : performance.now();
        const indexClient = normalizedToClientPoint(indexTip, sceneContainer);
        const middleClient = normalizedToClientPoint(middleTip, sceneContainer);
        let trailSpawn = null;
        if (sceneReady) {
          trailSpawn = appendSummonTrailPoint({ indexTip, middleTip });
        }

        const detectorPointRaw =
          middleTip != null
            ? { x: (indexTip.x + middleTip.x) * 0.5, y: (indexTip.y + middleTip.y) * 0.5 }
            : indexTip;
        const detectorPoint = lastGesturePoint
          ? {
              x: lastGesturePoint.x * 0.64 + detectorPointRaw.x * 0.36,
              y: lastGesturePoint.y * 0.64 + detectorPointRaw.y * 0.36,
            }
          : detectorPointRaw;
        lastGesturePoint = detectorPoint;
        circleDetector.addPoint(detectorPoint.x, detectorPoint.y, sampleTimestamp);
        const result = circleDetector.detect();
        const revolutions = result.metrics?.revolutions ?? 0;
        const angularTravel = result.metrics?.totalAngularTravel ?? 0;
        const evaluationLocked = result.metrics?.evaluationLocked ?? true;

        appState.setGestureProgress({
          confidence: result.confidence,
          detected: result.success,
        });
        const styleHint = oracleEngine.classifySummon(result.metrics ?? null);
        updateProfileDebugPanel(result.metrics ?? null, styleHint);
        const revolutionProgress = formatRevolutionProgress(
          result.metrics?.revolutions ?? 0,
          MIN_REVOLUTIONS_REQUIRED,
        );
        setStatus(
          `Circle in progress: ${revolutionProgress} revolutions.`,
        );

        if (sampleTimestamp - lastSummonDebugLogMs >= SUMMON_DEBUG_LOG_INTERVAL_MS) {
          lastSummonDebugLogMs = sampleTimestamp;
          console.debug("[Summon Debug]", {
            revolutions: Number(revolutions.toFixed(3)),
            totalAngularTravel: Number(angularTravel.toFixed(3)),
            evaluationLockedUntilThreeRevolutions: evaluationLocked,
            indexClientX: indexClient ? Number(indexClient.clientX.toFixed(1)) : null,
            indexClientY: indexClient ? Number(indexClient.clientY.toFixed(1)) : null,
            middleClientX: middleClient ? Number(middleClient.clientX.toFixed(1)) : null,
            middleClientY: middleClient ? Number(middleClient.clientY.toFixed(1)) : null,
            trailSpawnSources: trailSpawn?.sources?.map((source) => ({
              source: source.source,
              worldX: Number(source.worldX.toFixed(3)),
              worldY: Number(source.worldY.toFixed(3)),
              worldZ: Number(source.worldZ.toFixed(3)),
              mirroredX: Number(source.mirroredX.toFixed(3)),
              normalizedY: Number(source.normalizedY.toFixed(3)),
            })),
          });
        }

        if (result.success && result.confidence >= CIRCLE_CONFIDENCE_THRESHOLD) {
          handleCircleRecognized(result.confidence, result.metrics ?? null);
        }
      }

      if (phase === PHASES.NAVIGATING) {
        const normalizedHands = hands.map((hand, index) => {
          const handKey = hand.handedness ?? `hand-${index}`;
          const stableLabel = handStateDebouncer.update(handKey, classifyHandRaw(hand.landmarks));
          const debugMetrics = getHandDebugMetrics(hand.landmarks);
          return {
            ...hand,
            key: handKey,
            palm: getPalmCenter(hand.landmarks),
            pinchPoint:
              hand.landmarks?.[4] && hand.landmarks?.[8]
                ? {
                    x: (hand.landmarks[4].x + hand.landmarks[8].x) / 2,
                    y: (hand.landmarks[4].y + hand.landmarks[8].y) / 2,
                  }
                : null,
            indexTip: hand.landmarks?.[8] ?? null,
            stableLabel,
            debugMetrics,
          };
        });

        const mapped = mapHandsToLeftRightLabels(
          normalizedHands,
          (hand) => hand.stableLabel ?? "Unknown",
        );
        hand1State.textContent = mapped.left;
        hand2State.textContent = mapped.right;

        const resolution = resolveInteractionMode(normalizedHands);
        let roles = {};
        let hoveredStarId = null;
        let effectiveResolution = resolution;
        let modeReason = "direct-resolver";

        // Higher-priority modes must always override rotate stickiness immediately.
        if (resolution.mode === "pause" || resolution.mode === "zoom") {
          rotatePointLatchHandKey = null;
          rotatePointMissingFrames = 0;
        } else if (resolution.mode === "rotate" && resolution.rotationHand?.key) {
          rotatePointLatchHandKey = resolution.rotationHand.key;
          rotatePointMissingFrames = 0;
          modeReason = "direct-rotate";
        } else if (resolution.mode === "none" && rotatePointLatchHandKey) {
          // Sticky continuation only during ambiguity, never over a valid new mode.
          const latchedHand =
            normalizedHands.find((hand) => hand.key === rotatePointLatchHandKey) ?? null;
          if (latchedHand?.indexTip) {
            rotatePointMissingFrames = 0;
            effectiveResolution = {
              mode: "rotate",
              anchorHand: null,
              rotationHand: latchedHand,
            };
            modeReason = "rotate-sticky-fingertip";
          } else {
            rotatePointMissingFrames += 1;
            modeReason = "rotate-sticky-grace";
            if (rotatePointMissingFrames > ROTATE_POINT_GRACE_FRAMES) {
              rotatePointLatchHandKey = null;
              rotatePointMissingFrames = 0;
              modeReason = "rotate-sticky-expired";
            }
          }
        } else {
          rotatePointLatchHandKey = null;
          rotatePointMissingFrames = 0;
        }

        if (effectiveResolution.mode !== lastResolvedMode) {
          console.debug("[Mode Switch]", {
            from: lastResolvedMode,
            to: effectiveResolution.mode,
            baseMode: resolution.mode,
            reason: modeReason,
            latchedRotateHand: rotatePointLatchHandKey,
          });
          lastResolvedMode = effectiveResolution.mode;
        }

        // Mode priority is centralized in resolveInteractionMode.
        if (effectiveResolution.mode === "pause") {
          if (lastControlMode !== "Pause") {
            zoomController.reset();
            rotationController.reset();
          }
          const { pauseHand, selectionHand } = effectiveResolution;
          roles = {
            pauseHandKey: pauseHand?.key ?? null,
            selectionHandKey: selectionHand?.key ?? null,
          };
          zoomController.reset();
          rotationController.reset();
          if (sceneReady) {
            setConstellationMotionPaused(true);
          }
          const clientPoint = normalizedToClientPoint(selectionHand?.indexTip ?? null, sceneContainer);
          hoveredStarId =
            sceneReady && clientPoint ? getHoveredStar(clientPoint.clientX, clientPoint.clientY) : null;
        } else if (effectiveResolution.mode === "zoom") {
          if (lastControlMode !== "Zoom") {
            zoomController.reset();
            rotationController.reset();
          }
          const [handA, handB] = effectiveResolution.zoomHands;
          roles = {
            zoomHandAKey: handA.key,
            zoomHandBKey: handB.key,
          };
          if (!navigationLocked && onboardingStep !== "navigation" && sceneReady) {
            setConstellationMotionPaused(false);
            const zoom = zoomController.update({
              pointA: handA.pinchPoint ?? handA.palm,
              pointB: handB.pinchPoint ?? handB.palm,
            });
            zoomConstellation(zoom.zoomDelta);
          }
        } else if (effectiveResolution.mode === "rotate") {
          if (lastControlMode !== "Rotate") {
            zoomController.reset();
            rotationController.reset();
          }
          const anchorHand = effectiveResolution.anchorHand;
          const rotationControl = effectiveResolution.rotationHand;
          roles = {
            openEnablerKey: anchorHand?.key ?? null,
            rotationControlKey: rotationControl?.key ?? null,
          };

          if (
            !navigationLocked &&
            onboardingStep !== "navigation" &&
            sceneReady &&
            rotationControl?.indexTip
          ) {
            setConstellationMotionPaused(false);
            const rotate = rotationController.update({
              controlPoint: rotationControl.indexTip,
              timestamp,
            });
            rotateConstellation(rotate.rotateY, rotate.rotateX);
          } else {
            rotationController.reset();
          }
        } else {
          if (sceneReady) {
            setConstellationMotionPaused(false);
          }
          zoomController.reset();
          rotationController.reset();
        }
        const activeMode =
          effectiveResolution.mode === "pause"
            ? "Pause"
            : effectiveResolution.mode === "zoom"
              ? "Zoom"
              : effectiveResolution.mode === "rotate"
                ? "Rotate"
                : "None";

        lastControlMode = activeMode;

        activeModeText.textContent = activeMode;
        drawHandOverlay({
          canvas: handOverlay,
          hands: normalizedHands,
          roles,
        });

        hoverDwellSelector.update({
          starId:
            onboardingStep === "navigation"
              ? null
              : effectiveResolution.mode === "pause"
                ? hoveredStarId
                : null,
          timestamp,
        });

        if (
          appState.getState().selectedStarId &&
          !navigationLocked &&
          onboardingStep !== "navigation"
        ) {
          navigationLocked = true;
          zoomController.reset();
          rotationController.reset();
        }

        setStatus(
          getNavigationStatusLine({
            handsCount: normalizedHands.length,
            resolutionMode: effectiveResolution.mode,
            hoveredStarId,
            navigationLocked,
          }),
        );
      }
    },
  });

  summonOnboardingContinue.addEventListener("click", () => {
    dismissOnboarding();
    setStatus(SUMMON_INSTRUCTION);
  });

  constellationOnboardingContinue.addEventListener("click", () => {
    dismissOnboarding();
    setStatus("Mode ready: pinch to zoom, point to rotate.");
  });

  beginButton.addEventListener("click", async (event) => {
    event.preventDefault();
    console.debug("[OrbitalOracle] Begin Ritual click handler fired.");
    const question = questionInput.value.trim();
    if (!question) {
      setQuestionValidation("Please enter a question before beginning the ritual.");
      questionInput.focus();
      transitionTo(PHASES.IDLE, { reason: "missing_question" });
      return;
    }
    setQuestionValidation("");

    appState.setQuestion(question);
    appState.setSelectedStar(null);
    appState.setGestureProgress({ confidence: 0, detected: false });
    hideResultPanel();

    resetRitualInteractionState();

    console.debug("[OrbitalOracle] About to switch UI state.");
    showRitualScreen();
    transitionTo(PHASES.AWAITING_GESTURE, { reason: "begin_ritual_clicked" });
    if (!hasShownSummonIntro) {
      showOnboarding("summon");
      setStatus("Summon intro active: press Begin to start.");
    } else {
      setStatus(SUMMON_INSTRUCTION);
    }

    try {
      console.debug("[OrbitalOracle] About to start webcam/hand tracking.");
      await handTracking.start();
      console.debug("[OrbitalOracle] Webcam/hand tracking started successfully.");
      console.debug("[OrbitalOracle] Webcam post-start state", {
        hasSrcObject: Boolean(videoElement.srcObject),
        videoWidth: videoElement.videoWidth,
        videoHeight: videoElement.videoHeight,
        paused: videoElement.paused,
        readyState: videoElement.readyState,
      });
      if (!sceneReady) {
        setStatus("Camera started. Hand tracking is active. 3D overlay is unavailable.");
      }
    } catch (error) {
      console.debug("[OrbitalOracle] Webcam start failed.");
      console.error("Could not start hand tracking:", error);
      // Keep ritual screen visible and show a readable error.
      setStatus("Camera access failed. Please allow webcam permissions and try again.");
    }
  });

  againButton.addEventListener("click", () => {
    handTracking.stop();
    resetRitualInteractionState();
    hideResultPanel();
    appState.reset();
    questionInput.value = "";
    showLandingScreen();
    transitionTo(PHASES.IDLE, { source: "begin_another_ritual" });
    setQuestionValidation("");
    questionInput.focus();
  });

  // Initial UI state: landing only.
  showLandingScreen();
}

function startBootstrap() {
  bootstrap().catch((error) => {
    // Keep startup errors visible while app shell is still evolving.
    console.error("Orbital Oracle bootstrap failed:", error);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    console.debug("[OrbitalOracle] DOMContentLoaded fired.");
    startBootstrap();
  });
} else {
  console.debug("[OrbitalOracle] DOM already ready.");
  startBootstrap();
}
