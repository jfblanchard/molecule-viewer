/**
 * main.js — Three.js scene and UI for the molecule viewer.
 *
 * molecules.js holds the geometry and a flat list of orbitals (σ hybrids,
 * π p orbitals, lone pairs, hydrogen 1s), each with a center and an axis.
 * Every lobe is symmetric about its axis, so worker.js meshes each distinct
 * shape once along +z and this file places rotated copies on the atoms.
 *
 * Sections
 *   1. Scene       renderer, camera, lights, axes
 *   2. Framework   atoms as CPK spheres, bonds as sticks
 *   3. Orbitals    translucent materials, worker queue, lobe placement
 *   4. UI          sidebar, info card, chips, controls, selection
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { MOLECULES, MOLECULES_BY_ID } from './molecules.js';
import { A0, ELEMENTS, canonical } from './molecules-lib.js';

const PLUS_COLOR = '#e8453c';
const MINUS_COLOR = '#3b82f6';
const ROLES = {
  sigma: { color: '#38bdf8', label: 'σ hybrid', chip: 'σ' },
  pi: { color: '#4ade80', label: 'π (unhybridized p)', chip: 'π' },
  lp: { color: '#f5a524', label: 'Lone pair', chip: 'lone pairs' },
  h1s: { color: '#e5e7eb', label: 'Hydrogen 1s', chip: 'H 1s' },
};
const ROLE_ORDER = ['sigma', 'pi', 'lp', 'h1s'];

// ============================================================================
// 1. SCENE
// ============================================================================

const viewport = document.getElementById('viewport');

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewport.prepend(renderer.domElement);

const labelRenderer = new CSS2DRenderer({ element: document.getElementById('labels') });

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

// z is "up", as in the orbital viewer. The camera sits off the +x axis.
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 500);
camera.up.set(0, 0, 1);
const VIEW_DIR = new THREE.Vector3(1, 0.42, 0.55).normalize();
camera.position.copy(VIEW_DIR).multiplyScalar(12);
scene.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.8;

scene.add(new THREE.HemisphereLight(0xffffff, 0x303040, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 2.6);
key.position.set(1, 1.5, 2);
camera.add(key);

// Axes: thin lines through the center of mass with italic x/y/z labels.
const axes = new THREE.Group();
const axisMat = new THREE.LineBasicMaterial({ color: 0x5a606a, transparent: true, opacity: 0.7 });
const axisLabels = [];
for (const [name, dir] of [['x', [1, 0, 0]], ['y', [0, 1, 0]], ['z', [0, 0, 1]]]) {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(...dir).multiplyScalar(-1),
    new THREE.Vector3(...dir),
  ]);
  axes.add(new THREE.Line(geo, axisMat));
  const el = document.createElement('div');
  el.className = 'axis-label';
  el.textContent = name;
  const label = new CSS2DObject(el);
  label.userData.dir = new THREE.Vector3(...dir);
  axes.add(label);
  axisLabels.push(label);
}
scene.add(axes);

function setAxisLength(len) {
  axes.children.forEach((c) => {
    if (c.isLine) c.scale.setScalar(len);
  });
  axisLabels.forEach((l) => l.position.copy(l.userData.dir).multiplyScalar(len * 1.05));
}

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// Smoothly move the camera so a sphere of radius R fills the view.
let fit = null;
function fitCamera(R, animate = true, view = null) {
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const halfAngle = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * camera.aspect)) / 2;
  const dist = (R / Math.sin(halfAngle)) * 1.15;
  const dir = view
    ? new THREE.Vector3(...view).normalize()
    : camera.position.clone().sub(controls.target).normalize();
  const to = dir.multiplyScalar(dist);
  if (!animate) {
    camera.position.copy(to);
    controls.target.set(0, 0, 0);
    fit = null;
    return;
  }
  fit = { from: camera.position.clone(), to, target: controls.target.clone(), t0: performance.now() };
}

function stepFit(now) {
  if (!fit) return;
  const t = Math.min(1, (now - fit.t0) / 450);
  const e = t * t * (3 - 2 * t); // smoothstep
  const len = THREE.MathUtils.lerp(fit.from.length(), fit.to.length(), e);
  const dir = fit.from.clone().normalize().lerp(fit.to.clone().normalize(), e).normalize();
  camera.position.copy(dir.multiplyScalar(len));
  controls.target.copy(fit.target).multiplyScalar(1 - e);
  if (t === 1) fit = null;
}

// ============================================================================
// 2. FRAMEWORK
// ============================================================================
//
// Ball-and-stick, opaque, drawn before the translucent lobes so the lobes
// tint whatever sits behind them. Balls are kept small so the orbitals read.

const sphereGeo = new THREE.SphereGeometry(1, 32, 20);
const stickGeo = new THREE.CylinderGeometry(1, 1, 1, 16, 1);
const atomMats = Object.fromEntries(Object.entries(ELEMENTS).map(([el, e]) => [
  el, new THREE.MeshStandardMaterial({ color: e.color, roughness: 0.45, metalness: 0.05 }),
]));
const stickMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.5 });
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

function buildFramework(mol) {
  const group = new THREE.Group();
  for (const at of mol.atoms) {
    const m = new THREE.Mesh(sphereGeo, atomMats[at.el]);
    m.position.set(...at.pos);
    m.scale.setScalar(ELEMENTS[at.el].radius);
    group.add(m);
  }
  // Multiple bonds are drawn as parallel sticks spread along the π direction,
  // like the bent bonds of a model kit, so CO₂'s two C=O visibly turn 90°.
  for (const b of mol.bonds) {
    const p = new THREE.Vector3(...mol.atoms[b.a].pos);
    const q = new THREE.Vector3(...mol.atoms[b.b].pos);
    const axis = q.clone().sub(p);
    const len = axis.length();
    axis.normalize();
    const perp = b.perp ? new THREE.Vector3(...b.perp) : new THREE.Vector3(1, 0, 0);
    const offsets = b.order === 1 ? [0] : b.order === 2 ? [-1, 1] : [0, 120, 240];
    const r = b.order === 1 ? 0.07 : 0.05;
    for (const o of offsets) {
      const shift = b.order === 3
        ? perp.clone().applyAxisAngle(axis, THREE.MathUtils.degToRad(o)).multiplyScalar(0.085)
        : perp.clone().multiplyScalar(0.075 * o);
      const s = new THREE.Mesh(stickGeo, stickMat);
      s.position.copy(p).add(q).multiplyScalar(0.5).add(shift);
      s.quaternion.setFromUnitVectors(Y_AXIS, axis);
      s.scale.set(r, len, r);
      group.add(s);
    }
  }
  return group;
}

// ============================================================================
// 3. ORBITALS
// ============================================================================
//
// Same "textbook" material as the orbital viewer: translucent shells that
// thicken toward the silhouette, back faces then front faces, no depth
// writes so overlapping lobes blend.

const opacity = { value: 0.4 };
const materials = [];

function makeMaterial(color, side) {
  const mat = new THREE.MeshPhysicalMaterial({
    color,
    side,
    transparent: true,
    opacity: opacity.value,
    depthWrite: false,
    roughness: 0.35,
    metalness: 0,
    clearcoat: 0.4,
    clearcoatRoughness: 0.3,
  });
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
      float rimF = 1.0 - abs(dot(normalize(vViewPosition), normal));
      diffuseColor.a = clamp(diffuseColor.a * (0.5 + 1.4 * rimF * rimF), 0.0, 1.0);`,
    );
  };
  materials.push(mat);
  return mat;
}

const matCache = new Map();
function materialPair(color) {
  if (!matCache.has(color)) {
    matCache.set(color, { back: makeMaterial(color, THREE.BackSide), front: makeMaterial(color, THREE.FrontSide) });
  }
  return matCache.get(color);
}
const darker = (hex) => `#${new THREE.Color(hex).multiplyScalar(0.3).getHexString()}`;

function setOpacity(v) {
  opacity.value = v;
  materials.forEach((m) => { m.opacity = v; });
}

// Color by role (σ / π / lone pair / H 1s, with ψ < 0 a darker shade), or
// by sign alone (red +, blue −) like the orbital viewer.
function paint(group, bySign) {
  group.traverse((m) => {
    if (!m.isMesh) return;
    const { sign, role, side } = m.userData;
    const hue = ROLES[role].color;
    const color = bySign ? (sign > 0 ? PLUS_COLOR : MINUS_COLOR) : (sign > 0 ? hue : darker(hue));
    m.material = materialPair(color)[side];
  });
}

// --- worker queue ------------------------------------------------------------
//
// Keys are "<canonical key>@<fraction>". Each resolves to a list of
// { sign, geometry } in a0, shared by every lobe of that shape.

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const shapes = new Map();  // key → [{ sign, geometry }]
const specs = new Map();   // key → worker request
const waiting = new Map(); // key → [resolve]
const queue = [];
let busy = null;

worker.onmessage = (e) => {
  const res = e.data;
  const parts = res.surfaces.map((s) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(s.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(s.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(s.indices, 1));
    geo.computeBoundingSphere();
    return { sign: s.sign, geometry: geo };
  });
  shapes.set(res.key, parts);
  (waiting.get(res.key) || []).forEach((resolve) => resolve(parts));
  waiting.delete(res.key);
  busy = null;
  pump();
};

function pump() {
  if (busy) return;
  while (queue.length && shapes.has(queue[0])) queue.shift();
  if (!queue.length) return;
  busy = queue.shift();
  worker.postMessage(specs.get(busy));
}

function shapeKey(o, fraction) {
  const c = canonical(o);
  const k = `${c.key}@${fraction}`;
  // spheres need fewer cells than directional lobes
  if (!specs.has(k)) specs.set(k, { key: k, Z: c.Z, terms: c.terms, fraction, N: c.n === 1 ? 64 : 80 });
  return k;
}

function request(k, urgent) {
  if (shapes.has(k)) return Promise.resolve(shapes.get(k));
  const p = new Promise((resolve) => {
    if (!waiting.has(k)) waiting.set(k, []);
    waiting.get(k).push(resolve);
  });
  const i = queue.indexOf(k);
  if (i >= 0) queue.splice(i, 1);
  if (busy !== k) urgent ? queue.unshift(k) : queue.push(k);
  pump();
  return p;
}

function prefetchAll(fraction) {
  for (const mol of MOLECULES) {
    for (const o of mol.orbitals) {
      const k = shapeKey(o, fraction);
      if (!shapes.has(k) && !queue.includes(k) && busy !== k) queue.push(k);
    }
  }
  pump();
}

/** All lobes of a molecule, each a rotated, scaled copy of its canonical shape. */
async function buildOrbitals(mol, fraction) {
  const keys = mol.orbitals.map((o) => shapeKey(o, fraction));
  // urgent requests jump the queue; reverse so the first ends up in front
  const unique = [...new Set(keys)];
  const loaded = new Map();
  await Promise.all(unique.reverse().map(async (k) => loaded.set(k, await request(k, true))));

  const group = new THREE.Group();
  mol.orbitals.forEach((o, idx) => {
    const lobe = new THREE.Group();
    lobe.position.set(...o.center);
    if (o.dir) lobe.quaternion.setFromUnitVectors(Z_AXIS, new THREE.Vector3(...o.dir));
    lobe.scale.setScalar(A0);
    lobe.userData = { role: o.role };
    for (const { sign, geometry } of loaded.get(keys[idx])) {
      const back = new THREE.Mesh(geometry);
      const front = new THREE.Mesh(geometry);
      back.renderOrder = 1;
      front.renderOrder = 2;
      // the small ψ < 0 lobe behind each hybrid (π lobes are equal pairs, not "small")
      const small = sign < 0 && o.role !== 'pi';
      back.userData = { sign, role: o.role, side: 'back', small };
      front.userData = { sign, role: o.role, side: 'front', small };
      lobe.add(back, front);
    }
    group.add(lobe);
  });
  return group;
}

