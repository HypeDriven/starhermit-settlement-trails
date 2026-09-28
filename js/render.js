// render.js — Three.js presentation layer. Consumes immutable rules snapshots,
// never mutates rules state. Low-poly town spanning river and hills, authored
// camera, instanced vegetation, pooled particles, quality tiers, separate
// layers for environment / gameplay / selection / effects.

import * as THREE from '../vendor/three.module.js';
import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/addons/postprocessing/RenderPass.js';
import { ShaderPass } from '../vendor/addons/postprocessing/ShaderPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';
import { GTAOPass } from '../vendor/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from '../vendor/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from '../vendor/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from '../vendor/addons/environments/RoomEnvironment.js';
import { TERRAIN } from './rules.js';
import { RngStream } from './rng.js';
import { detectPreset, resolve, describe, SHADOW_MAP, PARTICLE_POOL } from './gfx.js';

export const LAYER = { ENV: 0, GAME: 1, SELECT: 2, FX: 3 };

const TILE = 1;            // world units per grid cell
const MAX_PARTICLES = 2000;

// Palettes reinforced by shape; color-vision variants swap selection/ghost hues.
const PALETTES = {
  default:      { select: 0xffd54a, valid: 0x7CFC7a, invalid: 0xff5a5a, cursor: 0xffffff },
  deuteranopia: { select: 0x4ac8ff, valid: 0x4ac8ff, invalid: 0xffb000, cursor: 0xffffff },
  protanopia:   { select: 0x4ac8ff, valid: 0x4ac8ff, invalid: 0xffb000, cursor: 0xffffff },
  tritanopia:   { select: 0xff6ad5, valid: 0x59d9a5, invalid: 0xff8c42, cursor: 0xffffff },
};

function disposeObj(root) {
  root.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
}

// Colour grade + vignette, applied after tone mapping (display-space in/out).
// Gentle S-curve, a touch more saturation, warm highlights / cool shadows.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.2 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.97, 0.99, 1.04), vec3(1.03, 1.0, 0.96), smoothstep(0.2, 0.8, l));
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.0, 0.85));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.8, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

// Deterministic tileable value-noise canvas (grayscale), used for ground grain
// and to derive the water normal map. Wraps at the edges so tiles stay seamless.
function noiseCanvas(size, seed, octaves = 3) {
  const rng = new RngStream(seed >>> 0, 'tex');
  const grids = [];
  for (let o = 0; o < octaves; o++) {
    const n = 4 << o;
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = rng.float();
    grids.push({ n, g });
  }
  const out = new Float32Array(size * size);
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0, amp = 1, tot = 0;
      for (const { n, g } of grids) {
        const fx = x / size * n, fy = y / size * n;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = smooth(fx - x0), ty = smooth(fy - y0);
        const at = (a, b) => g[((b % n) * n) + (a % n)];
        const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
        const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        v += (a + (b - a) * ty) * amp; tot += amp; amp *= 0.5;
      }
      out[y * size + x] = v / tot;
    }
  }
  return out;
}

function makeGroundTexture() {
  const size = 128;
  const n = noiseCanvas(size, 0x51ee7, 4);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let i = 0; i < n.length; i++) {
    // Mostly bright so instance colours stay true; soft mottling plus fine grain.
    const v = Math.round(255 * (0.84 + 0.16 * n[i]) * (0.97 + 0.03 * ((i * 2654435761) % 997) / 997));
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function makeWaterNormal() {
  const size = 64;
  const h = noiseCanvas(size, 0xa11ce, 3);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 3, dy = (at(x, y + 1) - at(x, y - 1)) * 3;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

// three's ACESFilmicToneMapping (r160) on a linear RGB triple.
function acesForward(c, exposure) {
  const IN = [[0.59719, 0.07600, 0.02840], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777]];
  const OUT = [[1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602]];
  const mul = (m, v) => [0, 1, 2].map(i => m[0][i] * v[0] + m[1][i] * v[1] + m[2][i] * v[2]);
  let v = c.map(x => x * exposure / 0.6);
  v = mul(IN, v);
  v = v.map(x => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081));
  return mul(OUT, v).map(x => Math.min(1, Math.max(0, x)));
}

/** Colour whose tone-mapped result matches `color` (so the sky keeps its authored hue). */
function untoneMapped(color, exposure) {
  const t = [color.r, color.g, color.b].map(x => Math.min(0.96, x));
  let x = t.slice();
  for (let i = 0; i < 200; i++) {
    const f = acesForward(x, exposure);
    x = x.map((xi, k) => Math.max(0, xi + (t[k] - f[k]) * 1.5));
  }
  return new THREE.Color(x[0], x[1], x[2]);
}

const prefersReducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

