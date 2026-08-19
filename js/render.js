// render.js — Three.js presentation layer. Consumes immutable rules snapshots,
// never mutates rules state. Low-poly town spanning river and hills, authored
// camera, instanced vegetation, pooled particles, quality tiers, separate
// layers for environment / gameplay / selection / effects.

import * as THREE from '../vendor/three.module.js';
import { TERRAIN } from './rules.js';
import { RngStream } from './rng.js';

export const LAYER = { ENV: 0, GAME: 1, SELECT: 2, FX: 3 };

const TILE = 1;            // world units per grid cell
const QUALITY = {
  low:    { dpr: 1.0, shadows: false, particles: 0,    antialias: false, water: true },
  medium: { dpr: 1.5, shadows: false, particles: 600,  antialias: true,  water: true },
  high:   { dpr: 2.0, shadows: true,  particles: 2000, antialias: true,  water: true },
};

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

export class TownRenderer {
  constructor(container, settings = {}) {
    this.container = container;
    this.settings = settings;
    this.qualityName = settings.quality && settings.quality !== 'auto' ? settings.quality : this._autoQuality();
    this.q = QUALITY[this.qualityName];

    this.renderer = new THREE.WebGLRenderer({ antialias: this.q.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.q.dpr));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = this.q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    this.camTarget = new THREE.Vector3(0, 0, 0);
    this.camDist = 14;
    this.camDistTarget = 14;
    this.camTheta = Math.PI * 0.25;   // around Y
    this.camPhi = 0.95;               // from vertical
    this.camThetaTarget = this.camTheta;
    this.camTargetGoal = this.camTarget.clone();

    this.palette = PALETTES[settings.colorPalette] || PALETTES.default;
    this.reducedMotion = !!settings.reducedMotion;

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

    this.resize();
  }

  _autoQuality() {
    const small = Math.min(screen.width, screen.height) < 820;
    const mobileUA = /Mobi|Android/i.test(navigator.userAgent);
    return mobileUA || small ? 'low' : 'high';
  }

