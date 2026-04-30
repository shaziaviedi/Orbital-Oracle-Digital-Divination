/**
 * Browser hand tracking module using MediaPipe Hand Landmarker (Tasks Vision).
 * Keeps hand input isolated so gesture/constellation logic can evolve separately.
 */

const MEDIAPIPE_WASM_ROOT =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const HAND_LANDMARKER_TASK_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

let mediaPipeModulePromise = null;

async function loadMediaPipeVisionModule() {
  if (!mediaPipeModulePromise) {
    mediaPipeModulePromise = import(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm"
    );
  }
  return mediaPipeModulePromise;
}

/**
 * @typedef {Object} HandFrame
 * @property {number} timestamp
 * @property {Array<Object>|null} landmarks - Primary hand landmarks (compat).
 * @property {Array<Object>|null} worldLandmarks - Primary world landmarks (compat).
 * @property {string|null} handedness - Primary handedness (compat).
 * @property {Array<Object>} hands - All detected hands with landmarks/handedness.
 */

export function createHandTracking({ videoElement, onFrame } = {}) {
  let vision = null;
  let handLandmarker = null;
  let stream = null;
  let rafId = null;
  let running = false;
  let initialized = false;
  let lastVideoTime = -1;

  const frameListeners = new Set();
  if (typeof onFrame === "function") {
    frameListeners.add(onFrame);
  }

  function emitFrame(frame) {
    for (const listener of frameListeners) {
      listener(frame);
    }
  }

  async function init() {
    if (initialized) return;

    if (!videoElement) {
      throw new Error("Hand tracking requires a valid webcam video element.");
    }

    const { FilesetResolver, HandLandmarker } = await loadMediaPipeVisionModule();

    // Load the vision runtime and initialize a two-hand VIDEO-mode landmarker.
    vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: HAND_LANDMARKER_TASK_URL,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    initialized = true;
  }

  async function ensureCamera() {
    if (stream) return;

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    videoElement.srcObject = stream;
    videoElement.autoplay = true;
    videoElement.muted = true;
    videoElement.playsInline = true;
    videoElement.setAttribute("autoplay", "");
    videoElement.setAttribute("muted", "");
    videoElement.setAttribute("playsinline", "");
    console.debug("[HandTracking] Camera stream assigned to video.", {
      hasSrcObject: Boolean(videoElement.srcObject),
    });

    // Wait for metadata so video dimensions are available before play diagnostics.
    if (videoElement.readyState < 1) {
      await new Promise((resolve) => {
        const onLoadedMetadata = () => {
          videoElement.removeEventListener("loadedmetadata", onLoadedMetadata);
          resolve();
        };
        videoElement.addEventListener("loadedmetadata", onLoadedMetadata);
      });
    }
    console.debug("[HandTracking] video loadedmetadata", {
      hasSrcObject: Boolean(videoElement.srcObject),
      videoWidth: videoElement.videoWidth,
      videoHeight: videoElement.videoHeight,
    });

    videoElement.addEventListener(
      "playing",
      () => {
        console.debug("[HandTracking] video playing", {
          videoWidth: videoElement.videoWidth,
          videoHeight: videoElement.videoHeight,
          currentTime: videoElement.currentTime,
        });
      },
      { once: true },
    );

    await videoElement.play();
    console.debug("[HandTracking] video.play() resolved", {
      hasSrcObject: Boolean(videoElement.srcObject),
      paused: videoElement.paused,
      readyState: videoElement.readyState,
      videoWidth: videoElement.videoWidth,
      videoHeight: videoElement.videoHeight,
      renderedWidth: videoElement.clientWidth,
      renderedHeight: videoElement.clientHeight,
    });
  }

  function trackFrame(timestamp) {
    if (!running || !handLandmarker) return;

    // Skip duplicate timestamps so detectForVideo processes each camera frame once.
    if (videoElement.currentTime !== lastVideoTime) {
      lastVideoTime = videoElement.currentTime;
      const result = handLandmarker.detectForVideo(videoElement, timestamp);

      const landmarksList = Array.isArray(result.landmarks) ? result.landmarks : [];
      const worldList = Array.isArray(result.worldLandmarks) ? result.worldLandmarks : [];
      const handednessList = Array.isArray(result.handednesses) ? result.handednesses : [];

      const hands = landmarksList.map((landmarks, index) => {
        const handednessEntry = handednessList[index]?.[0] ?? null;
        return {
          landmarks,
          worldLandmarks: worldList[index] ?? null,
          handedness: handednessEntry?.categoryName ?? null,
          score: handednessEntry?.score ?? null,
        };
      });
      const primaryHand = hands[0] ?? null;

      emitFrame({
        timestamp,
        landmarks: primaryHand?.landmarks ?? null,
        worldLandmarks: primaryHand?.worldLandmarks ?? null,
        handedness: primaryHand?.handedness ?? null,
        hands,
      });
    }

    rafId = window.requestAnimationFrame(trackFrame);
  }

  async function start() {
    if (running) return;
    await init();
    await ensureCamera();

    running = true;
    lastVideoTime = -1;
    rafId = window.requestAnimationFrame(trackFrame);
  }

  function stop() {
    running = false;

    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }

    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      stream = null;
    }

    if (videoElement) {
      videoElement.srcObject = null;
    }
  }

  function subscribe(listener) {
    frameListeners.add(listener);
    return () => {
      frameListeners.delete(listener);
    };
  }

  return {
    init,
    start,
    stop,
    subscribe,
    isInitialized() {
      return initialized;
    },
    isRunning() {
      return running;
    },
  };
}
