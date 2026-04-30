import * as THREE_MODULE from "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js";

/**
 * Three scene module for Orbital Oracle.
 * Exposes a small, stable API for rendering and interaction.
 */

let THREE_NS = null;

// Motion tuning kept explicit for easy classroom tweaking.
const IDLE_ROTATION_SPEED_Y = 0.00062;
const IDLE_ROTATION_SPEED_X = 0.00013;
const ROTATION_IMPULSE_X = 0.22;
const ROTATION_IMPULSE_Y = 0.24;
const ROTATION_DAMPING = 0.982;
const MAX_ANGULAR_VELOCITY = 0.016;
const MIN_ANGULAR_VELOCITY = 0.00003;
const STARFIELD_COUNT = 620;
const STARFIELD_CORE_SIZE = 0.039;
const STARFIELD_GLOW_SIZE = 0.115;
const STARFIELD_HALO_SIZE = 0.165;
const STARFIELD_CORE_OPACITY = 0.7;
const STARFIELD_GLOW_OPACITY = 0.25;
const STARFIELD_HALO_OPACITY = 0.105;
const STARFIELD_MIN_RADIUS = 0.9;
const STARFIELD_MAX_RADIUS = 2.2;
const STARFIELD_ENV_SCALE = 1.0;
const STARFIELD_RADIUS_FALLOFF = 2.45;
const TRAIL_SCATTER_JITTER = 0.011;
const PARTICLE_SIZE = 0.085;
const PARTICLE_LIFETIME = 4200;
const SPAWN_RATE = 135; // Particles per second while drawing.
const INITIAL_VELOCITY_RANGE = { min: 0.00055, max: 0.00195 };
const OUTWARD_SEPARATION_FORCE = 0.00042;
const TURBULENCE_FREQUENCY = 0.0054;
const TURBULENCE_AMPLITUDE = 0.00026;
const PARTICLE_FRICTION = 0.988;
const LINK_WIDTH = 1.4;
const MAX_LINK_DISTANCE = 0.22;
const SUMMON_MAX_LINKS = 900;
const FAST_MOVE_DISTANCE = 0.055;
const INTERPOLATION_STEPS_ON_FAST_MOVE = 7;
const TRAIL_MAX_SAMPLES = 1200;

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
  summonParticles: [],
  summonGlowTexture: null,
  summonSpark: null,
  summonTrailLocked: false,
  lastTrailUpdateMs: null,
  emitterState: {
    index: null,
    middle: null,
  },
  constellationGroup: null,
  constellationLineMaterial: null,
  constellationDimCurrent: 0,
  constellationDimTarget: 0,
  angularVelocityX: 0,
  angularVelocityY: 0,
  motionPaused: false,
  lastFrameMs: null,
  starfield: null,
  starfieldCoreMaterial: null,
  starfieldGlowMaterial: null,
  starfieldHaloMaterial: null,
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

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function emitTrailParticle({
  position,
  nowMs,
  source = "index",
  direction = null,
  jitterAmount = TRAIL_SCATTER_JITTER,
  velocityScale = 1,
}) {
  if (!position) return;
  const jittered = position.clone().add(
    new THREE_NS.Vector3(
      (Math.random() - 0.5) * jitterAmount,
      (Math.random() - 0.5) * jitterAmount,
      (Math.random() - 0.5) * jitterAmount * 0.5,
    ),
  );
  const baseDirection =
    direction && direction.lengthSq() > 0.000001
      ? direction.clone().normalize()
      : new THREE_NS.Vector3(Math.random() - 0.5, Math.random() - 0.5, (Math.random() - 0.5) * 0.3)
          .normalize();
  const speed = randomRange(INITIAL_VELOCITY_RANGE.min, INITIAL_VELOCITY_RANGE.max) * velocityScale;
  const sourceSkew =
    source === "index"
      ? new THREE_NS.Vector3(0.00026, 0.00014, 0)
      : source === "middle"
        ? new THREE_NS.Vector3(-0.00026, -0.00014, 0)
        : new THREE_NS.Vector3(0, 0, 0);
  sceneState.summonParticles.push({
    position: jittered,
    velocity: baseDirection
      .multiplyScalar(speed)
      .add(
        new THREE_NS.Vector3(
          (Math.random() - 0.5) * INITIAL_VELOCITY_RANGE.min,
          (Math.random() - 0.5) * INITIAL_VELOCITY_RANGE.min,
          (Math.random() - 0.5) * INITIAL_VELOCITY_RANGE.min * 0.4,
        ),
      )
      .add(sourceSkew),
    origin: position.clone(),
    birthMs: nowMs,
    lifetimeMs: PARTICLE_LIFETIME * randomRange(0.88, 1.12),
    source,
    seed: Math.random() * Math.PI * 2,
  });
  if (sceneState.summonParticles.length > TRAIL_MAX_SAMPLES) {
    sceneState.summonParticles.splice(0, sceneState.summonParticles.length - TRAIL_MAX_SAMPLES);
  }
}