  setQuality(name) {
    if (!QUALITY[name]) return;
    this.qualityName = name;
    this.q = QUALITY[name];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.q.dpr));
    this.renderer.shadowMap.enabled = this.q.shadows;
    if (this.keyLight) this.keyLight.castShadow = this.q.shadows;
    this.resize();
  }

  applySettings(s) {
    this.settings = s;
    this.palette = PALETTES[s.colorPalette] || PALETTES.default;
    this.reducedMotion = !!s.reducedMotion;
    if (s.quality && s.quality !== 'auto' && s.quality !== this.qualityName) this.setQuality(s.quality);
    if (this.selectRing) this.selectRing.material.color.setHex(this.palette.select);
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xcfe8ff, 0x6a7a5a, 0.9);
    this.scene.add(this.hemi);
    this.keyLight = new THREE.DirectionalLight(0xfff2dd, 1.6);
    this.keyLight.position.set(8, 14, 6);
    this.keyLight.castShadow = this.q.shadows;
    if (this.q.shadows) {
      this.keyLight.shadow.mapSize.set(1024, 1024);
      const s = 12;
      Object.assign(this.keyLight.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 40 });
      this.keyLight.shadow.bias = -0.0005;
    }
    this.scene.add(this.keyLight);
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

    this.scene.background = new THREE.Color(theme.sky);
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
    const landMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const landIds = [];
    const waterMat = new THREE.MeshLambertMaterial({ color: theme.water, transparent: true, opacity: 0.85 });
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
          m.receiveShadow = this.q.shadows;
          this.waterMeshes.push(m);
          this.waterPhase.push(rng.float() * Math.PI * 2);
          this.tileGroup.add(m);
          continue;
        }
        const height = 0.3 + hh;
        this._landCells.push({ x, y, t, height, shade: 0.92 + rng.float() * 0.12 });
      }
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
    land.receiveShadow = this.q.shadows;
    this.landMesh = land;
    this.tileGroup.add(land);

    // Invisible full-board pick plane (gameplay raycast layer).
    if (this.pickPlane) { disposeObj(this.pickPlane); }
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
    const leafMat = new THREE.MeshLambertMaterial({ color: this.theme.forest });
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2f });
    const leaves = new THREE.InstancedMesh(cone, leafMat, Math.max(1, positions.length));
    const trunks = new THREE.InstancedMesh(trunk, trunkMat, Math.max(1, positions.length));
    const m4 = new THREE.Matrix4();
    positions.forEach((p, i) => {
      m4.makeScale(p.s, p.s, p.s).setPosition(p.x, 0.55 * p.s, p.z);
      leaves.setMatrixAt(i, m4);
      m4.makeScale(p.s, p.s, p.s).setPosition(p.x, 0.12 * p.s, p.z);
      trunks.setMatrixAt(i, m4);
    });
    leaves.instanceMatrix.needsUpdate = true;
    trunks.instanceMatrix.needsUpdate = true;
    leaves.castShadow = this.q.shadows;
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
    const mat = new THREE.MeshLambertMaterial({ color: this.theme.rock });
    const rocks = new THREE.InstancedMesh(geo, mat, positions.length);
    const m4 = new THREE.Matrix4();
    const e = new THREE.Euler();
    positions.forEach((p, i) => {
      e.set(0, p.r, 0);
      m4.makeRotationFromEuler(e).scale(new THREE.Vector3(p.s, p.s * 0.8, p.s)).setPosition(p.x, 0.2, p.z);
      rocks.setMatrixAt(i, m4);
    });
    rocks.instanceMatrix.needsUpdate = true;
    rocks.castShadow = this.q.shadows;
    this.tileGroup.add(rocks);
  }

  _buildSky(rng) {
    // A few low-poly clouds drifting far above; pure decoration on env layer.
    this.clouds = [];
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    for (let i = 0; i < 5; i++) {
      const g = new THREE.Group();
      const n = rng.int(2, 4);
      for (let j = 0; j < n; j++) {
        const s = 0.6 + rng.float() * 0.8;
        const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), mat);
        puff.position.set(j * s * 0.9, rng.float() * 0.2, rng.float() * 0.4);
        g.add(puff);
      }
      g.position.set((rng.float() - 0.5) * 30, 7 + rng.float() * 3, (rng.float() - 0.5) * 30);
      g.userData.speed = 0.1 + rng.float() * 0.15;
      this.clouds.push(g);
      this.tileGroup.add(g);
    }
  }

  // ---- Building meshes -------------------------------------------------------------
  _buildingGroup(type) {
    const g = new THREE.Group();
    const add = (geo, color, x = 0, y = 0, z = 0, ry = 0) => {
      const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.castShadow = this.q.shadows;
      g.add(m);
      return m;
    };
    switch (type) {
      case 'hall': {
        add(new THREE.BoxGeometry(0.6, 0.5, 0.6), 0xb08968, 0, 0.25, 0);
        add(new THREE.ConeGeometry(0.5, 0.4, 4), 0x8c4a2f, 0, 0.7, 0, Math.PI / 4);
        add(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 4), 0x554433, 0, 1.05, 0);
        add(new THREE.BoxGeometry(0.22, 0.14, 0.02), 0xd4a017, 0.12, 1.2, 0); // banner
        break;
      }
      case 'road': {
        add(new THREE.BoxGeometry(0.9, 0.06, 0.9), 0x8d7f70, 0, 0.03, 0);
        add(new THREE.BoxGeometry(0.12, 0.065, 0.9), 0xa89a88, 0, 0.035, 0); // center stripe
        break;
      }
      case 'house': {
        add(new THREE.BoxGeometry(0.5, 0.38, 0.5), 0xe8d8b8, 0, 0.19, 0);
        add(new THREE.ConeGeometry(0.42, 0.32, 4), 0xb0503c, 0, 0.53, 0, Math.PI / 4);
        add(new THREE.BoxGeometry(0.12, 0.18, 0.02), 0x6b4a2f, 0.1, 0.09, 0.26); // door
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
        add(new THREE.ConeGeometry(0.38, 0.25, 4), 0x5f4430, 0, 0.42, 0, Math.PI / 4);
        add(new THREE.CylinderGeometry(0.07, 0.07, 0.4, 6), 0x6b4a2f, 0.28, 0.07, 0.15, Math.PI / 2);
        add(new THREE.CylinderGeometry(0.07, 0.07, 0.4, 6), 0x7a5636, 0.28, 0.2, 0.1, Math.PI / 2);
        break;
      }
      case 'well': {
        add(new THREE.CylinderGeometry(0.2, 0.22, 0.3, 8), 0x9a9a9a, 0, 0.15, 0);
        add(new THREE.ConeGeometry(0.28, 0.2, 4), 0x8c4a2f, 0, 0.5, 0, Math.PI / 4);
        add(new THREE.BoxGeometry(0.04, 0.25, 0.04), 0x6b4a2f, 0.16, 0.35, 0);
        add(new THREE.BoxGeometry(0.04, 0.25, 0.04), 0x6b4a2f, -0.16, 0.35, 0);
        break;
      }
      case 'market': {
        add(new THREE.BoxGeometry(0.6, 0.1, 0.6), 0xa89070, 0, 0.05, 0);
        add(new THREE.BoxGeometry(0.5, 0.3, 0.4), 0xd8c8a8, 0, 0.25, -0.05);
        const awning = add(new THREE.BoxGeometry(0.62, 0.05, 0.35), 0xc04a5a, 0, 0.45, 0.15);
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
            g.userData = { type: b.type, x, y };
            this.buildGroup.add(g);
            this.buildingMeshes.set(k, g);
            if (!this.reducedMotion) this.popAnims.push({ group: g, t: 0 });
            this.burst(this._wx(x), this.cellTopY(x, y) + 0.4, this._wz(y), 0xd8c890, 10);
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
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
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
      new THREE.MeshBasicMaterial({ color: this.palette.select, transparent: true, opacity: 0.9, depthTest: false }));
    this.selectRing.visible = false;
    this.selectRing.layers.set(LAYER.SELECT);
    this.selectRing.renderOrder = 10;
    this.selectGroup.add(this.selectRing);

    // Keyboard cursor (corners square)
    const curGeo = new THREE.RingGeometry(0.45, 0.5, 4);
    curGeo.rotateX(-Math.PI / 2);
    this.cursorMesh = new THREE.Mesh(curGeo,
      new THREE.MeshBasicMaterial({ color: this.palette.cursor, transparent: true, opacity: 0.8, depthTest: false }));
    this.cursorMesh.rotation.z = Math.PI / 4;
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
          o.castShadow = false;
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
    const lim = Math.max(this.content ? this.content.grid.w : 10, 10) * 0.8;
    this.camTargetGoal.x = Math.max(-lim, Math.min(lim, this.camTargetGoal.x));
    this.camTargetGoal.z = Math.max(-lim, Math.min(lim, this.camTargetGoal.z));
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
    const MAX = 2000;
    const geo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX * 3);
    this.pVel = new Float32Array(MAX * 3);
    this.pLife = new Float32Array(MAX);
    this.pCol = new Float32Array(MAX * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    const mat = new THREE.PointsMaterial({ size: 0.08, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false });
    this.points = new THREE.Points(geo, mat);
    this.points.layers.set(LAYER.FX);
    this.points.frustumCulled = false;
    this.pHead = 0;
    this.fxGroup.add(this.points);
  }

  burst(x, y, z, color, n = 12) {
    if (!this.q.particles || this.reducedMotion) return;
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      const idx = this.pHead;
      this.pHead = (this.pHead + 1) % this.q.particles;
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

  _updateParticles(dt) {
    const dtS = dt / 1000;
    for (let i = 0; i < this.q.particles; i++) {
      if (this.pLife[i] <= 0) { this.pPos[i * 3 + 1] = -999; continue; }
      this.pLife[i] -= dtS;
      this.pVel[i * 3 + 1] -= 3.5 * dtS;
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
    this.renderer.setSize(wpx, hpx, false);
    this.camera.aspect = wpx / hpx;
    // Portrait: widen FOV slightly to keep the board readable.
    this.camera.fov = wpx < hpx ? 48 : 38;
    this.camera.updateProjectionMatrix();
  }

  update(dtMs, visible = true) {
    if (!visible) return; // background tabs: render heartbeat handled by caller
    this.time += dtMs;
    const t = this.time / 1000;
    // Water bobbing (bounded, decorative).
    for (let i = 0; i < this.waterMeshes.length; i++) {
      this.waterMeshes[i].position.y = -0.27 + Math.sin(t * 1.4 + this.waterPhase[i]) * 0.02;
    }
    // Clouds drift.
    if (this.clouds && !this.reducedMotion) {
      for (const c of this.clouds) {
        c.position.x += c.userData.speed * dtMs / 1000;
        if (c.position.x > 24) c.position.x = -24;
      }
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
    for (const sp of this.needSprites.values()) {
      sp.position.y += Math.sin(t * 3 + sp.position.x) * 0.0006;
    }
    this.shake = Math.max(0, this.shake - dtMs / 300);
    this._updateParticles(dtMs);
    this._applyCamera(0);
    this.renderer.render(this.scene, this.camera);
  }

  // Debug/validation: draw-call & triangle evidence.
  stats() {
    return {
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      quality: this.qualityName,
    };
  }

  dispose() {
    window.removeEventListener('resize', this._resize);
    disposeObj(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
