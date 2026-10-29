// The low-poly settlement on starhermit:scene, as the browser build's
// js/render.js drew it with three.js r160: the tabletop board of instanced
// land tiles (hills raised, per-tile colour jitter, ground grain when
// detailed), the river as instanced translucent water tiles over an opaque
// bed (bobbing, with a drifting normal map), instanced forests (cone canopies
// with per-tree tints, trunks) that vanish when their tile is cleared,
// instanced rocks, drifting low-poly clouds high above, the buildings (hall,
// road, house, farm, lumber hut, well, market: parts merged into one
// vertex-coloured mesh per material kind; glowing windows, kerbs and the
// plinth when detailed), the "!" markers over unhappy homes, the hover ring,
// the keyboard cursor, the green/red ghost preview, pooled burst and chimney-
// smoke particles, pop-in animations, camera shake and the authored orbit
// camera (pan, zoom, reset; fitted to narrow windows). Rendering reads rules
// state and never writes it.
//
// From three.js r160 (physically based lights): colours and intensities as
// written; the key light's shadow box fitted to the board as render.js did. render.js's `new RoomEnvironment(renderer)` (the bright room) is
// kept as written; every standard material carries it as its own envMap at
// its old envMapIntensity, as r160 multiplied scene.environment by it. The
// old composer (RenderPass in half floats → GTAO → UnrealBloom 0.45 / 0.4 /
// 0.9 → OutputPass with ACES at exposure 1.05 (0.95 detailed) → the colour
// grade + vignette in display space → SMAA / FXAA, or MSAA on the target) is
// the runtime's renderer.ao / bloom / grade / antialias. The canvas filled the
// window behind the HUD, rails and toolbox, as the camera does here. The
// procedural ground grain and water normals are baked (tools/bake-textures.mjs).
import {
  ACESFilmicToneMapping, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry,
  DirectionalLight, DodecahedronGeometry, Euler, Fog, Group, HemisphereLight, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera, Plane, PMREMGenerator, Points,
  PointsMaterial, Raycaster, RepeatWrapping, RingGeometry, RoomEnvironment, SRGBColorSpace, Sprite, SpriteMaterial, TextureLoader,
  Vector2, Vector3, pointerToNdc, renderer, scene, type Material, type OrthographicCamera, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import type { Content, HouseInfo, State, Theme } from "./game.ts";
import { PARTICLE_MAX, particlePool, type Look } from "./quality.ts";

const TILE = 1;
const PI = Math.PI;
const T_GRASS = 0, T_FOREST = 1, T_HILL = 2, T_WATER = 3, T_ROCK = 4;

/** render.js PALETTES: colour-vision variants swap the selection and ghost hues. */
const PALETTES: Record<string, { select: number; valid: number; invalid: number; cursor: number }> = {
  default: { select: 0xffd54a, valid: 0x7cfc7a, invalid: 0xff5a5a, cursor: 0xffffff },
  deuteranopia: { select: 0x4ac8ff, valid: 0x4ac8ff, invalid: 0xffb000, cursor: 0xffffff },
  protanopia: { select: 0x4ac8ff, valid: 0x4ac8ff, invalid: 0xffb000, cursor: 0xffffff },
  tritanopia: { select: 0xff6ad5, valid: 0x59d9a5, invalid: 0xff8c42, cursor: 0xffffff },
};

// ---------------------------------------------------------------- the deterministic decor stream (rng.js RngStream)
function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mulberry(seed: number): number {
  let a = seed >>> 0;
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
class Stream {
  counter = 0;
  constructor(readonly seed: number) { void hashString; }
  float(): number { const v = mulberry((this.seed + Math.imul(this.counter, 0x9e3779b1)) >>> 0); this.counter = (this.counter + 1) >>> 0; return v; }
  int(lo: number, hi: number): number { return lo + Math.floor(this.float() * (hi - lo + 1)); }
}

// ---------------------------------------------------------------- scene setup
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const camera = new PerspectiveCamera(38, 1, 0.1, 200);
const hemi = new HemisphereLight(0xcfe8ff, 0x6a7a5a, 0.9);
const keyLight = new DirectionalLight(0xfff2dd, 1.6);
keyLight.position.set(8, 14, 6);
keyLight.shadow.mapSize = 1024;
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 0.02;
scene.add(hemi, keyLight, keyLight.target);

const tileGroup = new Group();
const buildGroup = new Group();
const fxGroup = new Group();
const selectGroup = new Group();
scene.add(tileGroup, buildGroup, selectGroup, fxGroup);

let look: Look | null = null;
let palette = PALETTES.default!;
let reducedMotion = false;
let cameraShake = true;
let content: Content | null = null;
let theme: Theme | null = null;
let cellH: number[] = [];
let decorTerrain: number[] = [];
let landMesh: InstancedMesh | null = null;
let landCells: { x: number; y: number; t: number; height: number; shade: number }[] = [];
let waterInst: InstancedMesh | null = null;
let waterPos: Vector3[] = [];
let waterPhase: number[] = [];
let waterMat: Material | null = null;
let treeInstances: { leaves: InstancedMesh; trunks: InstancedMesh; positions: { x: number; z: number; s: number; cell: number }[] } | null = null;
let clouds: Group[] = [];
let windowGlow = 1.4;
const buildingMeshes = new Map<string, Group>();
const needSprites = new Map<string, Sprite>();
const popAnims: { group: Group; t: number }[] = [];
let lastState: State | null = null;
let houseNeeds: Map<number, HouseInfo> | null = null;
let quietSync = false;
let time = 0;
let shake = 0;
let smokeTimer = 0;

// camera state (render.js)
const camTarget = new Vector3();
const camTargetGoal = new Vector3();
let camDist = 14, camDistTarget = 14;
let camTheta = PI * 0.25, camThetaTarget = camTheta;
const camPhi = 0.95;

/** Removes and disposes a subtree (geometries and materials; shared ones are kept). */
const SHARED = new Set<object>();
function disposeObj(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry && !SHARED.has(m.geometry)) m.geometry.dispose();
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats as Material[]) if (!SHARED.has(mat)) mat.dispose();
  });
}
function clearGroup(g: Group): void {
  for (const c of [...g.children]) { g.remove(c); disposeObj(c); }
}