function spawnFromEmitter({
  source,
  currentPoint,
  nowMs,
  fallbackDirection = null,
}) {
  if (!currentPoint) return;
  const previous = sceneState.emitterState[source];
  if (!previous) {
    sceneState.emitterState[source] = { point: currentPoint.clone(), t: nowMs };
    emitTrailParticle({
      position: currentPoint,
      nowMs,
      source,
      direction: fallbackDirection,
      jitterAmount: 0,
      velocityScale: 1.1,
    });
    return;
  }

  const elapsedMs = Math.max(8, nowMs - previous.t);
  const delta = currentPoint.clone().sub(previous.point);
  const distance = delta.length();
  const motionDirection =
    distance > 0.0001 ? delta.clone().normalize() : fallbackDirection?.clone() ?? new THREE_NS.Vector3(0, 1, 0);
  const baseSpawnCount = Math.max(1, Math.round((elapsedMs / 1000) * SPAWN_RATE));
  const interpolationCount =
    distance > FAST_MOVE_DISTANCE
      ? Math.min(INTERPOLATION_STEPS_ON_FAST_MOVE, Math.max(1, Math.floor(distance / FAST_MOVE_DISTANCE)))
      : 0;
  const totalSteps = Math.max(baseSpawnCount, interpolationCount + 1);

  for (let i = 0; i < totalSteps; i += 1) {
    const alpha = totalSteps === 1 ? 1 : i / (totalSteps - 1);
    const spawnPoint = previous.point.clone().lerp(currentPoint, alpha);
    emitTrailParticle({
      position: spawnPoint,
      nowMs: nowMs - (totalSteps - i) * 4,
      source,
      direction: motionDirection,
      jitterAmount: i <= 1 ? 0 : TRAIL_SCATTER_JITTER,
      velocityScale: 1 + distance * 10,
    });
  }

  sceneState.emitterState[source] = { point: currentPoint.clone(), t: nowMs };
}

