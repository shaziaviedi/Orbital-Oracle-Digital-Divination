import * as THREE_MODULE from "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js";

/**
 * Three scene module for Orbital Oracle.
 * Exposes a small, stable API for rendering and interaction.
 */

let THREE_NS = null;

// Motion tuning kept explicit for easy classroom tweaking.
const IDLE_ROTATION_SPEED_Y = 0.00026;
const IDLE_ROTATION_SPEED_X = 0.00005;
const ROTATION_IMPULSE_X = 0.22;
const ROTATION_IMPULSE_Y = 0.24;
const ROTATION_DAMPING = 0.982;
const MAX_ANGULAR_VELOCITY = 0.016;
const MIN_ANGULAR_VELOCITY = 0.00003;
const TRAIL_FADE_MS = 1100;
const TRAIL_MAX_SAMPLES = 170;
const SUMMON_PARTICLE_LIFE_MS = 620;
const SUMMON_PARTICLE_MAX = 140;
const SUMMON_LINK_DISTANCE = 0.14;
const SUMMON_MAX_LINKS = 340;

const sceneState = {
  container: null,
  renderer: null,
  scene: null,
  camera: null,
  raycaster: null,
  pointerNdc: null,
  starMeshes: [],
  starById: new Map(),
  starPulseMeta: [],
  targetedStarId: null,
  targetProgress: 0,
  hoveredStarId: null,
  selectedStarId: null,
  ritualCircleGroup: null,
  ritualMaterials: [],
  ritualShimmer: null,
  ritualAnimation: null,
  summonTrailLine: null,
  summonTrailLayer: null,
  summonTrailMaterial: null,
  summonTrailSamples: [],
  summonGlowTexture: null,
  summonEmberCloud: null,
  summonEmberParticles: [],
  summonSpark: null,
  summonTrailLocked: false,
  constellationGroup: null,
  constellationLineMaterial: null,
  constellationDimCurrent: 0,
  constellationDimTarget: 0,
  angularVelocityX: 0,
  angularVelocityY: 0,
  motionPaused: false,
  lastFrameMs: null,
  starfield: null,
  resizeHandler: null,
};

function clearSummonTrailGeometry() {
  if (sceneState.summonTrailLine) {
    sceneState.summonTrailLine.geometry.setAttribute("position", new THREE_NS.Float32BufferAttribute([], 3));
    sceneState.summonTrailLine.geometry.computeBoundingSphere();
  }
  if (sceneState.summonTrailLayer) {
    sceneState.summonTrailLayer.geometry.setAttribute("position", new THREE_NS.Float32BufferAttribute([], 3));
    sceneState.summonTrailLayer.geometry.computeBoundingSphere();
  }
}

function rebuildSummonTrailGeometry(nowMs) {
  if (!sceneState.summonTrailLine || !sceneState.summonTrailMaterial || !sceneState.summonTrailLayer) {
    return;
  }
  if (!sceneState.summonTrailLocked) {
    const cutoff = nowMs - TRAIL_FADE_MS;
    sceneState.summonTrailSamples = sceneState.summonTrailSamples.filter((sample) => sample.t >= cutoff);
  }
  const pointPositions = [];
  for (const sample of sceneState.summonTrailSamples) {
    pointPositions.push(sample.position.x, sample.position.y, sample.position.z);
  }
  sceneState.summonTrailLayer.geometry.setAttribute(
    "position",
    new THREE_NS.Float32BufferAttribute(pointPositions, 3),
  );
  sceneState.summonTrailLayer.geometry.computeBoundingSphere();
  sceneState.summonTrailLayer.visible = pointPositions.length >= 6;

  // Linked-filament look: connect nearby recent points into luminous segments.
  const segmentPositions = [];
  let linkCount = 0;
  const samples = sceneState.summonTrailSamples;
  for (let i = 0; i < samples.length; i += 1) {
    const a = samples[i];
    for (let j = i + 1; j < samples.length; j += 1) {
      const b = samples[j];
      if (linkCount >= SUMMON_MAX_LINKS) break;
      const d = a.position.distanceTo(b.position);
      if (d <= SUMMON_LINK_DISTANCE) {
        segmentPositions.push(a.position.x, a.position.y, a.position.z);
        segmentPositions.push(b.position.x, b.position.y, b.position.z);
        linkCount += 1;
      }
    }
    if (linkCount >= SUMMON_MAX_LINKS) break;
  }
  sceneState.summonTrailLine.geometry.setAttribute(
    "position",
    new THREE_NS.Float32BufferAttribute(segmentPositions, 3),
  );
  sceneState.summonTrailLine.geometry.computeBoundingSphere();
  sceneState.summonTrailLine.visible = linkCount > 0;

  if (!sceneState.summonTrailLocked) {
    sceneState.summonTrailMaterial.opacity = sceneState.summonTrailSamples.length > 0 ? 0.42 : 0;
    sceneState.summonTrailLayer.material.opacity =
      sceneState.summonTrailSamples.length > 0
        ? Math.min(0.96, 0.35 + sceneState.summonTrailSamples.length / 220)
        : 0;
  }
}