// ---------------------------------------------------------------- textures
const loader = new TextureLoader();
const textures = new Map<string, Texture>();
const loading = new Set<string>();
/** A baked texture, applied by `cb` once loaded (until then the flat colours stay). */
function withTexture(path: string, setup: (t: Texture) => void, cb: (t: Texture) => void): void {
  const have = textures.get(path);
  if (have) { cb(have); return; }
  waiters.push([path, cb]);
  if (loading.has(path)) return;
  loading.add(path);
  loader.load(path, (tex) => {
    setup(tex);
    textures.set(path, tex);
    SHARED.add(tex);
    loading.delete(path);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]![0] === path) { const [, fn] = waiters.splice(i, 1)[0]!; fn(tex); }
  }, undefined, (e: unknown) => { loading.delete(path); console.warn(`${path}: ${e instanceof Error ? e.message : String(e)}`); });
}
const waiters: [string, (t: Texture) => void][] = [];

function dotTexture(): CanvasTexture {
  const c = new OffscreenCanvas(32, 32);
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.8)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new CanvasTexture(c);
}
let needTex: CanvasTexture | null = null;
/** render.js _makeNeedSprite's picture: a yellow disc with a dark "!". */
function needTexture(): CanvasTexture {
  if (needTex) return needTex;
  const c = new OffscreenCanvas(64, 64);
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffd54a";
  g.beginPath(); g.arc(32, 32, 26, 0, PI * 2); g.fill();
  g.fillStyle = "#4a3800";
  g.font = "bold 40px sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("!", 32, 34);
  needTex = new CanvasTexture(c);
  needTex.colorSpace = SRGBColorSpace;
  SHARED.add(needTex);
  return needTex;
}

// three's ACESFilmicToneMapping (r160) on a linear RGB triple (render.js acesForward).
function acesForward(c: number[], exposure: number): number[] {
  const IN = [[0.59719, 0.07600, 0.02840], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777]];
  const OUT = [[1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602]];
  const mul = (m: number[][], v: number[]): number[] => [0, 1, 2].map((i) => m[0]![i]! * v[0]! + m[1]![i]! * v[1]! + m[2]![i]! * v[2]!);
  let v = c.map((x) => x * exposure / 0.6);
  v = mul(IN, v);
  v = v.map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081));
  return mul(OUT, v).map((x) => Math.min(1, Math.max(0, x)));
}
/** render.js untoneMapped: the colour whose tone-mapped result matches `color` (the sky keeps its authored hue). */
function untoneMapped(color: Color, exposure: number): Color {
  const t = [color.r, color.g, color.b].map((x) => Math.min(0.96, x));
  let x = t.slice();
  for (let i = 0; i < 200; i++) {
    const f = acesForward(x, exposure);
    x = x.map((xi, k) => Math.max(0, xi + (t[k]! - f[k]!) * 1.5));
  }
  return new Color(x[0], x[1], x[2]);
}
const hex = (c: Color): string => "#" + c.getHex().toString(16).padStart(6, "0");

// ---------------------------------------------------------------- environment and materials
let envTex: Texture | null = null;
function environment(): Texture | null {
  if (!envTex) {
    try {
      const pmrem = new PMREMGenerator(renderer);
      envTex = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
      SHARED.add(envTex);
    } catch (e) { console.warn(`environment: ${String(e)}`); }
  }
  return envTex;
}
const detailed = (): boolean => !!look?.detailed;
interface MatOpts { roughness?: number; metalness?: number; env?: number; emissive?: number; emissiveIntensity?: number; transparent?: boolean; opacity?: number; map?: Texture | null }
/** render.js _mat: flat Lambert (plain) or PBR standard with the room reflections (detailed). */
function mat(color: number, o: MatOpts = {}): MeshLambertMaterial | MeshStandardMaterial {
  if (!detailed()) {
    const m = new MeshLambertMaterial({ color });
    if (o.transparent) { m.transparent = true; m.opacity = o.opacity ?? 1; }
    return m;
  }
  const env = environment();
  return new MeshStandardMaterial({
    color, roughness: o.roughness ?? 0.82, metalness: o.metalness ?? 0,
    envMap: env, envMapIntensity: o.env ?? 0.35,
    emissive: o.emissive ?? 0x000000, emissiveIntensity: o.emissiveIntensity ?? 1,
    transparent: !!o.transparent, opacity: o.opacity ?? 1, map: o.map ?? null,
  });
}
/** render.js _applyDetailLights: IBL supplies part of the fill when detailed, so the hemisphere backs off. */
function applyDetailLights(): void {
  if (detailed()) {
    hemi.intensity = 0.5;
    keyLight.intensity = 1.85;
    renderer.toneMappingExposure = 0.95;
  } else {
    hemi.intensity = 0.9;
    keyLight.intensity = 1.6;
    renderer.toneMappingExposure = 1.05;
  }
}

// ---------------------------------------------------------------- selection markers
const ringGeo = new RingGeometry(0.42, 0.55, 24);
ringGeo.rotateX(-PI / 2);
const selectRing = new Mesh(ringGeo, new MeshBasicMaterial({ color: palette.select, transparent: true, opacity: 0.9, depthTest: false, toneMapped: false }));
selectRing.visible = false;
selectRing.renderOrder = 10;
const curGeo = new RingGeometry(0.45, 0.5, 4, 1, PI / 4);
curGeo.rotateX(-PI / 2);
const cursorMesh = new Mesh(curGeo, new MeshBasicMaterial({ color: palette.cursor, transparent: true, opacity: 0.8, depthTest: false, toneMapped: false }));
cursorMesh.visible = false;
cursorMesh.renderOrder = 10;
selectGroup.add(selectRing, cursorMesh);
let ghost: Group | null = null;
let ghostType: string | null = null;
let ghostAt: { x: number; y: number; valid: boolean } | null = null;

// ---------------------------------------------------------------- particles (pooled)
const pPos = new Float32Array(PARTICLE_MAX * 3).fill(-999);
const pVel = new Float32Array(PARTICLE_MAX * 3);
const pLife = new Float32Array(PARTICLE_MAX);
const pGrav = new Float32Array(PARTICLE_MAX);
const pCol = new Float32Array(PARTICLE_MAX * 3);
let poolSize = 0;
let pHead = 0;
const pGeo = new BufferGeometry();
pGeo.setAttribute("position", new BufferAttribute(pPos, 3));
pGeo.setAttribute("color", new BufferAttribute(pCol, 3));
const points = new Points(pGeo, new PointsMaterial({ size: 0.11, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, map: dotTexture() }));
points.frustumCulled = false;
fxGroup.add(points);