export class TownRenderer {
  constructor(container, settings = {}) {
    this.container = container;
    this.settings = settings;

    // The canvas never uses built-in MSAA: anti-aliasing (including MSAA) runs in
    // the post chain so it can change live; Low renders directly without AA.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.gpu = TownRenderer._gpuName(this.renderer);
    const mobile = (navigator.maxTouchPoints || 0) > 0 && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
      || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
    this.detected = detectPreset(this.gpu, { mobile });
    this.size = [0, 0];
    this.pixelRatio = 1;
    this.adaptiveScale = 1;
    this._frames = [];
    this.fps = 0;
    this.composer = null;
    this.postKey = null;
    this.postFailed = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    // Camera sees environment + selection + effects layers (gameplay layer is the
    // invisible pick plane, raycast only).
    this.camera.layers.enable(LAYER.SELECT);
    this.camera.layers.enable(LAYER.FX);
    this.camTarget = new THREE.Vector3(0, 0, 0);
    this.camDist = 14;
    this.camDistTarget = 14;
    this.camTheta = Math.PI * 0.25;   // around Y
    this.camPhi = 0.95;               // from vertical
    this.camThetaTarget = this.camTheta;
    this.camTargetGoal = this.camTarget.clone();

    this.palette = PALETTES[settings.colorPalette] || PALETTES.default;
    this.reducedMotion = !!settings.reducedMotion;
    this.q = resolve(settings.graphics, this.detected);

    this.content = null;
    this.theme = null;
    this.cellH = [];        // tile heights for y placement
    this.tileGroup = new THREE.Group();   // environment layer
    this.buildGroup = new THREE.Group();  // gameplay layer
    this.fxGroup = new THREE.Group();     // effects layer
    this.selectGroup = new THREE.Group(); // selection/ghost layer
    this.scene.add(this.tileGroup, this.buildGroup, this.selectGroup, this.fxGroup);
    this.tileGroup.layers.set(LAYER.ENV);
    this.buildingMeshes = new Map(); // "x,y" -> group
    this.waterMeshes = [];
    this.waterPhase = [];
    this.treeInstances = null;
    this.needSprites = new Map();
    this.popAnims = [];   // {group, t}
    this.particles = null;
    this.time = 0;
    this.shake = 0;
    this.smokeTimer = 0;
    this.lastState = null;

    // callbacks assigned by UI
    this.onTileHover = null;
    this.onTileTap = null;

    this._buildLights();
    this._buildSelectorMeshes();
    this._initParticles();
    this._bindPointer();

    this.raycaster = new THREE.Raycaster();
    this.raycaster.layers.set(LAYER.GAME);
    this.pointer = new THREE.Vector2();
    this.pickPlane = null;

    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (this.onContextLost) this.onContextLost();
    });

    this._gfxKey = null;
    this.setGraphics(settings.graphics || {});
    this.resize();
  }

  static _gpuName(r) {
    try {
      const gl = r.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch { return ''; }
  }

  get qualityName() { return this.q.preset; }

  /** Legacy tier names (low/medium/high) map onto presets. */
  setQuality(name) {
    const preset = name === 'medium' ? 'balanced' : name;
    this.setGraphics({ ...(this.settings.graphics || {}), preset });
  }

  applySettings(s) {
    this.settings = s;
    this.palette = PALETTES[s.colorPalette] || PALETTES.default;
    this.reducedMotion = !!s.reducedMotion;
    if (this.selectRing) this.selectRing.material.color.setHex(this.palette.select);
    this.setGraphics(s.graphics || {});
  }

  get motionReduced() { return this.reducedMotion || prefersReducedMotion(); }

  // ---- graphics settings ---------------------------------------------------------
  /** Apply saved graphics settings live (no reload). `{}` = Auto. */
  setGraphics(saved) {
    const key = JSON.stringify(saved || {});
    if (key === this._gfxKey) return;
    this._gfxKey = key;
    const prev = this.q;
    const g = resolve(saved, this.detected);
    this.q = g;
    const size = SHADOW_MAP[g.shadows];
    const shadowsChanged = !prev || (SHADOW_MAP[prev.shadows] > 0) !== (size > 0) || !this._gfxApplied;
    this.renderer.shadowMap.enabled = size > 0;
    this.keyLight.castShadow = size > 0;
    if (size > 0 && this.keyLight.shadow.mapSize.x !== size) {
      this.keyLight.shadow.mapSize.set(size, size);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    // Particles: resize the live pool; drop any in flight beyond it.
    this.poolSize = PARTICLE_POOL[g.particles];
    if (this.pLife) { this.pLife.fill(0); this.pPos.fill(-999); this.pHead = 0; }
    this._applyDetailLights();
    // Surface detail swaps materials, so rebuild the scene from retained content.
    if (this._gfxApplied && prev && prev.detail !== g.detail && this.content) this._rebuildScene();
    else if (shadowsChanged) this._refreshMaterials();
    this._gfxApplied = true;
    this.adaptiveScale = 1;
    this._frames = [];
    this.postFailed = false;
    this.postKey = null; // rebuild the post chain on the next frame
    this._fpsVisible(g.showFps);
    const el = this.renderer.domElement;
    el.dataset.gfxPreset = g.preset;
    document.body.dataset.gfxPreset = g.preset;
    document.body.dataset.gfxAuto = g.auto ? '1' : '0';
  }

  /** What the settings panel shows: GPU, auto choice, resolved tiers, cost, fps. */
  graphicsInfo() {
    const px = [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
    return {
      gpu: this.gpu || 'unknown GPU',
      detected: this.detected,
      resolved: this.q,
      summary: describe(this.q, px),
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  _refreshMaterials() {
    this.scene.traverse(o => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
    });
  }

  _rebuildScene() {
    const cam = {
      t: this.camTarget.clone(), g: this.camTargetGoal.clone(), d: this.camDist, dt: this.camDistTarget,
      th: this.camTheta, tht: this.camThetaTarget,
    };
    const ghostType = this.ghostType;
    const ghostPos = this.ghost ? this.ghost.position.clone() : null;
    this.clearGhost();
    this.loadContent(this.content, this.theme);
    this.camTarget.copy(cam.t); this.camTargetGoal.copy(cam.g);
    this.camDist = cam.d; this.camDistTarget = cam.dt;
    this.camTheta = cam.th; this.camThetaTarget = cam.tht;
    if (this.lastState) {
      this._quietSync = true;
      this.syncState(this.lastState);
      this._quietSync = false;
    }
    if (ghostType && ghostPos) this._ghostPending = { type: ghostType, pos: ghostPos };
  }

  _fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.className = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  get detailed() { return this.q.detail === 'detailed'; }

  /** Material factory: flat Lambert (plain) or PBR standard (detailed). */
  _mat(color, opts = {}) {
    if (!this.detailed) {
      const m = new THREE.MeshLambertMaterial({ color });
      if (opts.transparent) { m.transparent = true; m.opacity = opts.opacity; }
      return m;
    }
    return new THREE.MeshStandardMaterial({
      color, roughness: opts.roughness ?? 0.82, metalness: opts.metalness ?? 0,
      envMapIntensity: opts.env ?? 0.35,
      emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 1,
      transparent: !!opts.transparent, opacity: opts.opacity ?? 1, map: opts.map || null,
    });
  }

  _applyDetailLights() {
    if (this.detailed) {
      if (!this.envTex) {
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        this.envTex = pmrem.fromScene(new RoomEnvironment(this.renderer), 0.04).texture;
        pmrem.dispose();
      }
      this.scene.environment = this.envTex;
      // IBL supplies part of the fill, so the hemisphere backs off a little.
      this.hemi.intensity = 0.5;
      this.keyLight.intensity = 1.85;
      this.renderer.toneMappingExposure = 0.95;
    } else {
      this.scene.environment = null;
      this.hemi.intensity = 0.9;
      this.keyLight.intensity = 1.6;
      this.renderer.toneMappingExposure = 1.05;
    }
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xcfe8ff, 0x6a7a5a, 0.9);
    this.scene.add(this.hemi);
    this.keyLight = new THREE.DirectionalLight(0xfff2dd, 1.6);
    this.keyLight.position.set(8, 14, 6);
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.02;
    this._fitShadow(12);
    this.scene.add(this.keyLight, this.keyLight.target);
  }

  /** Fit the key light's orthographic shadow box tightly around the board. */
  _fitShadow(radius) {
    const dir = new THREE.Vector3(8, 14, 6).normalize();
    const dist = radius * 2 + 4;
    this.keyLight.position.copy(dir.multiplyScalar(dist));
    this.keyLight.target.position.set(0, 0, 0);
    const cam = this.keyLight.shadow.camera;
    Object.assign(cam, { left: -radius, right: radius, top: radius, bottom: -radius, near: dist - radius - 2, far: dist + radius + 2 });
    cam.updateProjectionMatrix();
  }

  // ---- Scene construction -----------------------------------------------------
  loadContent(content, theme) {
    // Explicit disposal on scene change.
    disposeObj(this.tileGroup); this.tileGroup.clear();
    disposeObj(this.buildGroup); this.buildGroup.clear();
    this.fxGroup.clear();
    this.buildingMeshes.clear();
    this.needSprites.clear();
    this.waterMeshes = [];
    this.waterPhase = [];
    this.popAnims = [];
    this.content = content;
    this.theme = theme;
    this.decorTerrain = content.terrain.slice(); // render-owned; content stays pristine

    if (this.bgTex) { this.bgTex.dispose(); this.bgTex = null; }
    if (this.detailed) {
      // Soft vertical sky gradient: lighter overhead, melting into the fog tint.
      const c = document.createElement('canvas');
      c.width = 2; c.height = 256;
      const g = c.getContext('2d');
      // The background is tone-mapped like the scene, so pre-compensate each stop.
      const exp = this.renderer.toneMappingExposure;
      const stop = (c) => '#' + untoneMapped(c, exp).getHexString();
      const top = new THREE.Color(theme.sky).offsetHSL(0, 0.08, -0.06);
      const grad = g.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, stop(top));
      grad.addColorStop(0.5, stop(new THREE.Color(theme.sky)));
      grad.addColorStop(1, stop(new THREE.Color(theme.fog)));
      g.fillStyle = grad; g.fillRect(0, 0, 2, 256);
      this.bgTex = new THREE.CanvasTexture(c);
      this.bgTex.colorSpace = THREE.SRGBColorSpace;
      this.scene.background = this.bgTex;
    } else {
      this.scene.background = new THREE.Color(theme.sky);
    }
    this.scene.fog = new THREE.Fog(theme.fog, 22, 48);

    const { w, h } = content.grid;
    const rng = new RngStream((content.seed ^ 0xdec0) >>> 0, 'decor');
    this.cellH = new Array(w * h).fill(0);

    // Heights: hills raised; everything else flat tabletop.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = content.terrain[y * w + x];
        this.cellH[y * w + x] = t === TERRAIN.HILL ? 0.45 : 0;
      }
    }

    // Land tiles: ONE InstancedMesh with per-instance color (draw-call budget).
    // Water stays individual meshes for bobbing animation.
    const landGeo = new THREE.BoxGeometry(1, 1, 1);
    if (this.detailed && !this.groundTex) this.groundTex = makeGroundTexture();
    if (this.detailed && !this.waterNormal) this.waterNormal = makeWaterNormal();
    const landMat = this._mat(0xffffff, { roughness: 0.95, env: 0.2, map: this.detailed ? this.groundTex : null });
    const waterMat = this.detailed
      ? new THREE.MeshStandardMaterial({
        color: theme.water, roughness: 0.2, metalness: 0.0, envMapIntensity: 0.45,
        transparent: true, opacity: 0.9, normalMap: this.waterNormal, normalScale: new THREE.Vector2(0.45, 0.45),
      })
      : new THREE.MeshLambertMaterial({ color: theme.water, transparent: true, opacity: 0.85 });
    this.waterMat = waterMat;
    const tileGeo = new THREE.BoxGeometry(TILE, 0.3, TILE);
    this._landCells = [];
    const terrainColor = (t) => new THREE.Color(
      t === TERRAIN.GRASS ? theme.grass :
      t === TERRAIN.FOREST ? new THREE.Color(theme.grass).multiplyScalar(0.92).getHex() :
      t === TERRAIN.HILL ? theme.hill : theme.rock);
    this._terrainColor = terrainColor;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = content.terrain[y * w + x];
        const hh = this.cellH[y * w + x];
        if (t === TERRAIN.WATER) {
          const m = new THREE.Mesh(tileGeo, waterMat);
          m.position.set(this._wx(x), -0.27, this._wz(y));
          m.receiveShadow = true;
          this.waterMeshes.push(m);
          this.waterPhase.push(rng.float() * Math.PI * 2);
          this.tileGroup.add(m);
          continue;
        }
        const height = 0.3 + hh;
        this._landCells.push({ x, y, t, height, shade: 0.92 + rng.float() * 0.12 });
      }
    }
    if (this.detailed && this.waterMeshes.length) {
      // Opaque riverbed under the translucent water so the sky never shows through.
      const bedMat = this._mat(new THREE.Color(theme.water).lerp(new THREE.Color(0x3a3020), 0.55).getHex(), { roughness: 1, env: 0.2 });
      const beds = new THREE.InstancedMesh(new THREE.BoxGeometry(TILE, 0.15, TILE), bedMat, this.waterMeshes.length);
      const bm = new THREE.Matrix4();
      this.waterMeshes.forEach((wm, i) => { bm.makeTranslation(wm.position.x, -0.375, wm.position.z); beds.setMatrixAt(i, bm); });
      beds.instanceMatrix.needsUpdate = true;
      beds.receiveShadow = true;
      this.tileGroup.add(beds);
    }
    const land = new THREE.InstancedMesh(landGeo, landMat, Math.max(1, this._landCells.length));
    this._landCells.forEach((c, i) => {
      const hh = this.cellH[c.y * w + c.x];
      // Tile top sits at cell height: flat tiles top at 0, hills at 0.45.
      const m = new THREE.Matrix4();
      m.makeScale(TILE, c.height, TILE);
      m.setPosition(this._wx(c.x), hh - c.height / 2, this._wz(c.y));
      land.setMatrixAt(i, m);
      land.setColorAt(i, terrainColor(c.t).multiplyScalar(c.shade));
    });
    land.instanceMatrix.needsUpdate = true;
    if (land.instanceColor) land.instanceColor.needsUpdate = true;
    land.receiveShadow = true;
    this.landMesh = land;
    this.tileGroup.add(land);

    // Invisible full-board pick plane (gameplay raycast layer).
    if (this.pickPlane) { this.scene.remove(this.pickPlane); disposeObj(this.pickPlane); }
    this.pickPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(w * TILE, h * TILE),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    this.pickPlane.rotation.x = -Math.PI / 2;
    this.pickPlane.position.set(0, 0.01, 0);
    this.pickPlane.layers.set(LAYER.GAME);
    this.scene.add(this.pickPlane);

    // Trees on forest tiles (instanced).
    this._buildForest(rng);
    // Rocks.
    this._buildRocks(rng);
    // Decorative clouds & birds (environment flavor, never raycastable).
    this._buildSky(rng);

    this._fitShadow(Math.hypot(w, h) * TILE / 2 + 0.6);
    // Warm window glow: stronger on dusk/night boards.
    this.windowGlow = theme.ambient === 'night' ? 2.6 : 1.4;

    // Camera framing: fit board.
    this.camTarget.set(0, 0, 0);
    this.camTargetGoal.set(0, 0, 0);
    this.camDist = Math.max(w, h) * 1.25 + 5;
    this.camDistTarget = this.camDist;
    this._applyCamera(1);
  }

  _wx(x) { return (x - (this.content.grid.w - 1) / 2) * TILE; }
  _wz(y) { return (y - (this.content.grid.h - 1) / 2) * TILE; }
  cellTopY(x, y) { return this.cellH[y * this.content.grid.w + x]; }

  _buildForest(rng) {
    const { w, h } = this.content.grid;
    const positions = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (this.content.terrain[y * w + x] === TERRAIN.FOREST) {
          const n = rng.int(2, 3);
          for (let i = 0; i < n; i++) {
            positions.push({
              x: this._wx(x) + (rng.float() - 0.5) * 0.6,
              z: this._wz(y) + (rng.float() - 0.5) * 0.6,
              s: 0.7 + rng.float() * 0.5,
              cell: y * w + x,
            });
          }
        }
      }
    }
    const cone = new THREE.ConeGeometry(0.22, 0.7, 6);
    const trunk = new THREE.CylinderGeometry(0.05, 0.07, 0.25, 5);
    const leafMat = this._mat(this.theme.forest, { roughness: 0.75 });
    const trunkMat = this._mat(0x6b4a2f, { roughness: 0.9 });
    if (this.detailed) {
      // Canopy tint variation per tree so forests read as foliage, not a flat block.
      leafMat.color.setHex(0xffffff);
    }
    const leaves = new THREE.InstancedMesh(cone, leafMat, Math.max(1, positions.length));
    const trunks = new THREE.InstancedMesh(trunk, trunkMat, Math.max(1, positions.length));
    const m4 = new THREE.Matrix4();
    const base = new THREE.Color(this.theme.forest);
    const tint = new THREE.Color();
    positions.forEach((p, i) => {
      m4.makeScale(p.s, p.s, p.s).setPosition(p.x, 0.55 * p.s, p.z);
      leaves.setMatrixAt(i, m4);
      if (this.detailed) {
        const v = ((p.cell * 7919 + i * 104729) % 1000) / 1000;
        tint.copy(base).offsetHSL((v - 0.5) * 0.03, 0, (v - 0.5) * 0.08);
        leaves.setColorAt(i, tint);
      }
      m4.makeScale(p.s, p.s, p.s).setPosition(p.x, 0.12 * p.s, p.z);
      trunks.setMatrixAt(i, m4);
    });
    leaves.instanceMatrix.needsUpdate = true;
    trunks.instanceMatrix.needsUpdate = true;
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    leaves.castShadow = true; leaves.receiveShadow = true;
    trunks.castShadow = true;
    this.treeInstances = { leaves, trunks, positions };
    this.tileGroup.add(leaves, trunks);
  }

  _buildRocks(rng) {
    const { w, h } = this.content.grid;
    const positions = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (this.content.terrain[y * w + x] === TERRAIN.ROCK) {
          positions.push({ x: this._wx(x), z: this._wz(y), s: 0.5 + rng.float() * 0.3, r: rng.float() * Math.PI });
        }
      }
    }
    if (!positions.length) return;
    const geo = new THREE.DodecahedronGeometry(0.32, 0);
    const mat = this._mat(this.theme.rock, { roughness: 0.7, env: 0.5 });
    if (this.detailed) mat.flatShading = true;
    const rocks = new THREE.InstancedMesh(geo, mat, positions.length);
    const m4 = new THREE.Matrix4();
    const e = new THREE.Euler();
    positions.forEach((p, i) => {
      e.set(0, p.r, 0);
      m4.makeRotationFromEuler(e).scale(new THREE.Vector3(p.s, p.s * 0.8, p.s)).setPosition(p.x, 0.2, p.z);
      rocks.setMatrixAt(i, m4);
    });
    rocks.instanceMatrix.needsUpdate = true;
    rocks.castShadow = true; rocks.receiveShadow = true;
    this.tileGroup.add(rocks);
  }

  _buildSky(rng) {
    // A few low-poly clouds drifting far above; pure decoration on env layer.
    this.clouds = [];
    const mat = this._mat(0xffffff, { transparent: true, opacity: 0.85, roughness: 1, env: 0.2 });
    for (let i = 0; i < 5; i++) {
      const g = new THREE.Group();
      const n = rng.int(2, 4);
      for (let j = 0; j < n; j++) {
        const s = 0.6 + rng.float() * 0.8;
        const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), mat);
        puff.position.set(j * s * 0.9, rng.float() * 0.2, rng.float() * 0.4);
        g.add(puff);
      }
      // High above any camera height so they never cross the board sightline.
      g.position.set((rng.float() - 0.5) * 30, 26 + rng.float() * 4, (rng.float() - 0.5) * 30);
      g.userData.speed = 0.1 + rng.float() * 0.15;
      this.clouds.push(g);
      this.tileGroup.add(g);
    }
  }

  // ---- Building meshes -------------------------------------------------------------
  _buildingGroup(type) {
    const g = new THREE.Group();
    const add = (geo, color, x = 0, y = 0, z = 0, ry = 0, opts) => {
      const m = new THREE.Mesh(geo, this._mat(color, opts));
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    const detailed = this.detailed;
    const roof = { roughness: 0.6, env: 0.5 };
    const glow = { roughness: 0.3, emissive: 0xffb65a, emissiveIntensity: this.windowGlow || 1.4 };
    const win = (x, y, z, ry = 0) => {
      if (!detailed) return;
      const w = add(new THREE.BoxGeometry(0.09, 0.09, 0.012), 0x3a2a18, x, y, z, ry, glow);
      w.castShadow = false;
      w.userData.window = true;
    };
    switch (type) {
      case 'hall': {
        add(new THREE.BoxGeometry(0.6, 0.5, 0.6), 0xb08968, 0, 0.25, 0);
        add(new THREE.ConeGeometry(0.5, 0.4, 4), 0x8c4a2f, 0, 0.7, 0, Math.PI / 4, roof);
        win(-0.14, 0.3, 0.305); win(0.14, 0.3, 0.305);
        if (detailed) add(new THREE.BoxGeometry(0.68, 0.06, 0.68), 0x8a7058, 0, 0.03, 0); // plinth
        add(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 4), 0x554433, 0, 1.05, 0);
        add(new THREE.BoxGeometry(0.22, 0.14, 0.02), 0xd4a017, 0.12, 1.2, 0, 0, { roughness: 0.5, emissive: 0x3a2800 }); // banner
        break;
      }
      case 'road': {
        add(new THREE.BoxGeometry(0.9, 0.06, 0.9), 0x8d7f70, 0, 0.03, 0);
        add(new THREE.BoxGeometry(0.12, 0.065, 0.9), 0xa89a88, 0, 0.035, 0); // center stripe
        if (detailed) {
          add(new THREE.BoxGeometry(0.05, 0.075, 0.9), 0x6f6356, -0.43, 0.037, 0); // kerbs
          add(new THREE.BoxGeometry(0.05, 0.075, 0.9), 0x6f6356, 0.43, 0.037, 0);
        }
        break;
      }
      case 'house': {
        add(new THREE.BoxGeometry(0.5, 0.38, 0.5), 0xe8d8b8, 0, 0.19, 0);
        add(new THREE.ConeGeometry(0.42, 0.32, 4), 0xb0503c, 0, 0.53, 0, Math.PI / 4, roof);
        add(new THREE.BoxGeometry(0.12, 0.18, 0.02), 0x6b4a2f, 0.1, 0.09, 0.26); // door
        win(-0.11, 0.22, 0.255); win(0.255, 0.22, 0, Math.PI / 2);
        const chim = add(new THREE.BoxGeometry(0.08, 0.16, 0.08), 0x9a8a7a, -0.12, 0.5, -0.1);
        g.userData.chimney = chim;
        break;
      }
      case 'farm': {
        add(new THREE.BoxGeometry(0.9, 0.05, 0.9), 0x7a5a34, 0, 0.025, 0);
        for (let i = 0; i < 3; i++) {
          add(new THREE.BoxGeometry(0.8, 0.09, 0.14), 0xd8b84a, 0, 0.07, -0.28 + i * 0.28);
        }
        add(new THREE.BoxGeometry(0.2, 0.24, 0.16), 0xb0503c, 0.3, 0.12, 0.3); // shed
        break;
      }
      case 'lumber': {
        add(new THREE.BoxGeometry(0.45, 0.3, 0.4), 0x8a6a44, 0, 0.15, 0);
        add(new THREE.ConeGeometry(0.38, 0.25, 4), 0x5f4430, 0, 0.42, 0, Math.PI / 4, roof);
        add(new THREE.CylinderGeometry(0.07, 0.07, 0.4, 6), 0x6b4a2f, 0.28, 0.07, 0.15, Math.PI / 2);
        add(new THREE.CylinderGeometry(0.07, 0.07, 0.4, 6), 0x7a5636, 0.28, 0.2, 0.1, Math.PI / 2);
        break;
      }
      case 'well': {
        add(new THREE.CylinderGeometry(0.2, 0.22, 0.3, 8), 0x9a9a9a, 0, 0.15, 0);
        add(new THREE.ConeGeometry(0.28, 0.2, 4), 0x8c4a2f, 0, 0.5, 0, Math.PI / 4, roof);
        if (detailed) add(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 12), 0x3d6f9e, 0, 0.3, 0, 0, { roughness: 0.1, env: 1.2 }); // water surface
        add(new THREE.BoxGeometry(0.04, 0.25, 0.04), 0x6b4a2f, 0.16, 0.35, 0);
        add(new THREE.BoxGeometry(0.04, 0.25, 0.04), 0x6b4a2f, -0.16, 0.35, 0);
        break;
      }
      case 'market': {
        add(new THREE.BoxGeometry(0.6, 0.1, 0.6), 0xa89070, 0, 0.05, 0);
        add(new THREE.BoxGeometry(0.5, 0.3, 0.4), 0xd8c8a8, 0, 0.25, -0.05);
        const awning = add(new THREE.BoxGeometry(0.62, 0.05, 0.35), 0xc04a5a, 0, 0.45, 0.15, 0, roof);
        win(0.12, 0.28, 0.152);
        awning.rotation.x = 0.25;
        add(new THREE.BoxGeometry(0.04, 0.4, 0.04), 0x6b4a2f, 0.26, 0.2, 0.26);
        add(new THREE.BoxGeometry(0.04, 0.4, 0.04), 0x6b4a2f, -0.26, 0.2, 0.26);
        break;
      }
      default: {
        add(new THREE.BoxGeometry(0.4, 0.4, 0.4), 0x888888, 0, 0.2, 0);
      }
    }
    return g;
  }

  /** Diff an immutable rules snapshot into the scene. */
  syncState(state) {
    if (!this.content) return;
    this.lastState = state;
    const { w, h } = state.grid;
    // Terrain may change (forest cleared). Update render-owned copy + instance colors.
    for (let i = 0; i < w * h; i++) {
      if (state.terrain[i] !== this.decorTerrain[i]) {
        this.decorTerrain[i] = state.terrain[i];
        const ci = this._landCells.findIndex(c => c.x === (i % w) && c.y === ((i / w) | 0));
        if (ci >= 0 && this.landMesh) {
          this.landMesh.setColorAt(ci, this._terrainColor(state.terrain[i]).multiplyScalar(this._landCells[ci].shade));
          this.landMesh.instanceColor.needsUpdate = true;
        }
        // Cleared forest: hide that cell's trees.
        if (this.treeInstances) {
          const zero = new THREE.Matrix4().makeScale(0.0001, 0.0001, 0.0001);
          this.treeInstances.positions.forEach((p, pi) => {
            if (p.cell === i && p.s > 0) {
              p.s = 0;
              zero.setPosition(p.x, -5, p.z);
              this.treeInstances.leaves.setMatrixAt(pi, zero);
              this.treeInstances.trunks.setMatrixAt(pi, zero);
              this.treeInstances.leaves.instanceMatrix.needsUpdate = true;
              this.treeInstances.trunks.instanceMatrix.needsUpdate = true;
            }
          });
        }
      }
    }
    // Buildings diff
    const seen = new Set();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const b = state.cells[y * w + x];
        const k = x + ',' + y;
        if (b) {
          seen.add(k);
          const existing = this.buildingMeshes.get(k);
          if (!existing || existing.userData.type !== b.type) {
            if (existing) { this.buildGroup.remove(existing); disposeObj(existing); }
            const g = this._buildingGroup(b.type);
            g.position.set(this._wx(x), this.cellTopY(x, y), this._wz(y));
            Object.assign(g.userData, { type: b.type, x, y });
            this.buildGroup.add(g);
            this.buildingMeshes.set(k, g);
            if (!this._quietSync) {
              if (!this.reducedMotion) this.popAnims.push({ group: g, t: 0 });
              this.burst(this._wx(x), this.cellTopY(x, y) + 0.4, this._wz(y), 0xd8c890, 10);
            }
          }
          this._updateNeedSprite(k, x, y, b, state);
        }
      }
    }
    for (const [k, g] of this.buildingMeshes) {
      if (!seen.has(k)) {
        this.buildGroup.remove(g);
        disposeObj(g);
        this.buildingMeshes.delete(k);
        const sp = this.needSprites.get(k);
        if (sp) { this.fxGroup.remove(sp); sp.material.map.dispose(); sp.material.dispose(); this.needSprites.delete(k); }
      }
    }
  }

  _updateNeedSprite(key, x, y, b, state) {
    if (b.type !== 'house') return;
    const info = this.houseNeeds && this.houseNeeds.get(y * state.grid.w + x);
    const unhappy = info && (!info.road || !info.water || !info.food || (b.happy !== undefined && b.happy < 0.5));
    let sprite = this.needSprites.get(key);
    if (unhappy) {
      if (!sprite) {
        sprite = this._makeNeedSprite();
        sprite.position.set(this._wx(x), this.cellTopY(x, y) + 1.0, this._wz(y));
        this.fxGroup.add(sprite);
        this.needSprites.set(key, sprite);
      }
    } else if (sprite) {
      this.fxGroup.remove(sprite);
      sprite.material.map.dispose(); sprite.material.dispose();
      this.needSprites.delete(key);
    }
  }

  _makeNeedSprite() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#ffd54a';
    g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#4a3800';
    g.font = 'bold 40px sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('!', 32, 34);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(0.4, 0.4, 1);
    sp.layers.set(LAYER.FX);
    return sp;
  }

  // ---- Selection / ghosts --------------------------------------------------------
  _buildSelectorMeshes() {
    // Grounded marker ring
    const ringGeo = new THREE.RingGeometry(0.42, 0.55, 24);
    ringGeo.rotateX(-Math.PI / 2);
    this.selectRing = new THREE.Mesh(ringGeo,
      new THREE.MeshBasicMaterial({ color: this.palette.select, transparent: true, opacity: 0.9, depthTest: false, toneMapped: false }));
    this.selectRing.visible = false;
    this.selectRing.layers.set(LAYER.SELECT);
    this.selectRing.renderOrder = 10;
    this.selectGroup.add(this.selectRing);

    // Keyboard cursor (corners square)
    const curGeo = new THREE.RingGeometry(0.45, 0.5, 4, 1, Math.PI / 4);
    curGeo.rotateX(-Math.PI / 2);
    this.cursorMesh = new THREE.Mesh(curGeo,
      new THREE.MeshBasicMaterial({ color: this.palette.cursor, transparent: true, opacity: 0.8, depthTest: false, toneMapped: false }));
    this.cursorMesh.visible = false;
    this.cursorMesh.layers.set(LAYER.SELECT);
    this.cursorMesh.renderOrder = 10;
    this.selectGroup.add(this.cursorMesh);

    this.ghost = null; // built per building type on demand
    this.ghostType = null;
  }

  setHover(x, y) {
    if (x == null) { this.selectRing.visible = false; return; }
    this.selectRing.visible = true;
    this.selectRing.position.set(this._wx(x), this.cellTopY(x, y) + 0.06, this._wz(y));
  }

  setCursor(x, y) {
    if (x == null) { this.cursorMesh.visible = false; return; }
    this.cursorMesh.visible = true;
    this.cursorMesh.position.set(this._wx(x), this.cellTopY(x, y) + 0.06, this._wz(y));
  }

  /** Ghost preview before commit: green when legal, red with reason when not. */
  setGhost(x, y, type, valid) {
    if (x == null || !type) { this.clearGhost(); return; }
    if (this.ghostType !== type) {
      this.clearGhost();
      this.ghost = this._buildingGroup(type);
      this.ghost.traverse(o => {
        if (o.material) {
          o.material = o.material.clone();
          o.material.transparent = true;
          o.material.opacity = 0.55;
          o.material.depthWrite = false;
          if (o.material.emissive) o.material.emissive.setHex(0x000000);
          o.castShadow = false;
          o.receiveShadow = false;
        }
        o.layers.set(LAYER.SELECT);
      });
      this.selectGroup.add(this.ghost);
      this.ghostType = type;
    }
    const color = valid ? this.palette.valid : this.palette.invalid;
    this.ghost.traverse(o => { if (o.material) o.material.color.setHex(color); });
    this.ghost.position.set(this._wx(x), this.cellTopY(x, y) + 0.03, this._wz(y));
  }

  clearGhost() {
    if (this.ghost) {
      this.selectGroup.remove(this.ghost);
      disposeObj(this.ghost);
      this.ghost = null;
      this.ghostType = null;
    }
  }

  // ---- Camera ----------------------------------------------------------------------
  panBy(dx, dz) {
    // Pan in view space.
    const s = this.camDist * 0.0016;
    const sin = Math.sin(this.camTheta), cos = Math.cos(this.camTheta);
    this.camTargetGoal.x += (dx * cos - dz * sin) * s * -1;
    this.camTargetGoal.z += (dx * sin + dz * cos) * s * -1;
    this._clampTarget();
  }

  // The look-at point never leaves the board, so some terrain is always under
  // the screen centre at every zoom level.
  _clampTarget() {
    const w = this.content ? this.content.grid.w : 10, h = this.content ? this.content.grid.h : 10;
    const lx = (w - 1) / 2 * TILE, lz = (h - 1) / 2 * TILE;
    this.camTargetGoal.x = Math.max(-lx, Math.min(lx, this.camTargetGoal.x));
    this.camTargetGoal.z = Math.max(-lz, Math.min(lz, this.camTargetGoal.z));
  }

  zoomBy(delta) {
    this.camDistTarget = Math.max(6, Math.min(30, this.camDistTarget + delta));
  }

  resetCamera() {
    const w = this.content ? this.content.grid.w : 10;
    this.camTargetGoal.set(0, 0, 0);
    this.camDistTarget = Math.max(w, this.content ? this.content.grid.h : 10) * 1.25 + 5;
    this.camThetaTarget = Math.PI * 0.25;
  }

  _applyCamera(snap = 0) {
    // Critically damped approach (frame-rate independent), interruptible.
    const k = snap ? 1 : 0.12;
    this.camTarget.lerp(this.camTargetGoal, k);
    this.camDist += (this.camDistTarget - this.camDist) * k;
    let dTheta = this.camThetaTarget - this.camTheta;
    this.camTheta += dTheta * k;
    // Fit the board horizontally on narrow/portrait screens (softened curve —
    // the wider portrait FOV already helps).
    const aspect = this.camera.aspect || 1;
    const fit = Math.max(1, Math.pow(1 / Math.max(0.4, aspect), 0.72));
    const dist = this.camDist * fit;
    const sp = Math.sin(this.camPhi), cp = Math.cos(this.camPhi);
    const px = this.camTarget.x + dist * sp * Math.sin(this.camTheta);
    const pz = this.camTarget.z + dist * sp * Math.cos(this.camTheta);
    const py = this.camTarget.y + dist * cp;
    this.camera.position.set(px, py, pz);
    // Fog tracks camera distance so zoomed-out portrait framing stays clear.
    if (this.scene.fog) {
      this.scene.fog.near = dist * 1.6;
      this.scene.fog.far = dist * 3.4;
    }
    if (this.shake > 0 && !this.reducedMotion && this.settings.cameraShake !== false) {
      const s = this.shake * 0.06;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
    }
    this.camera.lookAt(this.camTarget);
  }

  kick(amount = 1) { this.shake = Math.min(2, this.shake + amount); }

  // ---- Particles (pooled) --------------------------------------------------------------
  _initParticles() {
    const MAX = MAX_PARTICLES;
    const geo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX * 3);
    this.pVel = new Float32Array(MAX * 3);
    this.pLife = new Float32Array(MAX);
    this.pGrav = new Float32Array(MAX);
    this.pCol = new Float32Array(MAX * 3);
    this.pPos.fill(-999);
    this.poolSize = 0;
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    // Soft round dots rather than hard squares.
    const mat = new THREE.PointsMaterial({ size: 0.11, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, map: makeDotTexture() });
    this.points = new THREE.Points(geo, mat);
    this.points.layers.set(LAYER.FX);
    this.points.frustumCulled = false;
    this.pHead = 0;
    this.fxGroup.add(this.points);
  }

  burst(x, y, z, color, n = 12) {
    if (!this.poolSize || this.motionReduced) return;
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      const idx = this.pHead;
      this.pHead = (this.pHead + 1) % this.poolSize;
      this.pGrav[idx] = 3.5;
      this.pPos[idx * 3] = x; this.pPos[idx * 3 + 1] = y; this.pPos[idx * 3 + 2] = z;
      const a = Math.random() * Math.PI * 2;
      const v = 0.5 + Math.random() * 1.2;
      this.pVel[idx * 3] = Math.cos(a) * v * 0.4;
      this.pVel[idx * 3 + 1] = 1 + Math.random() * 1.2;
      this.pVel[idx * 3 + 2] = Math.sin(a) * v * 0.4;
      this.pLife[idx] = 0.6 + Math.random() * 0.4;
      this.pCol[idx * 3] = c.r; this.pCol[idx * 3 + 1] = c.g; this.pCol[idx * 3 + 2] = c.b;
    }
  }

  /** Slow chimney smoke puff (ambient; top particle tier only). */
  _smoke(x, y, z) {
    const idx = this.pHead;
    this.pHead = (this.pHead + 1) % this.poolSize;
    this.pPos[idx * 3] = x; this.pPos[idx * 3 + 1] = y; this.pPos[idx * 3 + 2] = z;
    this.pVel[idx * 3] = 0.05 + Math.random() * 0.08;
    this.pVel[idx * 3 + 1] = 0.22 + Math.random() * 0.16;
    this.pVel[idx * 3 + 2] = 0.08 * (Math.random() - 0.5);
    this.pLife[idx] = 1.2 + Math.random() * 0.6;
    this.pGrav[idx] = -0.02;
    const v = 0.78 + Math.random() * 0.1;
    this.pCol[idx * 3] = v; this.pCol[idx * 3 + 1] = v * 0.98; this.pCol[idx * 3 + 2] = v * 0.95;
  }

  _updateParticles(dt) {
    const dtS = dt / 1000;
    if (!this.poolSize) { this.points.visible = false; return; }
    this.points.visible = true;
    for (let i = 0; i < this.poolSize; i++) {
      if (this.pLife[i] <= 0) { this.pPos[i * 3 + 1] = -999; continue; }
      this.pLife[i] -= dtS;
      this.pVel[i * 3 + 1] -= this.pGrav[i] * dtS;
      this.pPos[i * 3] += this.pVel[i * 3] * dtS;
      this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dtS;
      this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dtS;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  // ---- Pointer input ----------------------------------------------------------------------
  _bindPointer() {
    const el = this.renderer.domElement;
    let downAt = null, downPos = null, dragging = false, pid = null;
    el.style.touchAction = 'none';

    el.addEventListener('pointerdown', (e) => {
      pid = e.pointerId;
      el.setPointerCapture(pid);
      downAt = performance.now();
      downPos = { x: e.clientX, y: e.clientY };
      dragging = false;
    });
    el.addEventListener('pointermove', (e) => {
      if (downPos && (Math.abs(e.clientX - downPos.x) > 8 || Math.abs(e.clientY - downPos.y) > 8)) dragging = true;
      if (dragging && downPos) {
        this.panBy(e.movementX, e.movementY);
      } else {
        const cell = this._pick(e);
        if (this.onTileHover) this.onTileHover(cell ? cell : null);
      }
    });
    el.addEventListener('pointerup', (e) => {
      if (pid !== null && el.hasPointerCapture(pid)) el.releasePointerCapture(pid);
      const dt = performance.now() - (downAt || 0);
      const wasDrag = dragging;
      pid = null; downPos = null; dragging = false;
      if (!wasDrag && dt < 600) {
        const cell = this._pick(e);
        if (cell && this.onTileTap) this.onTileTap(cell.x, cell.y);
        else if (!cell && this.onTileTap) this.onTileTap(null, null);
      }
    });
    el.addEventListener('pointercancel', () => {
      // Safe cancel on lost capture.
      if (pid !== null && el.hasPointerCapture(pid)) el.releasePointerCapture(pid);
      pid = null; downPos = null; dragging = false;
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomBy(e.deltaY * 0.01);
    }, { passive: false });
  }

  _pick(e) {
    if (!this.pickPlane || !this.content) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.pickPlane, false);
    if (!hits.length) return null;
    const p = hits[0].point;
    const x = Math.round(p.x / TILE + (this.content.grid.w - 1) / 2);
    const y = Math.round(p.z / TILE + (this.content.grid.h - 1) / 2);
    if (x < 0 || y < 0 || x >= this.content.grid.w || y >= this.content.grid.h) return null;
    return { x, y };
  }

  /** Project a cell to CSS pixels for DOM label alignment. */
  projectCell(x, y) {
    const v = new THREE.Vector3(this._wx(x), this.cellTopY(x, y) + 0.6, this._wz(y));
    v.project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
      y: (-v.y * 0.5 + 0.5) * rect.height + rect.top,
      behind: v.z > 1,
    };
  }

  // ---- Frame update ---------------------------------------------------------------------
  resize() {
    const wpx = this.container.clientWidth || 1;
    const hpx = this.container.clientHeight || 1;
    this.camera.aspect = wpx / hpx;
    // Portrait: widen FOV slightly to keep the board readable.
    this.camera.fov = wpx < hpx ? 48 : 38;
    this.camera.updateProjectionMatrix();
    this._applySize(true);
  }

  /** Pixel ratio = min(dpr, preset cap) × preset/user scale × adaptive scale. */
  _applySize(force = false) {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const ratio = Math.min(window.devicePixelRatio || 1, this.q.dprCap) * this.q.scale * this.adaptiveScale;
    if (!force && w === this.size[0] && h === this.size[1] && ratio === this.pixelRatio) return;
    this.size = [w, h];
    this.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
  }

  _postKey() {
    const g = this.q;
    return g.post ? [g.ao, g.bloom, g.grade, g.antialias, this.size[0], this.size[1], this.pixelRatio].join('|') : 'none';
  }

  _buildPost() {
    const g = this.q;
    if (this.composer) {
      this.composer.passes.forEach(p => p.dispose && p.dispose());
      this.composer.dispose();
    }
    this.composer = null;
    if (!g.post || this.postFailed) return;
    const [w, h] = this.size;
    const pr = this.pixelRatio;
    try {
      const target = new THREE.WebGLRenderTarget(w * pr, h * pr, {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, w * pr, h * pr);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = g.ao === 'high' ? 0.85 : 0.7;
        ao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 0.6, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        // Keep sprites, selection markers, particles and the background out of the
        // AO depth/normal pass (a texture background would otherwise be drawn there
        // as a world-space quad with the override material).
        const hide = ao.overrideVisibility.bind(ao);
        const restore = ao.restoreVisibility.bind(ao);
        let bg = null;
        ao.overrideVisibility = () => {
          hide();
          this.fxGroup.visible = false; this.selectGroup.visible = false;
          bg = this.scene.background; this.scene.background = null;
        };
        ao.restoreVisibility = () => { restore(); this.scene.background = bg; };
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // High threshold: only window glow, water glints and bright highlights bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.45, 0.4, 0.9));
      }
      composer.addPass(new OutputPass());
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(w * pr, h * pr));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly and say so in the panel.
      this.postFailed = true;
      this.composer = null;
    }
  }

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  _adapt(dt) {
    // Frame-rate readout refreshes about twice a second.
    this._fpsT = (this._fpsT || 0) + dt; this._fpsN = (this._fpsN || 0) + 1;
    if (this._fpsT >= 500) {
      this.fps = 1000 * this._fpsN / this._fpsT;
      this._fpsT = 0; this._fpsN = 0;
      const el = document.getElementById('fps-meter');
      if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    }
    const f = this._frames;
    f.push(dt);
    if (f.length < 90) return;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    if (!this.q.adaptive) return;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, Math.round((this.adaptiveScale - 0.1) * 100) / 100);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, Math.round((this.adaptiveScale + 0.05) * 100) / 100);
  }

  update(dtMs, visible = true) {
    if (!visible) return; // background tabs: render heartbeat handled by caller
    this.time += dtMs;
    const t = this.time / 1000;
    const moving = !this.motionReduced;
    const waterAnim = moving && this.q.water === 'animated';
    // Water bobbing (bounded, decorative) and a slow drifting normal-map shimmer.
    for (let i = 0; i < this.waterMeshes.length; i++) {
      this.waterMeshes[i].position.y = -0.27 + (waterAnim ? Math.sin(t * 1.4 + this.waterPhase[i]) * 0.02 : 0);
    }
    if (waterAnim && this.waterMat && this.waterMat.normalMap) {
      this.waterMat.normalMap.offset.set(t * 0.03, t * 0.017);
    }
    // Clouds drift.
    if (this.clouds && moving) {
      for (const c of this.clouds) {
        c.position.x += c.userData.speed * dtMs / 1000;
        if (c.position.x > 24) c.position.x = -24;
      }
    }
    if (this.clouds) {
      // A zoomed-out camera climbing towards cloud height would otherwise see
      // them as foreground blobs over the buildings: cull them.
      const camY = this.camera.position.y;
      for (const c of this.clouds) c.visible = c.position.y - camY > 6;
    }
    // Pop-in animations.
    for (let i = this.popAnims.length - 1; i >= 0; i--) {
      const a = this.popAnims[i];
      a.t += dtMs / 280;
      const s = a.t >= 1 ? 1 : 1 - Math.pow(1 - a.t, 3) * (1 + 0.4 * Math.sin(a.t * Math.PI));
      a.group.scale.setScalar(Math.max(0.01, this.reducedMotion ? 1 : s));
      if (a.t >= 1) { a.group.scale.setScalar(1); this.popAnims.splice(i, 1); }
    }
    // Need sprites bob.
    if (moving) {
      for (const sp of this.needSprites.values()) {
        sp.position.y += Math.sin(t * 3 + sp.position.x) * 0.0006;
      }
    }
    // Chimney smoke (top particle tier, full motion only).
    if (this.q.particles === 'high' && moving) {
      this.smokeTimer += dtMs;
      if (this.smokeTimer > 260) {
        this.smokeTimer = 0;
        const houses = [];
        for (const g of this.buildingMeshes.values()) if (g.userData.chimney) houses.push(g);
        if (houses.length) {
          const g = houses[(Math.random() * houses.length) | 0];
          const c = g.userData.chimney;
          this._smoke(g.position.x + c.position.x, g.position.y + c.position.y + 0.1, g.position.z + c.position.z);
        }
      }
    }
    this.shake = Math.max(0, this.shake - dtMs / 300);
    this._updateParticles(dtMs);
    this._applyCamera(0);
    this._render(dtMs);
  }

  _render(dtMs) {
    this._adapt(dtMs);
    this._applySize();
    const key = this._postKey();
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost();
    }
    if (this.composer) this.composer.render(dtMs / 1000);
    else this.renderer.render(this.scene, this.camera);
  }

  // Debug/validation: draw-call & triangle evidence.
  stats() {
    return {
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      quality: this.qualityName,
      pixelRatio: this.pixelRatio,
      post: !!this.composer,
    };
  }

  dispose() {
    window.removeEventListener('resize', this._resize);
    if (this.composer) this.composer.dispose();
    disposeObj(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