function rebuildSummonEmberGeometry(nowMs) {
  if (!sceneState.summonEmberCloud) return;
  sceneState.summonEmberParticles = sceneState.summonEmberParticles
    .map((particle) => ({
      ...particle,
      position: particle.position.clone().add(particle.velocity),
    }))
    .filter((particle) => particle.expireAt > nowMs);

  const positions = [];
  for (const particle of sceneState.summonEmberParticles) {
    positions.push(particle.position.x, particle.position.y, particle.position.z);
  }
  sceneState.summonEmberCloud.geometry.setAttribute(
    "position",
    new THREE_NS.Float32BufferAttribute(positions, 3),
  );
  sceneState.summonEmberCloud.visible = positions.length > 0;
  sceneState.summonEmberCloud.material.opacity = Math.min(
    0.92,
    0.2 + sceneState.summonEmberParticles.length / 240,
  );
}

function toMirroredRitualPoint(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const mirroredX = 1 - point.x;
  return new THREE_NS.Vector3((mirroredX - 0.5) * 2.3, -(point.y - 0.5) * 2.3, 0.08);
}

function anchorRitualCircleToTrail() {
  if (!sceneState.ritualCircleGroup || sceneState.summonTrailSamples.length < 8) return;
  let sumX = 0;
  let sumY = 0;
  const pts = sceneState.summonTrailSamples.map((sample) => sample.position);
  for (const point of pts) {
    sumX += point.x;
    sumY += point.y;
  }
  const centerX = sumX / pts.length;
  const centerY = sumY / pts.length;
  const meanRadius =
    pts.reduce((sum, point) => sum + Math.hypot(point.x - centerX, point.y - centerY), 0) /
    pts.length;
  const targetScale = Math.max(0.82, Math.min(1.16, meanRadius / 0.62));
  sceneState.ritualCircleGroup.position.set(centerX, centerY, -0.03);
  sceneState.ritualCircleGroup.scale.set(targetScale, targetScale, targetScale);
}

function getThreeOrThrow() {
  // Use the globally loaded Three.js from index.html for maximal compatibility.
  THREE_NS = globalThis.THREE ?? THREE_MODULE ?? null;
  if (!THREE_NS) {
    throw new Error(
      "THREE is unavailable from both global script and module import.",
    );
  }
  return THREE_NS;
}

function createSoftGlowTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(
    size * 0.5,
    size * 0.5,
    0,
    size * 0.5,
    size * 0.5,
    size * 0.5,
  );
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,232,187,0.95)");
  gradient.addColorStop(0.55, "rgba(255,192,110,0.52)");
  gradient.addColorStop(1, "rgba(255,128,20,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE_NS.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function easeOutCubic(t) {
  const x = clamp01(t);
  return 1 - (1 - x) ** 3;
}

function easeInOutSine(t) {
  const x = clamp01(t);
  return -(Math.cos(Math.PI * x) - 1) / 2;
}

function createStarfield() {
  const starCount = 650;
  const positions = new Float32Array(starCount * 3);

  for (let i = 0; i < starCount; i += 1) {
    const i3 = i * 3;
    positions[i3] = (Math.random() - 0.5) * 26;
    positions[i3 + 1] = (Math.random() - 0.5) * 26;
    positions[i3 + 2] = -Math.random() * 30 - 2;
  }

  const geometry = new THREE_NS.BufferGeometry();
  geometry.setAttribute("position", new THREE_NS.BufferAttribute(positions, 3));

  const material = new THREE_NS.PointsMaterial({
    color: 0xaebfff,
    size: 0.035,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });

  return new THREE_NS.Points(geometry, material);
}