/** render.js burst: n coloured specks thrown up from a point. */
export function burst(x: number, y: number, z: number, color: number, n = 12): void {
  if (!poolSize || reducedMotion) return;
  const c = new Color(color);
  for (let i = 0; i < n; i++) {
    const idx = pHead;
    pHead = (pHead + 1) % poolSize;
    pGrav[idx] = 3.5;
    pPos[idx * 3] = x; pPos[idx * 3 + 1] = y; pPos[idx * 3 + 2] = z;
    const a = Math.random() * PI * 2;
    const v = 0.5 + Math.random() * 1.2;
    pVel[idx * 3] = Math.cos(a) * v * 0.4;
    pVel[idx * 3 + 1] = 1 + Math.random() * 1.2;
    pVel[idx * 3 + 2] = Math.sin(a) * v * 0.4;
    pLife[idx] = 0.6 + Math.random() * 0.4;
    pCol[idx * 3] = c.r; pCol[idx * 3 + 1] = c.g; pCol[idx * 3 + 2] = c.b;
  }
}
/** Slow chimney smoke puff (ambient; top particle tier only). */
function smoke(x: number, y: number, z: number): void {
  const idx = pHead;
  pHead = (pHead + 1) % poolSize;
  pPos[idx * 3] = x; pPos[idx * 3 + 1] = y; pPos[idx * 3 + 2] = z;
  pVel[idx * 3] = 0.05 + Math.random() * 0.08;
  pVel[idx * 3 + 1] = 0.22 + Math.random() * 0.16;
  pVel[idx * 3 + 2] = 0.08 * (Math.random() - 0.5);
  pLife[idx] = 1.2 + Math.random() * 0.6;
  pGrav[idx] = -0.02;
  const v = 0.78 + Math.random() * 0.1;
  pCol[idx * 3] = v; pCol[idx * 3 + 1] = v * 0.98; pCol[idx * 3 + 2] = v * 0.95;
}
function updateParticles(dt: number): void {
  if (!poolSize) { points.visible = false; return; }
  points.visible = true;
  for (let i = 0; i < poolSize; i++) {
    if (pLife[i]! <= 0) { pPos[i * 3 + 1] = -999; continue; }
    pLife[i] = pLife[i]! - dt;
    pVel[i * 3 + 1] = pVel[i * 3 + 1]! - pGrav[i]! * dt;
    pPos[i * 3] = pPos[i * 3]! + pVel[i * 3]! * dt;
    pPos[i * 3 + 1] = pPos[i * 3 + 1]! + pVel[i * 3 + 1]! * dt;
    pPos[i * 3 + 2] = pPos[i * 3 + 2]! + pVel[i * 3 + 2]! * dt;
  }
  (pGeo.attributes.position as BufferAttribute).needsUpdate = true;
  (pGeo.attributes.color as BufferAttribute).needsUpdate = true;
}

// ---------------------------------------------------------------- the board
const wx = (x: number): number => (x - (content!.grid.w - 1) / 2) * TILE;
const wz = (y: number): number => (y - (content!.grid.h - 1) / 2) * TILE;
const cellTopY = (x: number, y: number): number => cellH[y * content!.grid.w + x] ?? 0;
function terrainColor(t: number): Color {
  const th = theme!;
  return new Color(t === T_GRASS ? th.grass : t === T_FOREST ? new Color(th.grass).multiplyScalar(0.92).getHex() : t === T_HILL ? th.hill : th.rock);
}

