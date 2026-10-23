/**
 * main.js — Three.js scene and UI for the molecule viewer.
 *
 * Ball-and-stick structures for the six curated molecules plus their
 * computed normal-mode vibrations. The molecular orbitals moved to the
 * electron orbital viewer (orbital-viewer.pages.dev); the info card links
 * straight to each molecule's orbital view.
 *
 * Sections
 *   1. Scene       renderer, camera, lights, axes
 *   2. Framework   atoms as CPK spheres, bonds as sticks
 *   3. UI          sidebar, info card, controls, selection
 *   4. Vibration   normal-mode picker and per-frame atom motion (vibrations.js)
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { MOLECULES, MOLECULES_BY_ID } from './molecules.js';
import { ELEMENTS } from './molecules-lib.js';
import { MODES, AMPLITUDE, displace, animRate } from './vibrations.js';

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
// Ball-and-stick, opaque. Balls start at CPK radii; the Atom size slider
// scales them.

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
  const atoms = mol.atoms.map((at) => {
    const m = new THREE.Mesh(sphereGeo, atomMats[at.el]);
    m.scale.setScalar(ELEMENTS[at.el].radius);
    m.userData.el = at.el;
    group.add(m);
    return m;
  });
  // Multiple bonds are drawn as parallel sticks spread along the π direction,
  // like the bent bonds of a model kit, so CO₂'s two C=O visibly turn 90°.
  const sticks = [];
  for (const b of mol.bonds) {
    const offsets = b.order === 1 ? [0] : b.order === 2 ? [-1, 1] : [0, 120, 240];
    for (const o of offsets) {
      const mesh = new THREE.Mesh(stickGeo, stickMat);
      group.add(mesh);
      sticks.push({ mesh, bond: b, o });
    }
  }
  group.userData = { atoms, sticks, eq: mol.atoms.map((a) => a.pos) };
  poseFramework(group, group.userData.eq);
  return group;
}

// Place atoms at positions P (Å) and run each stick between its two atoms.
// Called once at build and every frame while the molecule vibrates.
const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _axis = new THREE.Vector3(), _perp = new THREE.Vector3();
function poseFramework(group, P) {
  const { atoms, sticks } = group.userData;
  atoms.forEach((m, i) => m.position.set(...P[i]));
  for (const { mesh, bond: b, o } of sticks) {
    _p.set(...P[b.a]);
    _q.set(...P[b.b]);
    _axis.subVectors(_q, _p);
    const len = _axis.length();
    _axis.normalize();
    // keep the π direction square to the (possibly bent) bond
    if (b.perp) _perp.set(...b.perp); else _perp.set(1, 0, 0);
    _perp.addScaledVector(_axis, -_perp.dot(_axis)).normalize();
    const r = b.order === 1 ? 0.07 : 0.05;
    if (b.order === 1) _perp.set(0, 0, 0);
    else if (b.order === 3) _perp.applyAxisAngle(_axis, THREE.MathUtils.degToRad(o)).multiplyScalar(0.085);
    else _perp.multiplyScalar(0.075 * o);
    mesh.position.copy(_p).add(_q).multiplyScalar(0.5).add(_perp);
    mesh.quaternion.setFromUnitVectors(Y_AXIS, _axis);
    mesh.scale.set(r, len, r);
  }
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

// Legend: CPK colors for the elements in view.
function renderLegend() {
  const mol = MOLECULES_BY_ID[current];
  const els = [...new Set((mol ? mol.atoms : []).map((a) => a.el))];
  $('legend-colors').innerHTML = els
    .map((e) => `<div><span class="swatch" style="background:#${new THREE.Color(ELEMENTS[e].color).getHexString()}"></span>${e}</div>`)
    .join('');
}

let current = null;
let shownFramework = null;
let firstLoad = true;

function select(id) {
  const mol = MOLECULES_BY_ID[id] || MOLECULES[0];
  const changed = current !== mol.id;
  current = mol.id;
  buttons.forEach((b, k) => b.classList.toggle('active', k === mol.id));
  if (location.hash.slice(1) !== mol.id) history.replaceState(null, '', `#${mol.id}`);
  renderInfo(mol);
  renderLegend();
  $('orbitals-link').href = `https://orbital-viewer.pages.dev/#${mol.id}`;

  if (changed || !shownFramework) {
    stopVibration();
    renderModes(mol);
    if (shownFramework) scene.remove(shownFramework);
    shownFramework = buildFramework(mol);
    scene.add(shownFramework);
  }

  document.body.dataset.shown = mol.id; // lets scripted checks wait for the build
  frame(mol, !firstLoad);
  firstLoad = false;
}

// Fit the camera to the molecule's atoms, with a little margin.
function frame(mol, animate = true) {
  const R = Math.max(...mol.atoms.map((a) => Math.hypot(...a.pos) + ELEMENTS[a.el].radius)) * 1.15;
  setAxisLength(R);
  fitCamera(R, animate, mol.view || VIEW_DIR.toArray());
}

// Controls
$('spin').addEventListener('change', (e) => { controls.autoRotate = e.target.checked; });
// CSS2D labels ignore their parent's visibility, so hide them explicitly
function showAxes(on) {
  axes.visible = on;
  axisLabels.forEach((l) => { l.visible = on; });
}
showAxes(false);
$('axes').addEventListener('change', (e) => showAxes(e.target.checked));
$('atomsize').addEventListener('input', (e) => {
  const k = +e.target.value;
  if (shownFramework) {
    shownFramework.userData.atoms.forEach((m) => m.scale.setScalar(ELEMENTS[m.userData.el].radius * k));
  }
});
$('menu').addEventListener('click', () => document.body.classList.toggle('menu-open'));
renderer.domElement.addEventListener('pointerdown', () => document.body.classList.remove('menu-open'));

// Arrow keys step through the list; left/right step through the modes.
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT'].includes(e.target.tagName)) return;
  if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
    stepMode(e.key === 'ArrowRight' ? 1 : -1);
    return;
  }
  if (!['ArrowUp', 'ArrowDown'].includes(e.key)) return;
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
  stepVibration(now);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});

// ============================================================================
// 5. VIBRATION
// ============================================================================
//
// Every atom follows eq + A·disp·sin(φ), all at the mode's one frequency.
// φ advances by 2π·f·speed·dt, so the speed slider never makes the atoms jump.

const vib = { on: false, mode: 0, phase: 0, last: 0, positions: null };

function currentModes() {
  return MODES[current] || [];
}

// ν10 → ν₁₀
const sub = (t) => t.replace(/\d/g, (d) => '₀₁₂₃₄₅₆₇₈₉'[d]);
const modeName = (m) => `${sub(m.n)} ${m.label}${m.part ? ` (${m.part})` : ''}`;

function renderModes(mol) {
  const modes = MODES[mol.id] || [];
  $('vib').hidden = !modes.length;
  $('mode').innerHTML = modes
    .map((m, i) => `<option value="${i}">${modeName(m)} · ${m.nu} cm⁻¹</option>`)
    .join('');
  vib.mode = 0;
  renderMode();
}

function renderMode() {
  const m = currentModes()[vib.mode];
  if (!m) return;
  $('mode').value = String(vib.mode);
  $('mode-info').innerHTML = `<span class="nu">${m.nu} cm⁻¹</span> · ${m.sym} · ${m.desc}`;
}

function setPositions(P) {
  vib.positions = P;
  if (shownFramework) poseFramework(shownFramework, P);
}

/** Back to equilibrium, motion off. */
function stopVibration() {
  vib.on = false;
  vib.phase = 0;
  $('vibrate').checked = false;
  // the framework on screen may belong to the molecule we are leaving
  if (vib.positions && shownFramework) setPositions(shownFramework.userData.eq);
  vib.positions = null;
}