// ============================================================================
// 4. UI
// ============================================================================

const $ = (id) => document.getElementById(id);
const GROUPS = [
  ['single', 'Single bonds'],
  ['pi', 'With π bonds'],
];

const buttons = new Map();
for (const [g, title] of GROUPS) {
  const section = document.createElement('section');
  section.className = 'group';
  section.innerHTML = `<h2>${title}</h2><div class="items"></div>`;
  const items = section.querySelector('.items');
  MOLECULES.filter((m) => m.group === g).forEach((m) => {
    const b = document.createElement('button');
    b.className = 'mol';
    b.innerHTML = `<span class="f">${m.formula}</span><span class="n">${m.name}</span>`;
    b.title = m.shape;
    b.addEventListener('click', () => {
      select(m.id);
      document.body.classList.remove('menu-open');
    });
    items.append(b);
    buttons.set(m.id, b);
  });
  $('list').append(section);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function renderInfo(mol) {
  $('title').innerHTML = `${mol.formula} <span class="name">${mol.name}</span>`;
  $('desc').textContent = mol.desc;
  const pi = mol.bonds.reduce((s, b) => s + b.order - 1, 0);
  const lp = mol.orbitals.filter((o) => o.role === 'lp').length;
  $('facts').innerHTML = [
    `${mol.hybridization} · ${mol.shape} · ${mol.angle}`,
    `${plural(mol.bonds.length, 'σ bond')} · ${plural(pi, 'π bond')} · ${plural(lp, 'lone pair')}`,
  ].join('<br>');
}

// Role chips toggle each kind of orbital. Visibility persists across molecules.
// The small back lobes of the hybrids start hidden, as in textbook figures;
// with them on, the overlapping 90% surfaces are hard to read.
// NOTE: back lobes default ON for a more book-faithful teardrop silhouette.
const visibleRoles = { sigma: true, pi: true, lp: true, h1s: false };
let showSmall = true;
let colorBySign = false;

function applyVisibility() {
  if (!shownOrbitals) return;
  shownOrbitals.children.forEach((lobe) => {
    lobe.visible = visibleRoles[lobe.userData.role];
    lobe.children.forEach((m) => { m.visible = showSmall || !m.userData.small; });
  });
  $('chips').querySelectorAll('[data-role]').forEach((c) => c.classList.toggle('on', visibleRoles[c.dataset.role]));
}

function renderChips(mol) {
  const chips = $('chips');
  chips.innerHTML = '';
  const present = new Set(mol.orbitals.map((o) => o.role));
  for (const role of ROLE_ORDER) {
    if (!present.has(role)) continue;
    const c = document.createElement('button');
    c.className = 'chip';
    c.dataset.role = role;
    c.innerHTML = `<span class="swatch" style="background:${ROLES[role].color}"></span>${ROLES[role].chip}`;
    c.title = `Show or hide ${ROLES[role].label.toLowerCase()} orbitals`;
    c.addEventListener('click', () => {
      visibleRoles[role] = !visibleRoles[role];
      applyVisibility();
    });
    chips.append(c);
  }
  const small = document.createElement('button');
  small.className = `chip${showSmall ? ' on' : ''}`;
  small.textContent = 'back lobes';
  small.title = 'Show the small opposite-sign lobe behind each hybrid';
  small.addEventListener('click', () => {
    showSmall = !showSmall;
    small.classList.toggle('on', showSmall);
    applyVisibility();
  });
  chips.append(small);

  const sign = document.createElement('button');
  sign.className = `chip${colorBySign ? ' on' : ''}`;
  sign.textContent = 'color by sign';
  sign.title = 'Color lobes red (ψ > 0) and blue (ψ < 0) instead of by role';
  sign.addEventListener('click', () => {
    colorBySign = !colorBySign;
    sign.classList.toggle('on', colorBySign);
    if (shownOrbitals) paint(shownOrbitals, colorBySign);
    renderLegend();
  });
  chips.append(sign);
}

function renderLegend() {
  const mol = MOLECULES_BY_ID[current];
  const present = ROLE_ORDER.filter((r) => mol && mol.orbitals.some((o) => o.role === r));
  $('legend-colors').innerHTML = colorBySign
    ? '<div><span class="swatch" style="background: var(--plus)"></span>ψ &gt; 0</div>'
      + '<div><span class="swatch" style="background: var(--minus)"></span>ψ &lt; 0</div>'
    : present.map((r) => `<div><span class="swatch" style="background:${ROLES[r].color}"></span>${ROLES[r].label}</div>`).join('')
      + '<div><span class="swatch" style="background:#333"></span>Darker shade: ψ &lt; 0</div>';
}

let current = null;
let shownFramework = null;
let shownOrbitals = null;
let firstLoad = true;
let keepView = false; // set when only the contour level changes

async function select(id) {
  const mol = MOLECULES_BY_ID[id] || MOLECULES[0];
  const changed = current !== mol.id;
  current = mol.id;
  buttons.forEach((b, k) => b.classList.toggle('active', k === mol.id));
  if (location.hash.slice(1) !== mol.id) history.replaceState(null, '', `#${mol.id}`);
  renderInfo(mol);
  renderChips(mol);
  renderLegend();

  // The framework appears at once; the orbitals follow when meshed.
  if (changed || !shownFramework) {
    if (shownFramework) scene.remove(shownFramework);
    shownFramework = buildFramework(mol);
    scene.add(shownFramework);
    if (shownOrbitals) { scene.remove(shownOrbitals); shownOrbitals = null; }
  }

  const loading = setTimeout(() => $('loading').classList.add('show'), 120);
  const fraction = +$('fraction').value;
  const group = await buildOrbitals(mol, fraction);
  clearTimeout(loading);
  if (current !== mol.id || fraction !== +$('fraction').value) return; // user moved on
  $('loading').classList.remove('show');

  if (shownOrbitals) scene.remove(shownOrbitals);
  shownOrbitals = group;
  group.visible = $('orbitals').checked;
  paint(group, colorBySign);
  scene.add(group);
  applyVisibility();
  $('pct').textContent = `${Math.round(fraction * 100)}%`;
  document.body.dataset.shown = `${mol.id}@${fraction}`; // lets scripted checks wait for the mesh

  if (!keepView) frame(mol, !firstLoad);
  keepView = false;
  if (firstLoad) {
    firstLoad = false;
    prefetchAll(fraction);
  }
}

// Fit the camera to the molecule plus its σ lobes, so the view doesn't
// change size when orbitals are toggled.
function frame(mol, animate = true) {
  let R = Math.max(...mol.atoms.map((a) => Math.hypot(...a.pos) + ELEMENTS[a.el].radius));
  const v = new THREE.Vector3();
  shownOrbitals.updateMatrixWorld(true);
  shownOrbitals.children.forEach((lobe) => {
    if (lobe.userData.role === 'h1s') return;
    lobe.children.forEach((m) => {
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 7) {
        R = Math.max(R, v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).length());
      }
    });
  });
  setAxisLength(R);
  fitCamera(R, animate, mol.view || VIEW_DIR.toArray());
}