/** render.js loadContent: the board, water, forest, rocks, clouds, sky and fog; the camera fitted to the board. */
export function load(c: Content, th: Theme): void {
  clearGroup(tileGroup);
  clearGroup(buildGroup);
  for (const sp of needSprites.values()) fxGroup.remove(sp);
  buildingMeshes.clear();
  needSprites.clear();
  popAnims.length = 0;
  waterPos = [];
  waterPhase = [];
  content = c;
  theme = th;
  decorTerrain = c.terrain.slice();
  if (ghost) { selectGroup.remove(ghost); disposeObj(ghost); ghost = null; ghostType = null; }

  if (detailed()) {
    // Soft vertical sky gradient: lighter overhead, melting into the fog tint (pre-compensated for the tone mapping).
    const cv = new OffscreenCanvas(2, 256);
    const g = cv.getContext("2d")!;
    const exp = renderer.toneMappingExposure;
    const stop = (col: Color): string => hex(untoneMapped(col, exp));
    const top = new Color(th.sky).offsetHSL(0, 0.08, -0.06);
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, stop(top));
    grad.addColorStop(0.5, stop(new Color(th.sky)));
    grad.addColorStop(1, stop(new Color(th.fog)));
    g.fillStyle = grad; g.fillRect(0, 0, 2, 256);
    const bg = new CanvasTexture(cv);
    bg.colorSpace = SRGBColorSpace;
    const old = scene.background;
    scene.background = bg;
    if (old && (old as Texture).dispose) (old as Texture).dispose();
  } else {
    scene.background = new Color(th.sky);
  }
  scene.fog = new Fog(th.fog, 22, 48);

  const { w, h } = c.grid;
  const rng = new Stream((c.seed ^ 0xdec0) >>> 0);
  cellH = new Array(w * h).fill(0);
  for (let i = 0; i < w * h; i++) cellH[i] = c.terrain[i] === T_HILL ? 0.45 : 0;

  const tileGeo = new BoxGeometry(TILE, 0.3, TILE);
  const landMat = mat(0xffffff, { roughness: 0.95, env: 0.2 });
  const b = look!.budget;
  if (detailed()) {
    withTexture(`assets/textures/ground-${b.texture}.png`, (t) => { t.colorSpace = SRGBColorSpace; t.wrapS = t.wrapT = RepeatWrapping; t.anisotropy = 4; },
      (t) => { if (landMesh && landMesh.material === landMat) { (landMat as MeshStandardMaterial).map = t; } });
  }
  const wm = detailed()
    ? new MeshStandardMaterial({ color: th.water, roughness: 0.2, metalness: 0, envMap: environment(), envMapIntensity: 0.45, transparent: true, opacity: 0.9 })
    : new MeshLambertMaterial({ color: th.water, transparent: true, opacity: 0.85 });
  waterMat = wm;
  if (detailed()) {
    withTexture(`assets/textures/water-${b.texture / 2}.png`, (t) => { t.wrapS = t.wrapT = RepeatWrapping; }, (t) => {
      if (waterMat === wm) { (wm as MeshStandardMaterial).normalMap = t; (wm as MeshStandardMaterial).normalScale.set(0.45, 0.45); }
    });
  }
  landCells = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = c.terrain[y * w + x]!;
      if (t === T_WATER) {
        waterPos.push(new Vector3(wx(x), -0.27, wz(y)));
        waterPhase.push(rng.float() * PI * 2);
        continue;
      }
      landCells.push({ x, y, t, height: 0.3 + cellH[y * w + x]!, shade: 0.92 + rng.float() * 0.12 });
    }
  }
  waterInst = null;
  if (waterPos.length) {
    const water = new InstancedMesh(tileGeo, wm, waterPos.length);
    water.receiveShadow = true;
    waterInst = water;
    syncWater();
    tileGroup.add(water);
  }
  if (detailed() && waterPos.length) {
    // Opaque riverbed under the translucent water so the sky never shows through.
    const bedMat = mat(new Color(th.water).lerp(new Color(0x3a3020), 0.55).getHex(), { roughness: 1, env: 0.2 });
    const beds = new InstancedMesh(new BoxGeometry(TILE, 0.15, TILE), bedMat, waterPos.length);
    const bm = new Matrix4();
    waterPos.forEach((p, i) => { bm.makeTranslation(p.x, -0.375, p.z); beds.setMatrixAt(i, bm); });
    beds.instanceMatrix.needsUpdate = true;
    beds.receiveShadow = true;
    tileGroup.add(beds);
  }
  const land = new InstancedMesh(new BoxGeometry(1, 1, 1), landMat, Math.max(1, landCells.length));
  const m = new Matrix4();
  landCells.forEach((cell, i) => {
    const hh = cellH[cell.y * w + cell.x]!;
    m.makeScale(TILE, cell.height, TILE);
    m.setPosition(wx(cell.x), hh - cell.height / 2, wz(cell.y));
    land.setMatrixAt(i, m);
    land.setColorAt(i, terrainColor(cell.t).multiplyScalar(cell.shade));
  });
  land.instanceMatrix.needsUpdate = true;
  if (land.instanceColor) land.instanceColor.needsUpdate = true;
  land.receiveShadow = true;
  landMesh = land;
  tileGroup.add(land);

  buildForest(rng);
  buildRocks(rng);
  buildSky(rng);

  windowGlow = th.ambient === "night" ? 2.6 : 1.4;
  boardRadius = Math.hypot(w, h) * TILE / 2 + 0.6;
  fitShadow(boardRadius);
  camTarget.set(0, 0, 0);
  camTargetGoal.set(0, 0, 0);
  camDist = Math.max(w, h) * 1.25 + 5;
  camDistTarget = camDist;
  camThetaTarget = camTheta = PI * 0.25;
  applyCamera(1);
}
let boardRadius = 8;
/** render.js _fitShadow: the key light's orthographic shadow box fitted tightly around the board. */
function fitShadow(radius: number): void {
  const dist = radius * 2 + 4;
  keyLight.position.set(8, 14, 6).normalize().multiplyScalar(dist);
  keyLight.target.position.set(0, 0, 0);
  const cam = keyLight.shadow.camera as OrthographicCamera;
  cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
  cam.near = dist - radius - 2; cam.far = dist + radius + 2;
  cam.updateProjectionMatrix();
}
fitShadow(12);

function syncWater(): void {
  if (!waterInst) return;
  const m4 = new Matrix4();
  for (let i = 0; i < waterPos.length; i++) waterInst.setMatrixAt(i, m4.makeTranslation(waterPos[i]!.x, waterPos[i]!.y, waterPos[i]!.z));
  waterInst.instanceMatrix.needsUpdate = true;
}

function buildForest(rng: Stream): void {
  const { w, h } = content!.grid;
  const positions: { x: number; z: number; s: number; cell: number }[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (content!.terrain[y * w + x] !== T_FOREST) continue;
      const n = rng.int(2, 3);
      for (let i = 0; i < n; i++) {
        positions.push({ x: wx(x) + (rng.float() - 0.5) * 0.6, z: wz(y) + (rng.float() - 0.5) * 0.6, s: 0.7 + rng.float() * 0.5, cell: y * w + x });
      }
    }
  }
  const seg = look!.budget.segments;
  const cone = new ConeGeometry(0.22, 0.7, Math.round(6 * seg));
  const trunk = new CylinderGeometry(0.05, 0.07, 0.25, Math.round(5 * seg));
  const leafMat = mat(theme!.forest, { roughness: 0.75 });
  const trunkMat = mat(0x6b4a2f, { roughness: 0.9 });
  if (detailed()) leafMat.color.setHex(0xffffff); // canopy tint variation per tree
  const leaves = new InstancedMesh(cone, leafMat, Math.max(1, positions.length));
  const trunks = new InstancedMesh(trunk, trunkMat, Math.max(1, positions.length));
  const m4 = new Matrix4();
  const base = new Color(theme!.forest);
  const tint = new Color();
  positions.forEach((p, i) => {
    m4.makeScale(p.s, p.s, p.s).setPosition(p.x, 0.55 * p.s, p.z);
    leaves.setMatrixAt(i, m4);
    if (detailed()) {
      const v = ((p.cell * 7919 + i * 104729) % 1000) / 1000;
      tint.copy(base).offsetHSL((v - 0.5) * 0.03, 0, (v - 0.5) * 0.08);
      leaves.setColorAt(i, tint);
    }
    m4.makeScale(p.s, p.s, p.s).setPosition(p.x, 0.12 * p.s, p.z);
    trunks.setMatrixAt(i, m4);
  });
  if (!positions.length) { leaves.count = 0; trunks.count = 0; }
  leaves.instanceMatrix.needsUpdate = true;
  trunks.instanceMatrix.needsUpdate = true;
  if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
  leaves.castShadow = true; leaves.receiveShadow = true;
  trunks.castShadow = true;
  treeInstances = { leaves, trunks, positions };
  tileGroup.add(leaves, trunks);
}