function createRitualCircleGroup() {
  const group = new THREE_NS.Group();
  sceneState.ritualMaterials = [];
  const outerLayer = new THREE_NS.Group();
  outerLayer.position.z = -0.08;
  outerLayer.userData.spin = -0.0012;
  const innerLayer = new THREE_NS.Group();
  innerLayer.position.z = 0.08;
  innerLayer.userData.spin = 0.0018;
  group.add(outerLayer, innerLayer);

  const outerRing = new THREE_NS.Mesh(
    new THREE_NS.RingGeometry(0.95, 1.02, 96),
    new THREE_NS.MeshBasicMaterial({
      color: 0xf0b05f,
      transparent: true,
      opacity: 0.0,
      side: THREE_NS.DoubleSide,
    }),
  );
  outerLayer.add(outerRing);
  sceneState.ritualMaterials.push(outerRing.material);

  const middleArc = new THREE_NS.Mesh(
    new THREE_NS.RingGeometry(0.74, 0.78, 96, 1, Math.PI * 0.15, Math.PI * 1.5),
    new THREE_NS.MeshBasicMaterial({
      color: 0xffd59e,
      transparent: true,
      opacity: 0.0,
      side: THREE_NS.DoubleSide,
    }),
  );
  middleArc.rotation.z = Math.PI * 0.35;
  outerLayer.add(middleArc);
  sceneState.ritualMaterials.push(middleArc.material);

  const innerRing = new THREE_NS.Mesh(
    new THREE_NS.RingGeometry(0.57, 0.61, 84),
    new THREE_NS.MeshBasicMaterial({
      color: 0xf9d08e,
      transparent: true,
      opacity: 0.0,
      side: THREE_NS.DoubleSide,
    }),
  );
  innerLayer.add(innerRing);
  sceneState.ritualMaterials.push(innerRing.material);

  const glyphArc = new THREE_NS.Mesh(
    new THREE_NS.RingGeometry(0.42, 0.46, 72, 1, Math.PI * 0.95, Math.PI * 1.2),
    new THREE_NS.MeshBasicMaterial({
      color: 0xffe2b0,
      transparent: true,
      opacity: 0.0,
      side: THREE_NS.DoubleSide,
    }),
  );
  innerLayer.add(glyphArc);
  sceneState.ritualMaterials.push(glyphArc.material);

  // Subtle repeating radial linework for ornamental rhythm.
  const ornamentMaterial = new THREE_NS.LineBasicMaterial({
    color: 0xffd49a,
    transparent: true,
    opacity: 0.0,
  });
  for (let i = 0; i < 24; i += 1) {
    const angle = (i / 24) * Math.PI * 2;
    const r0 = i % 2 === 0 ? 0.64 : 0.68;
    const r1 = i % 2 === 0 ? 0.88 : 0.84;
    const points = [
      new THREE_NS.Vector3(Math.cos(angle) * r0, Math.sin(angle) * r0, 0),
      new THREE_NS.Vector3(Math.cos(angle) * r1, Math.sin(angle) * r1, 0),
    ];
    const geometry = new THREE_NS.BufferGeometry().setFromPoints(points);
    const line = new THREE_NS.Line(geometry, ornamentMaterial);
    innerLayer.add(line);
  }
  sceneState.ritualMaterials.push(ornamentMaterial);

  // Small ring points create a decorative cadence without dominating the scene.
  const cadenceCount = 18;
  const cadencePositions = new Float32Array(cadenceCount * 3);
  for (let i = 0; i < cadenceCount; i += 1) {
    const i3 = i * 3;
    const angle = (i / cadenceCount) * Math.PI * 2;
    const radius = 0.74 + (i % 2) * 0.06;
    cadencePositions[i3] = Math.cos(angle) * radius;
    cadencePositions[i3 + 1] = Math.sin(angle) * radius;
    cadencePositions[i3 + 2] = 0.02;
  }
  const cadenceGeometry = new THREE_NS.BufferGeometry();
  cadenceGeometry.setAttribute("position", new THREE_NS.BufferAttribute(cadencePositions, 3));
  const cadenceMaterial = new THREE_NS.PointsMaterial({
    color: 0xffbf74,
    size: 0.02,
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
  });
  const cadencePoints = new THREE_NS.Points(cadenceGeometry, cadenceMaterial);
  innerLayer.add(cadencePoints);
  sceneState.ritualMaterials.push(cadenceMaterial);

  const shimmerCount = 120;
  const shimmerPositions = new Float32Array(shimmerCount * 3);
  for (let i = 0; i < shimmerCount; i += 1) {
    const i3 = i * 3;
    const angle = (i / shimmerCount) * Math.PI * 2;
    const radius = 1.05 + (Math.random() - 0.5) * 0.08;
    shimmerPositions[i3] = Math.cos(angle) * radius;
    shimmerPositions[i3 + 1] = Math.sin(angle) * radius;
    shimmerPositions[i3 + 2] = (Math.random() - 0.5) * 0.12;
  }
  const shimmerGeometry = new THREE_NS.BufferGeometry();
  shimmerGeometry.setAttribute("position", new THREE_NS.BufferAttribute(shimmerPositions, 3));
  const shimmerMaterial = new THREE_NS.PointsMaterial({
    color: 0xffddb0,
    size: 0.018,
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
  });
  const shimmerPoints = new THREE_NS.Points(shimmerGeometry, shimmerMaterial);
  outerLayer.add(shimmerPoints);
  sceneState.ritualMaterials.push(shimmerMaterial);
  sceneState.ritualShimmer = shimmerPoints;

  group.visible = false;
  group.scale.set(0.7, 0.7, 0.7);
  return group;
}

function getConstellationStars(data) {
  const all = Array.isArray(data?.stars) ? data.stars : [];
  if (all.length >= 7) return all.slice(0, 9);

  // Ensure we can still render a constellation even with sparse data during development.
  const padded = [...all];
  while (padded.length < 7) {
    const index = padded.length + 1;
    padded.push({
      id: `star-filler-${index}`,
      label: `Echo Star ${index}`,
    });
  }
  return padded;
}