// Controls
$('opacity').addEventListener('input', (e) => setOpacity(+e.target.value));
$('spin').addEventListener('change', (e) => { controls.autoRotate = e.target.checked; });
// CSS2D labels ignore their parent's visibility, so hide them explicitly
function showAxes(on) {
  axes.visible = on;
  axisLabels.forEach((l) => { l.visible = on; });
}
showAxes(false);
$('axes').addEventListener('change', (e) => showAxes(e.target.checked));
$('orbitals').addEventListener('change', (e) => { if (shownOrbitals) shownOrbitals.visible = e.target.checked; });
$('fraction').addEventListener('change', () => {
  keepView = true;
  select(current);
});
$('menu').addEventListener('click', () => document.body.classList.toggle('menu-open'));
renderer.domElement.addEventListener('pointerdown', () => document.body.classList.remove('menu-open'));

// Arrow keys step through the list.
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT'].includes(e.target.tagName) || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const i = MOLECULES.findIndex((m) => m.id === current);
  const next = MOLECULES[(i + (e.key === 'ArrowDown' ? 1 : -1) + MOLECULES.length) % MOLECULES.length];
  select(next.id);
});
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id !== current && MOLECULES_BY_ID[id]) select(id);
});

renderer.setAnimationLoop((now) => {
  stepFit(now);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});

select(location.hash.slice(1) || 'c2h4');