function buildRocks(rng: Stream): void {
  const { w, h } = content!.grid;
  const positions: { x: number; z: number; s: number; r: number }[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (content!.terrain[y * w + x] === T_ROCK) positions.push({ x: wx(x), z: wz(y), s: 0.5 + rng.float() * 0.3, r: rng.float() * PI });
    }
  }
  if (!positions.length) return;
  const geo = new DodecahedronGeometry(0.32, 0);
  const m = mat(theme!.rock, { roughness: 0.7, env: 0.5 });
  if (detailed()) (m as MeshStandardMaterial).flatShading = true;
  const rocks = new InstancedMesh(geo, m, positions.length);
  const m4 = new Matrix4();
  const e = new Euler();
  positions.forEach((p, i) => {
    e.set(0, p.r, 0);
    m4.makeRotationFromEuler(e).scale(new Vector3(p.s, p.s * 0.8, p.s)).setPosition(p.x, 0.2, p.z);
    rocks.setMatrixAt(i, m4);
  });
  rocks.instanceMatrix.needsUpdate = true;
  rocks.castShadow = true; rocks.receiveShadow = true;
  tileGroup.add(rocks);
}

function buildSky(rng: Stream): void {
  clouds = [];
  const m = mat(0xffffff, { transparent: true, opacity: 0.85, roughness: 1, env: 0.2 });
  for (let i = 0; i < look!.budget.clouds; i++) {
    const g = new Group();
    const n = rng.int(2, 4);
    for (let j = 0; j < n; j++) {
      const s = 0.6 + rng.float() * 0.8;
      const puff = new Mesh(new IcosahedronGeometry(s, 0), m);
      puff.position.set(j * s * 0.9, rng.float() * 0.2, rng.float() * 0.4);
      g.add(puff);
    }
    // High above any camera height so they never cross the board sightline.
    g.position.set((rng.float() - 0.5) * 30, 26 + rng.float() * 4, (rng.float() - 0.5) * 30);
    g.userData.speed = 0.1 + rng.float() * 0.15;
    clouds.push(g);
    tileGroup.add(g);
  }
}

// ---------------------------------------------------------------- buildings
/** render.js mergeParts: one vertex-coloured mesh per material kind (1–4 draws a building). */
function mergeParts(group: Group): Group {
  group.updateMatrixWorld(true);
  const buckets = new Map<string, { mat: Material; cast: boolean; parts: Mesh[] }>();
  for (const child of group.children) {
    const m = child as Mesh;
    const mt = m.material as MeshStandardMaterial;
    const k = [mt instanceof MeshStandardMaterial ? "std" : "lambert", mt.roughness, mt.metalness, mt.envMapIntensity, mt.emissive ? mt.emissive.getHex() : "", mt.emissiveIntensity, m.castShadow].join("|");
    if (!buckets.has(k)) buckets.set(k, { mat: mt, cast: m.castShadow, parts: [] });
    buckets.get(k)!.parts.push(m);
  }
  const out = new Group();
  Object.assign(out.userData, group.userData);
  for (const { mat: mt, cast, parts } of buckets.values()) {
    const geos = parts.map((m) => {
      const geo = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrix);
      const n = geo.attributes.position!.count, c = (m.material as MeshStandardMaterial).color, col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      geo.setAttribute("color", new BufferAttribute(col, 3));
      return geo;
    });
    const merged = new BufferGeometry();
    for (const name of ["position", "normal", "uv", "color"] as const) {
      const size = geos[0]!.attributes[name]!.itemSize;
      const arr = new Float32Array(geos.reduce((n, gg) => n + gg.attributes[name]!.count * size, 0));
      let off = 0;
      for (const gg of geos) { const a = gg.attributes[name]!.array as Float32Array; arr.set(a, off); off += a.length; }
      merged.setAttribute(name, new BufferAttribute(arr, size));
    }
    merged.computeBoundingSphere();
    const material = mt.clone() as MeshStandardMaterial;
    material.color.setHex(0xffffff);
    material.vertexColors = true;
    const mesh = new Mesh(merged, material);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    out.add(mesh);
    for (const gg of geos) gg.dispose();
  }
  disposeObj(group);
  return out;
}