function getConstellationPosition(index, count) {
  const normalized = count <= 1 ? 0 : index / (count - 1);
  const angle = normalized * Math.PI * 2 + Math.sin(index * 0.7) * 0.18;
  const radius = 0.82 + (index % 3) * 0.2 + Math.sin(index * 1.35) * 0.08;
  const z = Math.sin(index * 1.2) * 0.5 + (Math.random() - 0.5) * 0.16;
  return new THREE_NS.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, z);
}

function createConstellationLinks(positions) {
  const lineVertices = [];
  const maxDistance = 1.55;

  for (let i = 0; i < positions.length; i += 1) {
    let nearestA = null;
    let nearestB = null;

    for (let j = 0; j < positions.length; j += 1) {
      if (i === j) continue;
      const distance = positions[i].distanceTo(positions[j]);
      if (distance > maxDistance) continue;
      if (!nearestA || distance < nearestA.distance) {
        nearestB = nearestA;
        nearestA = { index: j, distance };
      } else if (!nearestB || distance < nearestB.distance) {
        nearestB = { index: j, distance };
      }
    }

    const candidates = [nearestA, nearestB].filter(Boolean);
    for (const candidate of candidates) {
      if (candidate.index < i) continue;
      lineVertices.push(positions[i].x, positions[i].y, positions[i].z);
      lineVertices.push(
        positions[candidate.index].x,
        positions[candidate.index].y,
        positions[candidate.index].z,
      );
    }
  }

  const lineGeometry = new THREE_NS.BufferGeometry();
  lineGeometry.setAttribute("position", new THREE_NS.Float32BufferAttribute(lineVertices, 3));
  const lineMaterial = new THREE_NS.LineBasicMaterial({
    color: 0xa9baf9,
    transparent: true,
    opacity: 0.42,
  });
  sceneState.constellationLineMaterial = lineMaterial;

  return new THREE_NS.LineSegments(lineGeometry, lineMaterial);
}

export function createConstellationFromData(data) {
  if (!sceneState.scene) {
    throw new Error("initThreeScene must be called before createConstellationFromData.");
  }

  if (sceneState.constellationGroup) {
    sceneState.scene.remove(sceneState.constellationGroup);
  }

  const group = new THREE_NS.Group();
  const stars = getConstellationStars(data);
  const count = stars.length;
  const positions = [];

  sceneState.starMeshes = [];
  sceneState.starById = new Map();
  sceneState.starPulseMeta = [];

  for (let i = 0; i < count; i += 1) {
    const starEntry = stars[i];
    const position = getConstellationPosition(i, count);
    positions.push(position);

    const size = 0.055 + ((i % 4) * 0.012 + Math.random() * 0.005);
    const star = new THREE_NS.Mesh(
      new THREE_NS.SphereGeometry(size, 14, 14),
      new THREE_NS.MeshStandardMaterial({
        color: 0xdde7ff,
        emissive: 0x2d3f7a,
        emissiveIntensity: 0.72,
        transparent: true,
        opacity: 1,
      }),
    );

    star.position.copy(position);
    star.userData.starId = starEntry.id;
    star.userData.label = starEntry.label ?? starEntry.id;

    sceneState.starMeshes.push(star);
    sceneState.starById.set(starEntry.id, star);
    sceneState.starPulseMeta.push({
      mesh: star,
      baseScale: star.scale.x,
      phase: Math.random() * Math.PI * 2,
      speed: 0.55 + Math.random() * 0.5,
      drift: (Math.random() - 0.5) * 0.07,
      baseY: position.y,
    });
    group.add(star);
  }

  group.add(createConstellationLinks(positions));

  group.visible = false;
  group.scale.set(0.9, 0.9, 0.9);
  sceneState.constellationGroup = group;
  sceneState.constellationDimCurrent = 0;
  sceneState.constellationDimTarget = 0;
  sceneState.angularVelocityX = 0;
  sceneState.angularVelocityY = 0;
  sceneState.motionPaused = false;
  sceneState.scene.add(group);
  return group;
}

function setRitualOpacity(multiplier) {
  if (!Array.isArray(sceneState.ritualMaterials)) return;
  const opacities = [0.8, 0.64, 0.62, 0.55, 0.36, 0.62, 0.8];
  sceneState.ritualMaterials.forEach((material, index) => {
    const base = opacities[index] ?? 0.5;
    material.opacity = base * clamp01(multiplier);
  });
}

function getStarVisualState(starId) {
  return {
    isSelected: starId === sceneState.selectedStarId,
    isTargeted: starId === sceneState.targetedStarId,
    targetProgress: sceneState.targetProgress,
  };
}