function startVibration() {
  if (!currentModes().length) return;
  vib.on = true;
  vib.phase = 0;
  vib.last = performance.now();
  $('vibrate').checked = true;
}

function setMode(i) {
  vib.mode = i;
  vib.phase = 0; // restart from equilibrium so the new mode starts cleanly
  renderMode();
}

function stepMode(dir) {
  const n = currentModes().length;
  if (!n) return;
  setMode((vib.mode + dir + n) % n);
  if (!vib.on) startVibration();
}

function stepVibration(now) {
  if (!vib.on) return;
  const m = currentModes()[vib.mode];
  const dt = Math.min(0.1, (now - vib.last) / 1000); // no leap after a hidden tab
  vib.last = now;
  vib.phase = (vib.phase + 2 * Math.PI * animRate(m.nu) * +$('speed').value * dt) % (2 * Math.PI);
  setPositions(displace(MOLECULES_BY_ID[current].atoms, m.disp, AMPLITUDE * Math.sin(vib.phase)));
}

$('vibrate').addEventListener('change', (e) => (e.target.checked ? startVibration() : stopVibration()));
$('mode').addEventListener('change', (e) => {
  setMode(+e.target.value);
  if (!vib.on) startVibration();
});

// Scripted checks (?shot) read the live atom positions.
if (location.search.includes('shot')) window.__vib = () => ({ ...vib, positions: vib.positions });

select(location.hash.slice(1) || 'c2h4');