/** render.js _buildingParts: a building as a group of low-poly parts. */
function buildingParts(type: string): Group {
  const g = new Group();
  const add = (geo: BufferGeometry, color: number, x = 0, y = 0, z = 0, ry = 0, opts?: MatOpts): Mesh => {
    const m = new Mesh(geo, mat(color, opts));
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const det = detailed();
  const seg = look!.budget.segments;
  const roof = { roughness: 0.6, env: 0.5 };
  const glow = { roughness: 0.3, emissive: 0xffb65a, emissiveIntensity: windowGlow };
  const win = (x: number, y: number, z: number, ry = 0): void => {
    if (!det) return;
    const w = add(new BoxGeometry(0.09, 0.09, 0.012), 0x3a2a18, x, y, z, ry, glow);
    w.castShadow = false;
  };
  switch (type) {
    case "hall": {
      add(new BoxGeometry(0.6, 0.5, 0.6), 0xb08968, 0, 0.25, 0);
      add(new ConeGeometry(0.5, 0.4, 4), 0x8c4a2f, 0, 0.7, 0, PI / 4, roof);
      win(-0.14, 0.3, 0.305); win(0.14, 0.3, 0.305);
      if (det) add(new BoxGeometry(0.68, 0.06, 0.68), 0x8a7058, 0, 0.03, 0); // plinth
      add(new CylinderGeometry(0.02, 0.02, 0.5, 4), 0x554433, 0, 1.05, 0);
      add(new BoxGeometry(0.22, 0.14, 0.02), 0xd4a017, 0.12, 1.2, 0, 0, { roughness: 0.5, emissive: 0x3a2800 }); // banner
      break;
    }
    case "road": {
      add(new BoxGeometry(0.9, 0.06, 0.9), 0x8d7f70, 0, 0.03, 0);
      add(new BoxGeometry(0.12, 0.065, 0.9), 0xa89a88, 0, 0.035, 0); // centre stripe
      if (det) {
        add(new BoxGeometry(0.05, 0.075, 0.9), 0x6f6356, -0.43, 0.037, 0); // kerbs
        add(new BoxGeometry(0.05, 0.075, 0.9), 0x6f6356, 0.43, 0.037, 0);
      }
      break;
    }
    case "house": {
      add(new BoxGeometry(0.5, 0.38, 0.5), 0xe8d8b8, 0, 0.19, 0);
      add(new ConeGeometry(0.42, 0.32, 4), 0xb0503c, 0, 0.53, 0, PI / 4, roof);
      add(new BoxGeometry(0.12, 0.18, 0.02), 0x6b4a2f, 0.1, 0.09, 0.26); // door
      win(-0.11, 0.22, 0.255); win(0.255, 0.22, 0, PI / 2);
      const chim = add(new BoxGeometry(0.08, 0.16, 0.08), 0x9a8a7a, -0.12, 0.5, -0.1);
      g.userData.chimney = [chim.position.x, chim.position.y, chim.position.z];
      break;
    }
    case "farm": {
      add(new BoxGeometry(0.9, 0.05, 0.9), 0x7a5a34, 0, 0.025, 0);
      for (let i = 0; i < 3; i++) add(new BoxGeometry(0.8, 0.09, 0.14), 0xd8b84a, 0, 0.07, -0.28 + i * 0.28);
      add(new BoxGeometry(0.2, 0.24, 0.16), 0xb0503c, 0.3, 0.12, 0.3); // shed
      break;
    }
    case "lumber": {
      add(new BoxGeometry(0.45, 0.3, 0.4), 0x8a6a44, 0, 0.15, 0);
      add(new ConeGeometry(0.38, 0.25, 4), 0x5f4430, 0, 0.42, 0, PI / 4, roof);
      const log1 = add(new CylinderGeometry(0.07, 0.07, 0.4, Math.round(6 * seg)), 0x6b4a2f, 0.28, 0.07, 0.15, PI / 2);
      const log2 = add(new CylinderGeometry(0.07, 0.07, 0.4, Math.round(6 * seg)), 0x7a5636, 0.28, 0.2, 0.1, PI / 2);
      void log1; void log2;
      break;
    }
    case "well": {
      add(new CylinderGeometry(0.2, 0.22, 0.3, Math.round(8 * seg)), 0x9a9a9a, 0, 0.15, 0);
      add(new ConeGeometry(0.28, 0.2, 4), 0x8c4a2f, 0, 0.5, 0, PI / 4, roof);
      if (det) add(new CylinderGeometry(0.16, 0.16, 0.02, Math.round(12 * seg)), 0x3d6f9e, 0, 0.3, 0, 0, { roughness: 0.1, env: 1.2 }); // water surface
      add(new BoxGeometry(0.04, 0.25, 0.04), 0x6b4a2f, 0.16, 0.35, 0);
      add(new BoxGeometry(0.04, 0.25, 0.04), 0x6b4a2f, -0.16, 0.35, 0);
      break;
    }
    case "market": {
      add(new BoxGeometry(0.6, 0.1, 0.6), 0xa89070, 0, 0.05, 0);
      add(new BoxGeometry(0.5, 0.3, 0.4), 0xd8c8a8, 0, 0.25, -0.05);
      const awning = add(new BoxGeometry(0.62, 0.05, 0.35), 0xc04a5a, 0, 0.45, 0.15, 0, roof);
      win(0.12, 0.28, 0.152);
      awning.rotation.x = 0.25;
      add(new BoxGeometry(0.04, 0.4, 0.04), 0x6b4a2f, 0.26, 0.2, 0.26);
      add(new BoxGeometry(0.04, 0.4, 0.04), 0x6b4a2f, -0.26, 0.2, 0.26);
      break;
    }
    default: add(new BoxGeometry(0.4, 0.4, 0.4), 0x888888, 0, 0.2, 0);
  }
  return g;
}

/** render.js syncState: the rules snapshot diffed into the scene (cleared forest, new / gone buildings, need markers). */
export function sync(state: State, needs: Map<number, HouseInfo> | null): void {
  if (!content) return;
  lastState = state;
  houseNeeds = needs;
  const { w, h } = state.grid;
  for (let i = 0; i < w * h; i++) {
    if (state.terrain[i] === decorTerrain[i]) continue;
    decorTerrain[i] = state.terrain[i]!;
    const ci = landCells.findIndex((c) => c.x === i % w && c.y === ((i / w) | 0));
    if (ci >= 0 && landMesh) {
      landMesh.setColorAt(ci, terrainColor(state.terrain[i]!).multiplyScalar(landCells[ci]!.shade));
      landMesh.instanceColor!.needsUpdate = true;
    }
    if (treeInstances) {
      const zero = new Matrix4().makeScale(0.0001, 0.0001, 0.0001);
      treeInstances.positions.forEach((p, pi) => {
        if (p.cell === i && p.s > 0) {
          p.s = 0;
          zero.setPosition(p.x, -5, p.z);
          treeInstances!.leaves.setMatrixAt(pi, zero);
          treeInstances!.trunks.setMatrixAt(pi, zero);
          treeInstances!.leaves.instanceMatrix.needsUpdate = true;
          treeInstances!.trunks.instanceMatrix.needsUpdate = true;
        }
      });
    }
  }
  const seen = new Set<string>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const b = state.cells[y * w + x];
      if (!b) continue;
      const k = x + "," + y;
      seen.add(k);
      const existing = buildingMeshes.get(k);
      if (!existing || existing.userData.type !== b.type) {
        if (existing) { buildGroup.remove(existing); disposeObj(existing); }
        const g = mergeParts(buildingParts(b.type));
        g.position.set(wx(x), cellTopY(x, y), wz(y));
        g.userData.type = b.type;
        buildGroup.add(g);
        buildingMeshes.set(k, g);
        if (!quietSync) {
          if (!reducedMotion) { g.scale.setScalar(0.01); popAnims.push({ group: g, t: 0 }); }
          burst(wx(x), cellTopY(x, y) + 0.4, wz(y), 0xd8c890, 10);
        }
      }
      updateNeedSprite(k, x, y, b.type, b.happy);
    }
  }
  for (const [k, g] of buildingMeshes) {
    if (seen.has(k)) continue;
    buildGroup.remove(g);
    disposeObj(g);
    buildingMeshes.delete(k);
    const sp = needSprites.get(k);
    if (sp) { fxGroup.remove(sp); sp.material.dispose(); needSprites.delete(k); }
  }
}
function updateNeedSprite(key: string, x: number, y: number, type: string, happy: number | undefined): void {
  if (type !== "house") return;
  const info = houseNeeds?.get(y * content!.grid.w + x);
  const unhappy = !!info && (!info.road || !info.water || !info.food || (happy !== undefined && happy < 0.5));
  let sprite = needSprites.get(key);
  if (unhappy) {
    if (!sprite) {
      sprite = new Sprite(new SpriteMaterial({ map: needTexture(), depthTest: false, transparent: true, toneMapped: false }));
      sprite.scale.set(0.4, 0.4, 1);
      sprite.renderOrder = 11;
      sprite.position.set(wx(x), cellTopY(x, y) + 1.0, wz(y));
      fxGroup.add(sprite);
      needSprites.set(key, sprite);
    }
  } else if (sprite) {
    fxGroup.remove(sprite);
    sprite.material.dispose();
    needSprites.delete(key);
  }
}