function handleResize() {
  const { container, renderer, camera } = sceneState;
  if (!container || !renderer || !camera) return;

  const width = Math.max(container.clientWidth, 1);
  const height = Math.max(container.clientHeight, 1);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

export function initThreeScene(container) {
  const THREE = getThreeOrThrow();

  if (!container) {
    throw new Error("initThreeScene(container) requires a valid container element.");
  }

  if (sceneState.renderer) {
    return sceneState;
  }

  sceneState.container = container;
  sceneState.scene = new THREE.Scene();
  sceneState.scene.background = null;

  sceneState.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
  sceneState.camera.position.set(0, 0, 5.4);

  sceneState.renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  sceneState.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  sceneState.renderer.setClearColor(0x050816, 0.0);
  sceneState.renderer.domElement.style.position = "absolute";
  sceneState.renderer.domElement.style.inset = "0";
  sceneState.renderer.domElement.style.width = "100%";
  sceneState.renderer.domElement.style.height = "100%";
  sceneState.renderer.domElement.style.background = "transparent";
  sceneState.renderer.domElement.style.border = "none";
  sceneState.renderer.domElement.style.outline = "none";
  sceneState.renderer.domElement.style.pointerEvents = "none";
  sceneState.renderer.domElement.style.zIndex = "2";

  container.appendChild(sceneState.renderer.domElement);
  if (!container.contains(sceneState.renderer.domElement)) {
    throw new Error("Renderer canvas failed to mount into scene container.");
  }
  console.debug("[ThreeScene] Renderer canvas appended:", {
    alpha: true,
    clearAlpha: 0,
    mixBlendMode: sceneState.renderer.domElement.style.mixBlendMode || "normal",
    zIndex: sceneState.renderer.domElement.style.zIndex,
  });

  sceneState.raycaster = new THREE.Raycaster();
  sceneState.pointerNdc = new THREE.Vector2(2, 2);
  sceneState.summonGlowTexture = createSoftGlowTexture();

  sceneState.starfield = createStarfield();
  sceneState.starfield.visible = false;
  sceneState.scene.add(sceneState.starfield);

  sceneState.ritualCircleGroup = createRitualCircleGroup();
  sceneState.scene.add(sceneState.ritualCircleGroup);

  // User-authored summon trail: drawn from index fingertip during gesture phase.
  sceneState.summonTrailMaterial = new THREE_NS.LineBasicMaterial({
    color: 0xffc980,
    transparent: true,
    opacity: 0.0,
    blending: THREE_NS.AdditiveBlending,
  });
  sceneState.summonTrailLine = new THREE_NS.LineSegments(
    new THREE_NS.BufferGeometry(),
    sceneState.summonTrailMaterial,
  );
  sceneState.summonTrailLine.visible = false;
  sceneState.scene.add(sceneState.summonTrailLine);
  sceneState.summonTrailLayer = new THREE_NS.Points(
    new THREE_NS.BufferGeometry(),
    new THREE_NS.PointsMaterial({
      color: 0xffd8a7,
      size: 0.052,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      blending: THREE_NS.AdditiveBlending,
      map: sceneState.summonGlowTexture ?? null,
      alphaTest: 0.02,
    }),
  );
  sceneState.summonTrailLayer.visible = false;
  sceneState.scene.add(sceneState.summonTrailLayer);
  sceneState.summonEmberCloud = new THREE_NS.Points(
    new THREE_NS.BufferGeometry(),
    new THREE_NS.PointsMaterial({
      color: 0xffa84e,
      size: 0.026,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      blending: THREE_NS.AdditiveBlending,
      map: sceneState.summonGlowTexture ?? null,
      alphaTest: 0.02,
    }),
  );
  sceneState.summonEmberCloud.visible = false;
  sceneState.scene.add(sceneState.summonEmberCloud);

  sceneState.summonSpark = new THREE_NS.Sprite(
    new THREE_NS.SpriteMaterial({
      color: 0xffc16e,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      map: sceneState.summonGlowTexture ?? null,
      blending: THREE_NS.AdditiveBlending,
    }),
  );
  sceneState.summonSpark.scale.set(0.18, 0.18, 1);
  sceneState.summonSpark.visible = false;
  sceneState.scene.add(sceneState.summonSpark);

  const ambientLight = new THREE.AmbientLight(0x9fb6ff, 0.5);
  const keyLight = new THREE.PointLight(0xb5c9ff, 1.05, 16);
  keyLight.position.set(2.5, 2.8, 3.2);
  const fillLight = new THREE.PointLight(0xc0a870, 0.45, 18);
  fillLight.position.set(-2.2, -2.4, 2.2);
  sceneState.scene.add(ambientLight, keyLight, fillLight);

  handleResize();
  sceneState.resizeHandler = () => handleResize();
  window.addEventListener("resize", sceneState.resizeHandler);

  sceneState.renderer.setAnimationLoop((timeMs) => {
    if (!sceneState.scene || !sceneState.camera || !sceneState.renderer) return;
    const t = timeMs * 0.001;
    const dtMs = sceneState.lastFrameMs == null ? 16.67 : Math.max(8, Math.min(40, timeMs - sceneState.lastFrameMs));
    sceneState.lastFrameMs = timeMs;
    const frameScale = dtMs / 16.67;

    if (sceneState.starfield) {
      sceneState.starfield.rotation.z += 0.00035;
    }
    if (sceneState.ritualCircleGroup?.visible) {
      sceneState.ritualCircleGroup.rotation.z -= 0.0015;
      for (const child of sceneState.ritualCircleGroup.children) {
        if (typeof child.userData?.spin === "number") {
          child.rotation.z += child.userData.spin;
        }
      }
      if (sceneState.ritualShimmer) {
        sceneState.ritualShimmer.rotation.z += 0.0045;
      }
    }
    rebuildSummonTrailGeometry(timeMs);
    rebuildSummonEmberGeometry(timeMs);
    if (sceneState.summonTrailLocked && sceneState.summonTrailLayer) {
      sceneState.summonTrailLayer.material.opacity = 0.88;
    }
    if (sceneState.summonSpark?.visible) {
      const pulse = 0.9 + Math.sin(t * 21) * 0.24;
      sceneState.summonSpark.scale.set(0.14 * pulse, 0.14 * pulse, 1);
      if (sceneState.summonSpark.material) {
        sceneState.summonSpark.material.opacity = 0.78 + Math.sin(t * 11) * 0.16;
      }
    }
    if (sceneState.ritualAnimation) {
      const { mode, startMs, durationMs } = sceneState.ritualAnimation;
      const progress = clamp01((timeMs - startMs) / durationMs);

      if (mode === "appearing") {
        const eased = easeOutCubic(progress);
        setRitualOpacity(eased);
        const scale = 0.7 + eased * 0.35;
        sceneState.ritualCircleGroup.scale.set(scale, scale, scale);
        if (progress >= 1) {
          sceneState.ritualAnimation = null;
          setRitualOpacity(1);
          sceneState.ritualCircleGroup.scale.set(1.05, 1.05, 1.05);
        }
      } else if (mode === "transforming") {
        const eased = easeInOutSine(progress);
        setRitualOpacity(1 - eased);
        const ritualScale = 1.05 + eased * 0.35;
        sceneState.ritualCircleGroup.scale.set(ritualScale, ritualScale, ritualScale);

        if (sceneState.constellationGroup) {
          const constellationScale = 0.82 + eased * 0.23;
          sceneState.constellationGroup.scale.set(
            constellationScale,
            constellationScale,
            constellationScale,
          );
        }

        if (progress >= 1) {
          sceneState.ritualAnimation = null;
          sceneState.ritualCircleGroup.visible = false;
        }
      }
    }
    if (sceneState.constellationGroup?.visible) {
      sceneState.constellationDimCurrent +=
        (sceneState.constellationDimTarget - sceneState.constellationDimCurrent) * 0.07;
      const dimFactor = clamp01(sceneState.constellationDimCurrent);
      const starOpacity = 1 - dimFactor * 0.42;
      const lineOpacity = 0.42 - dimFactor * 0.2;

      for (const pulse of sceneState.starPulseMeta) {
        const { isSelected, isTargeted, targetProgress } = getStarVisualState(
          pulse.mesh.userData.starId,
        );
        const pulseFactor = 1 + Math.sin(t * pulse.speed + pulse.phase) * 0.055;
        const targetScaleBoost = isSelected ? 0.22 : isTargeted ? 0.1 + targetProgress * 0.2 : 0;
        const finalScale = pulseFactor + targetScaleBoost;
        pulse.mesh.scale.set(finalScale, finalScale, finalScale);
        pulse.mesh.position.y = pulse.baseY + Math.sin(t * (pulse.speed * 0.65) + pulse.phase) * pulse.drift;
        pulse.mesh.material.opacity = starOpacity;

        if (isSelected) {
          pulse.mesh.material.emissiveIntensity = 1.35;
        } else if (isTargeted) {
          pulse.mesh.material.emissiveIntensity = 0.95 + targetProgress * 0.95;
        } else {
          // Soft breathing keeps idle stars alive without flicker.
          pulse.mesh.material.emissiveIntensity = 0.62 + Math.sin(t * 0.8 + pulse.phase) * 0.11;
        }
      }
      if (sceneState.constellationLineMaterial) {
        sceneState.constellationLineMaterial.opacity = Math.max(0.1, lineOpacity);
      }

      // Physics-like rotation: user impulse contributes velocity, then damping slows it.
      if (sceneState.motionPaused) {
        sceneState.angularVelocityX = 0;
        sceneState.angularVelocityY = 0;
      } else {
        sceneState.constellationGroup.rotation.y +=
          IDLE_ROTATION_SPEED_Y * frameScale + sceneState.angularVelocityY * frameScale;
        sceneState.constellationGroup.rotation.x = Math.max(
          -1.15,
          Math.min(
            1.15,
            sceneState.constellationGroup.rotation.x +
              IDLE_ROTATION_SPEED_X * frameScale +
              sceneState.angularVelocityX * frameScale,
          ),
        );
        const frameDamping = ROTATION_DAMPING ** frameScale;
        sceneState.angularVelocityX *= frameDamping;
        sceneState.angularVelocityY *= frameDamping;
        if (Math.abs(sceneState.angularVelocityX) < MIN_ANGULAR_VELOCITY) {
          sceneState.angularVelocityX = 0;
        }
        if (Math.abs(sceneState.angularVelocityY) < MIN_ANGULAR_VELOCITY) {
          sceneState.angularVelocityY = 0;
        }
      }
    }

    // Use direct renderer for guaranteed alpha compositing over webcam.
    sceneState.renderer.render(sceneState.scene, sceneState.camera);
  });

  return sceneState;
}

export function showRitualCircle() {
  if (sceneState.ritualCircleGroup) {
    sceneState.ritualCircleGroup.visible = true;
    sceneState.ritualCircleGroup.scale.set(0.7, 0.7, 0.7);
    setRitualOpacity(0);
    sceneState.ritualAnimation = {
      mode: "appearing",
      startMs: performance.now(),
      durationMs: 780,
    };
  }
}

export function hideRitualCircle() {
  if (sceneState.ritualCircleGroup) {
    sceneState.ritualCircleGroup.visible = false;
    sceneState.ritualAnimation = null;
    setRitualOpacity(0);
  }
}

export function resetSummonTrail() {
  sceneState.summonTrailSamples = [];
  sceneState.summonEmberParticles = [];
  sceneState.summonTrailLocked = false;
  if (sceneState.summonTrailLine) {
    sceneState.summonTrailLine.visible = false;
    clearSummonTrailGeometry();
  }
  if (sceneState.summonTrailLayer) {
    sceneState.summonTrailLayer.visible = false;
    sceneState.summonTrailLayer.material.opacity = 0;
    sceneState.summonTrailLayer.geometry.setAttribute(
      "position",
      new THREE_NS.Float32BufferAttribute([], 3),
    );
  }
  if (sceneState.summonEmberCloud) {
    sceneState.summonEmberCloud.visible = false;
    sceneState.summonEmberCloud.material.opacity = 0;
    sceneState.summonEmberCloud.geometry.setAttribute(
      "position",
      new THREE_NS.Float32BufferAttribute([], 3),
    );
  }
  if (sceneState.summonSpark) {
    sceneState.summonSpark.visible = false;
  }
  if (sceneState.summonTrailMaterial) {
    sceneState.summonTrailMaterial.opacity = 0;
  }
  if (sceneState.ritualCircleGroup) {
    sceneState.ritualCircleGroup.position.set(0, 0, 0);
  }
}

export function appendSummonTrailPoint(point) {
  if (!sceneState.summonTrailLine || sceneState.summonTrailLocked) return;
  const worldPoint = toMirroredRitualPoint(point);
  if (!worldPoint) return;
  const now = performance.now();

  const prev = sceneState.summonTrailSamples[sceneState.summonTrailSamples.length - 1]?.position ?? null;
  if (prev && prev.distanceTo(worldPoint) < 0.01) return;

  sceneState.summonTrailSamples.push({ position: worldPoint, t: now });
  if (sceneState.summonTrailSamples.length > TRAIL_MAX_SAMPLES) {
    sceneState.summonTrailSamples.shift();
  }
  rebuildSummonTrailGeometry(now);

  if (sceneState.summonSpark) {
    sceneState.summonSpark.visible = true;
    sceneState.summonSpark.position.copy(worldPoint);
  }
  // Firecracker-like embers radiate from fingertip to avoid a flat marker look.
  for (let i = 0; i < 3; i += 1) {
    const velocity = new THREE_NS.Vector3(
      (Math.random() - 0.5) * 0.006,
      (Math.random() - 0.5) * 0.006,
      (Math.random() - 0.5) * 0.003,
    );
    sceneState.summonEmberParticles.push({
      position: worldPoint.clone(),
      velocity,
      expireAt: now + SUMMON_PARTICLE_LIFE_MS + Math.random() * 240,
    });
  }
  if (sceneState.summonEmberParticles.length > SUMMON_PARTICLE_MAX) {
    sceneState.summonEmberParticles.splice(
      0,
      sceneState.summonEmberParticles.length - SUMMON_PARTICLE_MAX,
    );
  }
}

export function lockSummonTrail() {
  sceneState.summonTrailLocked = true;
  anchorRitualCircleToTrail();
  if (sceneState.summonTrailMaterial) {
    sceneState.summonTrailMaterial.opacity = 1;
  }
  if (sceneState.summonTrailLayer) {
    sceneState.summonTrailLayer.material.opacity = 0.88;
  }
}

export function showConstellation() {
  if (sceneState.constellationGroup) {
    if (sceneState.starfield) {
      sceneState.starfield.visible = true;
    }
    sceneState.constellationGroup.visible = true;
    sceneState.constellationGroup.scale.set(0.82, 0.82, 0.82);
    if (sceneState.summonSpark) {
      sceneState.summonSpark.visible = false;
    }
    if (sceneState.summonTrailMaterial) {
      sceneState.summonTrailMaterial.opacity = 0.38;
    }
    if (sceneState.ritualCircleGroup?.visible) {
      sceneState.ritualAnimation = {
        mode: "transforming",
        startMs: performance.now(),
        durationMs: 940,
      };
    }
  }
}

export function hideConstellation() {
  if (!sceneState.constellationGroup) return;
  if (sceneState.starfield) {
    sceneState.starfield.visible = false;
  }
  sceneState.constellationGroup.visible = false;
  sceneState.angularVelocityX = 0;
  sceneState.angularVelocityY = 0;
  sceneState.targetedStarId = null;
  sceneState.selectedStarId = null;
  sceneState.hoveredStarId = null;
}

export function rotateConstellation(dx = 0, dy = 0) {
  if (!sceneState.constellationGroup) return;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  if (sceneState.motionPaused) return;
  sceneState.angularVelocityY = Math.max(
    -MAX_ANGULAR_VELOCITY,
    Math.min(MAX_ANGULAR_VELOCITY, sceneState.angularVelocityY + dx * ROTATION_IMPULSE_Y),
  );
  sceneState.angularVelocityX = Math.max(
    -MAX_ANGULAR_VELOCITY,
    Math.min(MAX_ANGULAR_VELOCITY, sceneState.angularVelocityX + dy * ROTATION_IMPULSE_X),
  );
}

export function setConstellationMotionPaused(paused = false) {
  sceneState.motionPaused = Boolean(paused);
  if (sceneState.motionPaused) {
    sceneState.angularVelocityX = 0;
    sceneState.angularVelocityY = 0;
  }
}

export function zoomConstellation(delta = 0) {
  if (!sceneState.constellationGroup || !Number.isFinite(delta)) return;
  const current = sceneState.constellationGroup.scale.x;
  const next = Math.max(0.58, Math.min(1.7, current + delta));
  sceneState.constellationGroup.scale.set(next, next, next);
}

export function setConstellationDimmed(dimmed) {
  sceneState.constellationDimTarget = dimmed ? 1 : 0;
}

export function highlightStar(starId) {
  sceneState.selectedStarId = starId ?? null;
  sceneState.targetedStarId = null;
  sceneState.targetProgress = 0;
  for (const star of sceneState.starMeshes) {
    const isTarget = star.userData.starId === starId;
    const material = star.material;
    material.emissive.setHex(isTarget ? 0xc6a45f : 0x2d3f7a);
    material.emissiveIntensity = isTarget ? 1.35 : 0.7;
    material.color.setHex(isTarget ? 0xfff4d9 : 0xdde7ff);
  }
}

/**
 * Visual targeting feedback for hover-to-select flow.
 * `progress` should be 0..1 and represents dwell duration completion.
 */
export function setTargetingStar(starId, progress = 0) {
  sceneState.targetedStarId = starId ?? null;
  sceneState.targetProgress = clamp01(progress);

  for (const star of sceneState.starMeshes) {
    const material = star.material;
    const isSelected = star.userData.starId === sceneState.selectedStarId;
    const isTargeted = star.userData.starId === sceneState.targetedStarId && !isSelected;

    if (isSelected) {
      material.emissive.setHex(0xc6a45f);
      material.emissiveIntensity = 1.35;
      material.color.setHex(0xfff4d9);
      continue;
    }

    if (isTargeted) {
      const p = sceneState.targetProgress;
      material.emissive.setHex(0xb99f68);
      material.emissiveIntensity = 1 + p * 1.1;
      material.color.setHex(0xf4ebd8);
      continue;
    }

    material.emissive.setHex(0x2d3f7a);
    material.emissiveIntensity = 0.7;
    material.color.setHex(0xdde7ff);
  }
}

export function getHoveredStar(clientX, clientY) {
  const { container, camera, raycaster, starMeshes } = sceneState;
  if (!container || !camera || !raycaster || !Array.isArray(starMeshes) || starMeshes.length === 0) {
    return null;
  }
  if (typeof clientX !== "number" || typeof clientY !== "number") {
    return null;
  }

  const rect = container.getBoundingClientRect();
  sceneState.pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  sceneState.pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(sceneState.pointerNdc, camera);
  const hits = raycaster.intersectObjects(starMeshes, false);
  const hovered = hits[0]?.object?.userData?.starId ?? null;
  sceneState.hoveredStarId = hovered;
  return hovered;
}

export function getStarById(id) {
  if (!id) return null;
  return sceneState.starById.get(id) ?? null;
}

// Compatibility helper for the previous app wiring.
export function createThreeScene({ container, onStarSelected } = {}) {
  initThreeScene(container);

  return {
    init() {
      initThreeScene(container);
    },
    showMagicCircle: showRitualCircle,
    showConstellation,
    createConstellationFromData,
    getStarById,
    rotateFromHand({ landmarks }) {
      if (!landmarks) return;
      rotateConstellation(0.01, 0.004);
    },
    pickStar(starId) {
      highlightStar(starId);
      onStarSelected?.(starId);
    },
    getSelectedStarId() {
      return sceneState.selectedStarId;
    },
  };
}
