/**
 * Central app state module.
 * Keeps shared data and mode transitions in one place for easier debugging.
 */

export const PHASES = {
  IDLE: "idle",
  AWAITING_GESTURE: "awaitingGesture",
  SUMMONING: "summoning",
  NAVIGATING: "navigating",
  SELECTING: "selecting",
  REVEALED: "revealed",
};

export function createAppState() {
  const state = {
    phase: PHASES.IDLE,
    question: "",
    selectedStarId: null,
    answer: "",
    hand: {
      landmarks: null,
      isTracking: false,
    },
    gesture: {
      confidence: 0,
      detected: false,
    },
  };

  const listeners = new Set();

  function snapshot() {
    return {
      ...state,
      hand: { ...state.hand },
      gesture: { ...state.gesture },
    };
  }

  function notify() {
    for (const listener of listeners) {
      listener(snapshot());
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(snapshot());
    return () => listeners.delete(listener);
  }

  return {
    getState() {
      return snapshot();
    },
    subscribe,
    setQuestion(question) {
      state.question = question.trim();
      if (!state.question) {
        state.phase = PHASES.IDLE;
      }
      notify();
    },
    setPhase(phase, context = {}) {
      state.phase = phase;
      if (Object.keys(context).length > 0) {
        console.debug("[AppState] phase ->", phase, context);
      } else {
        console.debug("[AppState] phase ->", phase);
      }
      notify();
    },
    setHandFrame(landmarks) {
      const wasTracking = state.hand.isTracking;
      const isTracking = Boolean(landmarks);
      state.hand.landmarks = landmarks;
      state.hand.isTracking = isTracking;

      // Hand frame references change every animation frame.
      // Notify only on tracking on/off transitions to avoid noisy state churn.
      if (wasTracking !== isTracking) {
        notify();
      }
    },
    setGestureProgress({ confidence = 0, detected = false }) {
      const confidenceDelta = Math.abs(state.gesture.confidence - confidence);
      const changedDetected = state.gesture.detected !== detected;
      state.gesture.confidence = confidence;
      state.gesture.detected = detected;

      // Confidence updates happen frequently while drawing; publish meaningful changes only.
      if (changedDetected || confidenceDelta >= 0.03) {
        notify();
      }
    },
    setSelectedStar(starId) {
      state.selectedStarId = starId;
      notify();
    },
    setAnswer(answer) {
      state.answer = answer;
      notify();
    },
    reset() {
      state.phase = PHASES.IDLE;
      state.question = "";
      state.selectedStarId = null;
      state.answer = "";
      state.hand.landmarks = null;
      state.hand.isTracking = false;
      state.gesture.confidence = 0;
      state.gesture.detected = false;
      notify();
    },
  };
}