// ---------------------------------------------------------------- selection and ghosts
export function setHover(x: number | null, y = 0): void {
  if (x == null || !content) { selectRing.visible = false; return; }
  selectRing.visible = true;
  selectRing.position.set(wx(x), cellTopY(x, y) + 0.06, wz(y));
}
export function setCursor(x: number | null, y = 0): void {
  if (x == null || !content) { cursorMesh.visible = false; return; }
  cursorMesh.visible = true;
  cursorMesh.position.set(wx(x), cellTopY(x, y) + 0.06, wz(y));
}
/** render.js setGhost: the building previewed before commit, green when legal, red when not. */
export function setGhost(x: number | null, y: number, type: string | null, valid: boolean): void {
  if (x == null || !type || !content) { clearGhost(); return; }
  if (ghostType !== type) {
    clearGhost();
    ghost = buildingParts(type);
    ghost.traverse((o) => {
      const m = o as Mesh;
      if (!m.material) return;
      const c = (m.material as MeshStandardMaterial).clone() as MeshStandardMaterial;
      (m.material as Material).dispose();
      c.transparent = true;
      c.opacity = 0.55;
      c.depthWrite = false;
      if ((c as MeshStandardMaterial).emissive) c.emissive.setHex(0x000000);
      m.material = c;
      m.castShadow = false;
      m.receiveShadow = false;
    });
    selectGroup.add(ghost);
    ghostType = type;
  }
  const color = valid ? palette.valid : palette.invalid;
  ghost!.traverse((o) => { const m = o as Mesh; if (m.material) (m.material as MeshStandardMaterial).color.setHex(color); });
  ghost!.position.set(wx(x), cellTopY(x, y) + 0.03, wz(y));
  ghostAt = { x, y, valid };
}
export function clearGhost(): void {
  if (ghost) { selectGroup.remove(ghost); disposeObj(ghost); ghost = null; ghostType = null; }
  ghostAt = null;
}

// ---------------------------------------------------------------- camera
/** render.js panBy: a drag in window pixels (logical) moves the look-at point, which never leaves the board. */
export function panBy(dx: number, dz: number): void {
  const s = camDist * 0.0016;
  const sin = Math.sin(camTheta), cos = Math.cos(camTheta);
  camTargetGoal.x -= (dx * cos + dz * sin) * s;
  camTargetGoal.z += (dx * sin - dz * cos) * s;
  clampTarget();
}
function clampTarget(): void {
  const w = content ? content.grid.w : 10, h = content ? content.grid.h : 10;
  const lx = (w - 1) / 2 * TILE, lz = (h - 1) / 2 * TILE;
  camTargetGoal.x = Math.max(-lx, Math.min(lx, camTargetGoal.x));
  camTargetGoal.z = Math.max(-lz, Math.min(lz, camTargetGoal.z));
}
export function zoomBy(delta: number): void { camDistTarget = Math.max(6, Math.min(30, camDistTarget + delta)); }
export function resetCamera(): void {
  const w = content ? content.grid.w : 10;
  camTargetGoal.set(0, 0, 0);
  camDistTarget = Math.max(w, content ? content.grid.h : 10) * 1.25 + 5;
  camThetaTarget = PI * 0.25;
}
export function kick(amount = 1): void { shake = Math.min(2, shake + amount); }
function applyCamera(snap = 0): void {
  const k = snap ? 1 : 0.12;
  camTarget.lerp(camTargetGoal, k);
  camDist += (camDistTarget - camDist) * k;
  camTheta += (camThetaTarget - camTheta) * k;
  // Fit the board horizontally on narrow/portrait screens.
  const aspect = camera.aspect || 1;
  const fit = Math.max(1, Math.pow(1 / Math.max(0.4, aspect), 0.72));
  const dist = camDist * fit;
  const sp = Math.sin(camPhi), cp = Math.cos(camPhi);
  camera.position.set(camTarget.x + dist * sp * Math.sin(camTheta), camTarget.y + dist * cp, camTarget.z + dist * sp * Math.cos(camTheta));
  if (scene.fog) {
    const f = scene.fog as Fog;
    f.near = dist * 1.6;
    f.far = dist * 3.4;
  }
  if (shake > 0 && !reducedMotion && cameraShake) {
    const s = shake * 0.06;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
  }
  camera.lookAt(camTarget);
}

// ---------------------------------------------------------------- picking
const raycaster = new Raycaster();
const ndc = new Vector2();
const boardPlane = new Plane(new Vector3(0, 1, 0), -0.01);
const hitPoint = new Vector3();
/** render.js _pick: the tile under a window point (physical px), or null. */
export function pick(x: number, y: number): { x: number; y: number } | null {
  if (!content) return null;
  pointerToNdc(x, y, ndc);
  raycaster.setFromCamera(ndc, camera);
  if (!raycaster.ray.intersectPlane(boardPlane, hitPoint)) return null;
  const cx = Math.round(hitPoint.x / TILE + (content.grid.w - 1) / 2);
  const cy = Math.round(hitPoint.z / TILE + (content.grid.h - 1) / 2);
  if (cx < 0 || cy < 0 || cx >= content.grid.w || cy >= content.grid.h) return null;
  return { x: cx, y: cy };
}
const projV = new Vector3();
/** A tile's top centre in window pixels (for named targets and the browser checks). */
export function project(x: number, y: number, win: { w: number; h: number }): { x: number; y: number } | null {
  if (!content) return null;
  projV.set(wx(x), cellTopY(x, y), wz(y)).project(camera);
  if (projV.z > 1) return null;
  return { x: (projV.x * 0.5 + 0.5) * win.w, y: (-projV.y * 0.5 + 0.5) * win.h };
}