function rebuildSummonTrailGeometry(nowMs) {
  if (!sceneState.summonTrailLine || !sceneState.summonTrailMaterial || !sceneState.summonTrailLayer) {
    return;
  }
  const dtMs = sceneState.lastTrailUpdateMs == null ? 16.67 : Math.max(8, Math.min(40, nowMs - sceneState.lastTrailUpdateMs));
  sceneState.lastTrailUpdateMs = nowMs;
  const dtScale = dtMs / 16.67;

  // Particles own their motion: drift outward, separate, and keep lively turbulence.
  for (const particle of sceneState.summonParticles) {
    if (!sceneState.summonTrailLocked) {
      const lifeMs = Math.max(0, nowMs - particle.birthMs);
      const lifeRatio = clamp01(lifeMs / Math.max(particle.lifetimeMs ?? PARTICLE_LIFETIME, 1));
      const outward = particle.position.clone().sub(particle.origin ?? particle.position);
      if (outward.lengthSq() > 0.0000001) {
        const separationGain = lifeRatio < 0.35 ? 0.16 + lifeRatio * 0.4 : 0.3 + lifeRatio * 0.95;
        outward.normalize().multiplyScalar(OUTWARD_SEPARATION_FORCE * separationGain);
        particle.velocity.addScaledVector(outward, dtScale);
      }
      const turbulencePhase = lifeMs * TURBULENCE_FREQUENCY + particle.seed;
      const turbulence = TURBULENCE_AMPLITUDE * (0.22 + lifeRatio * 0.82);
      particle.velocity.x += Math.cos(turbulencePhase * 1.1) * turbulence;
      particle.velocity.y += Math.sin(turbulencePhase * 1.7) * turbulence;
      particle.velocity.z += Math.cos(turbulencePhase * 0.8) * turbulence * 0.35;
      particle.position.addScaledVector(particle.velocity, dtScale);
      particle.velocity.multiplyScalar(PARTICLE_FRICTION ** dtScale);
    }
  }
  sceneState.summonParticles = sceneState.summonParticles.filter((particle) => {
    const lifetime = particle.lifetimeMs ?? PARTICLE_LIFETIME;
    return nowMs - particle.birthMs <= lifetime;
  });

  const pointPositions = [];
  for (const particle of sceneState.summonParticles) {
    pointPositions.push(particle.position.x, particle.position.y, particle.position.z);
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
  const particles = sceneState.summonParticles;
  for (let i = 0; i < particles.length; i += 1) {
    const a = particles[i];
    const aAge = nowMs - a.birthMs;
    const aLife = Math.max(1, a.lifetimeMs ?? PARTICLE_LIFETIME);
    const aRatio = aAge / aLife;
    if (aRatio > 0.96) continue;
    for (let j = i + 1; j < particles.length; j += 1) {
      const b = particles[j];
      if (linkCount >= SUMMON_MAX_LINKS) break;
      const bAge = nowMs - b.birthMs;
      const bLife = Math.max(1, b.lifetimeMs ?? PARTICLE_LIFETIME);
      const bRatio = bAge / bLife;
      if (bRatio > 0.96) continue;
      const d = a.position.distanceTo(b.position);
      if (d <= MAX_LINK_DISTANCE) {
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
  // Note: Line width support varies by platform/WebGL implementation.
  sceneState.summonTrailMaterial.linewidth = LINK_WIDTH;

  if (!sceneState.summonTrailLocked) {
    sceneState.summonTrailMaterial.opacity = sceneState.summonParticles.length > 0 ? 0.5 : 0;
    sceneState.summonTrailLayer.material.opacity =
      sceneState.summonParticles.length > 0
        ? Math.min(0.98, 0.42 + sceneState.summonParticles.length / 360)
        : 0;
  }
}

function toMirroredRitualPoint(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const { camera } = sceneState;
  const mirroredX = 1 - point.x;
  if (!camera) {
    return new THREE_NS.Vector3((mirroredX - 0.5) * 2.3, -(point.y - 0.5) * 2.3, 0.08);
  }
  // Project mirrored normalized fingertip onto ritual plane for exact overlay alignment.
  const ndc = new THREE_NS.Vector3(mirroredX * 2 - 1, -(point.y * 2 - 1), 0.5);
  ndc.unproject(camera);
  const direction = ndc.sub(camera.position).normalize();
  const targetZ = 0.08;
  const denom = direction.z;
  if (Math.abs(denom) < 0.0001) {
    return new THREE_NS.Vector3((mirroredX - 0.5) * 2.3, -(point.y - 0.5) * 2.3, targetZ);
  }
  const t = (targetZ - camera.position.z) / denom;
  return camera.position.clone().add(direction.multiplyScalar(t));
}

function anchorRitualCircleToTrail() {
  if (!sceneState.ritualCircleGroup || sceneState.summonParticles.length < 8) return;
  let sumX = 0;
  let sumY = 0;
  const pts = sceneState.summonParticles.map((sample) => sample.position);
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

function createStarGlowTexture() {
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
  gradient.addColorStop(0.2, "rgba(216,232,255,0.8)");
  gradient.addColorStop(0.52, "rgba(154,186,255,0.24)");
  gradient.addColorStop(1, "rgba(120,155,255,0)");
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
  const starCount = STARFIELD_COUNT;
  const positions = new Float32Array(starCount * 3);

  for (let i = 0; i < starCount; i += 1) {
    const i3 = i * 3;
    // Dense near constellation, sparser farther away for aura-like distribution.
    const angle = Math.random() * Math.PI * 2;
    const inclination = Math.acos(1 - 2 * Math.random());
    const radius =
      STARFIELD_MIN_RADIUS +
      (STARFIELD_MAX_RADIUS - STARFIELD_MIN_RADIUS) *
        Math.pow(Math.random(), STARFIELD_RADIUS_FALLOFF);
    positions[i3] = Math.cos(angle) * Math.sin(inclination) * radius;
    positions[i3 + 1] = Math.sin(angle) * Math.sin(inclination) * radius * 0.9;
    positions[i3 + 2] = Math.cos(inclination) * radius * 0.8;
  }

  const geometry = new THREE_NS.BufferGeometry();
  geometry.setAttribute("position", new THREE_NS.BufferAttribute(positions, 3));

  const coreMaterial = new THREE_NS.PointsMaterial({
    color: 0xaebfff,
    size: STARFIELD_CORE_SIZE,
    transparent: true,
    opacity: STARFIELD_CORE_OPACITY,
    depthWrite: false,
    blending: THREE_NS.AdditiveBlending,
  });
  const glowMaterial = new THREE_NS.PointsMaterial({
    color: 0xa7c1ff,
    size: STARFIELD_GLOW_SIZE,
    transparent: true,
    opacity: STARFIELD_GLOW_OPACITY,
    depthWrite: false,
    map: createStarGlowTexture(),
    alphaTest: 0.02,
    blending: THREE_NS.AdditiveBlending,
  });
  const haloMaterial = new THREE_NS.PointsMaterial({
    color: 0x9bb8ff,
    size: STARFIELD_HALO_SIZE,
    transparent: true,
    opacity: STARFIELD_HALO_OPACITY,
    depthWrite: false,
    map: createStarGlowTexture(),
    alphaTest: 0.01,
    blending: THREE_NS.AdditiveBlending,
  });

  const group = new THREE_NS.Group();
  group.scale.set(STARFIELD_ENV_SCALE, STARFIELD_ENV_SCALE, STARFIELD_ENV_SCALE);
  const corePoints = new THREE_NS.Points(geometry, coreMaterial);
  const glowPoints = new THREE_NS.Points(geometry.clone(), glowMaterial);
  const haloPoints = new THREE_NS.Points(geometry.clone(), haloMaterial);
  group.add(haloPoints, glowPoints, corePoints);
  sceneState.starfieldCoreMaterial = coreMaterial;
  sceneState.starfieldGlowMaterial = glowMaterial;
  sceneState.starfieldHaloMaterial = haloMaterial;
  return group;
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
  if (sceneState.starfield) {
    sceneState.starfield.visible = true;
    sceneState.starfield.position.set(0, 0, 0);
    sceneState.starfield.rotation.set(0, 0, 0);
    sceneState.starfield.scale.set(STARFIELD_ENV_SCALE, STARFIELD_ENV_SCALE, STARFIELD_ENV_SCALE);
    if (sceneState.starfield.parent) {
      sceneState.starfield.parent.remove(sceneState.starfield);
    }
    group.add(sceneState.starfield);
  }

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
      size: PARTICLE_SIZE,
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
  sceneState.summonSpark.scale.set(0.24, 0.24, 1);
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
      sceneState.starfield.rotation.z += 0.0009;
      sceneState.starfield.rotation.y += 0.0003;
      if (sceneState.starfieldCoreMaterial) {
        sceneState.starfieldCoreMaterial.opacity = STARFIELD_CORE_OPACITY + Math.sin(t * 0.55) * 0.04;
      }
      if (sceneState.starfieldGlowMaterial) {
        sceneState.starfieldGlowMaterial.opacity = STARFIELD_GLOW_OPACITY + Math.sin(t * 0.95) * 0.04;
      }
      if (sceneState.starfieldHaloMaterial) {
        sceneState.starfieldHaloMaterial.opacity = STARFIELD_HALO_OPACITY + Math.sin(t * 0.7) * 0.022;
      }
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
  sceneState.summonParticles = [];
  sceneState.summonTrailLocked = false;
  sceneState.lastTrailUpdateMs = null;
  sceneState.emitterState = {
    index: null,
    middle: null,
  };
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

export function appendSummonTrailPoint(pointOrEmitters) {
  if (!sceneState.summonTrailLine || sceneState.summonTrailLocked) return null;

  const emitters =
    pointOrEmitters && "indexTip" in pointOrEmitters
      ? {
          indexTip: pointOrEmitters.indexTip ?? null,
          middleTip: pointOrEmitters.middleTip ?? null,
        }
      : {
          indexTip: pointOrEmitters ?? null,
          middleTip: null,
        };
  const indexWorld = toMirroredRitualPoint(emitters.indexTip);
  const middleWorld = toMirroredRitualPoint(emitters.middleTip);
  if (!indexWorld && !middleWorld) return null;

  const now = performance.now();
  const centerWorld = indexWorld && middleWorld
    ? indexWorld.clone().add(middleWorld).multiplyScalar(0.5)
    : indexWorld?.clone() ?? middleWorld?.clone() ?? null;

  const spanDirection =
    indexWorld && middleWorld
      ? middleWorld.clone().sub(indexWorld).normalize()
      : new THREE_NS.Vector3(0, 1, 0);
  const tangentDirection = new THREE_NS.Vector3(-spanDirection.y, spanDirection.x, 0).normalize();

  if (indexWorld) {
    spawnFromEmitter({
      source: "index",
      currentPoint: indexWorld,
      nowMs: now,
      fallbackDirection: tangentDirection,
    });
  }
  if (middleWorld) {
    spawnFromEmitter({
      source: "middle",
      currentPoint: middleWorld,
      nowMs: now,
      fallbackDirection: tangentDirection.clone().multiplyScalar(-1),
    });
  }

  rebuildSummonTrailGeometry(now);

  if (sceneState.summonSpark) {
    sceneState.summonSpark.visible = true;
    sceneState.summonSpark.position.copy(centerWorld ?? indexWorld ?? middleWorld);
  }

  const sourceDebug = [];
  if (emitters.indexTip && indexWorld) {
    sourceDebug.push({
      source: "index",
      mirroredX: 1 - emitters.indexTip.x,
      normalizedY: emitters.indexTip.y,
      worldX: indexWorld.x,
      worldY: indexWorld.y,
      worldZ: indexWorld.z,
    });
  }
  if (emitters.middleTip && middleWorld) {
    sourceDebug.push({
      source: "middle",
      mirroredX: 1 - emitters.middleTip.x,
      normalizedY: emitters.middleTip.y,
      worldX: middleWorld.x,
      worldY: middleWorld.y,
      worldZ: middleWorld.z,
    });
  }

  return {
    sources: sourceDebug,
    centerWorld: centerWorld
      ? {
          worldX: centerWorld.x,
          worldY: centerWorld.y,
          worldZ: centerWorld.z,
        }
      : null,
  };
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