// ---------------------------------------------------------------- graphics level and options
/** The graphics level's look (quality.ts): post effects, shadows, shading model, textures, particles, clouds. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const prev = look;
  look = next;
  const b = next.budget;
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: next.ao === "high" ? 0.85 : 0.7, radius: 0.35, distanceExponent: 1.5, thickness: 0.6, scale: 1.0,
    samples: next.ao === "high" ? 16 : 8, resolution: b.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only window glow, water glints and bright highlights bloom.
  // r160 page: UnrealBloomPass 0.45 → 0.45² at minor 29 (r185 bloom).
  renderer.bloom = next.bloom ? { strength: 0.45 * 0.45, radius: 0.4, threshold: 0.9, resolution: b.bloomRes } : null;
  // render.js GradeShader after the output (display space): a 0.22-weight smoothstep S-curve (slope 1.11 at mid
  // grey), +10 % saturation, cool shadows / warm highlights split by a 0.2–0.8 smoothstep of luma, the 0.2
  // vignette from 0.38 to 0.8 (vertical distance × 0.85).
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.11, saturation: 1.1, shadows: [0.97, 0.99, 1.04], highlights: [1.03, 1.0, 0.96], split: [0.2, 0.8],
    vignette: { amount: 0.2, inner: 0.38, outer: 0.8, scale: [1, 0.85] },
  } : null;
  renderer.antialias = next.antialias;
  renderer.shadowMap.enabled = next.shadows > 0;
  keyLight.castShadow = next.shadows > 0;
  if (next.shadows > 0) keyLight.shadow.mapSize = next.shadows;
  poolSize = Math.min(PARTICLE_MAX, particlePool(next));
  pLife.fill(0); pPos.fill(-999); pHead = 0;
  pGeo.setDrawRange(0, Math.max(1, poolSize));
  applyDetailLights();
  const assets = (l: Look | null): string => (l ? [l.detailed, l.budget.texture, l.budget.segments, l.budget.clouds].join("|") : "");
  if (content && theme && prev && assets(prev) !== assets(next)) rebuild();
}
/** render.js _rebuildScene: the scene rebuilt from the retained content, the camera and state kept. */
function rebuild(): void {
  const cam = { t: camTarget.clone(), g: camTargetGoal.clone(), d: camDist, dt: camDistTarget, th: camTheta, tht: camThetaTarget };
  const gh = ghostAt && ghostType ? { ...ghostAt, type: ghostType } : null;
  load(content!, theme!);
  camTarget.copy(cam.t); camTargetGoal.copy(cam.g);
  camDist = cam.d; camDistTarget = cam.dt; camTheta = cam.th; camThetaTarget = cam.tht;
  if (lastState) { quietSync = true; sync(lastState, houseNeeds); quietSync = false; }
  if (gh) setGhost(gh.x, gh.y, gh.type, gh.valid);
}
export function setPalette(name: string): void {
  palette = PALETTES[name] ?? PALETTES.default!;
  (selectRing.material as MeshBasicMaterial).color.setHex(palette.select);
  (cursorMesh.material as MeshBasicMaterial).color.setHex(palette.cursor);
  if (ghostAt && ghostType) setGhost(ghostAt.x, ghostAt.y, ghostType, ghostAt.valid);
}
export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
  if (on) {
    for (const a of popAnims) a.group.scale.setScalar(1);
    popAnims.length = 0;
    pLife.fill(0);
  }
}
export function setCameraShake(on: boolean): void { cameraShake = on; }
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

// ---------------------------------------------------------------- the frame
let lastAspect = 0;
/** render.js update: water, clouds, pop-ins, marker bob, chimney smoke, particles, the camera. */
export function update(dtIn: number, w: number, h: number): void {
  const dt = Math.min(0.1, Math.max(0, dtIn));
  if (w > 0 && h > 0) {
    const aspect = w / h;
    if (aspect !== lastAspect) {
      lastAspect = aspect;
      camera.aspect = aspect;
      // Portrait: widen the FOV slightly to keep the board readable.
      camera.fov = w < h ? 48 : 38;
      camera.updateProjectionMatrix();
    }
  }
  time += dt;
  const moving = !reducedMotion;
  const waterAnim = moving && !!look?.waterAnimated;
  for (let i = 0; i < waterPos.length; i++) waterPos[i]!.y = -0.27 + (waterAnim ? Math.sin(time * 1.4 + waterPhase[i]!) * 0.02 : 0);
  if (waterPos.length) syncWater();
  const nm = waterMat && (waterMat as MeshStandardMaterial).normalMap;
  if (waterAnim && nm) nm.offset.set(time * 0.03, time * 0.017);
  if (moving) {
    for (const c of clouds) {
      c.position.x += (c.userData.speed as number) * dt;
      if (c.position.x > 24) c.position.x = -24;
    }
  }
  // A zoomed-out camera climbing towards cloud height would otherwise see them as foreground blobs: cull them.
  for (const c of clouds) c.visible = c.position.y - camera.position.y > 6;
  for (let i = popAnims.length - 1; i >= 0; i--) {
    const a = popAnims[i]!;
    a.t += (dt * 1000) / 280;
    const s = a.t >= 1 ? 1 : 1 - Math.pow(1 - a.t, 3) * (1 + 0.4 * Math.sin(a.t * PI));
    a.group.scale.setScalar(Math.max(0.01, s));
    if (a.t >= 1) { a.group.scale.setScalar(1); popAnims.splice(i, 1); }
  }
  if (moving) for (const sp of needSprites.values()) sp.position.y += Math.sin(time * 3 + sp.position.x) * 0.0006;
  if (look?.particles === "high" && moving && poolSize) {
    smokeTimer += dt * 1000;
    if (smokeTimer > look.budget.smokeMs) {
      smokeTimer = 0;
      const houses: Group[] = [];
      for (const g of buildingMeshes.values()) if (g.userData.chimney) houses.push(g);
      if (houses.length) {
        const g = houses[(Math.random() * houses.length) | 0]!;
        const c = g.userData.chimney as number[];
        smoke(g.position.x + c[0]!, g.position.y + c[1]! + 0.1, g.position.z + c[2]!);
      }
    }
  }
  shake = Math.max(0, shake - (dt * 1000) / 300);
  updateParticles(dt);
  applyCamera(0);
}
