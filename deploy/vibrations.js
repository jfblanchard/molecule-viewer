/**
 * vibrations.js — textbook normal modes for each molecule in the viewer.
 *
 * Pure JavaScript, no Three.js, so the math runs under Node too.
 *
 * Wavenumbers are experimental gas-phase fundamentals from
 *   T. Shimanouchi, Tables of Molecular Vibrational Frequencies, Consolidated
 *   Vol. I, NSRDS-NBS 39 (1972), as served by the NIST Chemistry WebBook
 *   (SRD 69) and NIST CCCBDB. Mode numbering follows Herzberg.
 *
 * Mode shapes are not fitted to a force field. Each mode starts from its
 * symmetry coordinate (a fixed combination of bond stretches, angle bends or
 * out-of-plane pushes), turned into atom motion like this:
 *
 *   1. Wilson s-vectors: the direction each atom moves to change one
 *      internal coordinate (a bond length, a bond angle).
 *   2. Divide by mass. d = M⁻¹·s is the cheapest motion that makes the
 *      change; heavy atoms recoil less than hydrogens, the center of mass
 *      stays put and nothing rotates.
 *   3. Project out any remaining translation and rotation (Eckart conditions;
 *      a no-op for pure internal coordinates, needed for out-of-plane pushes).
 *   4. Orthogonalize, mass-weighted, from the highest wavenumber down: stretches
 *      keep their pure shape, bends in the same symmetry block give way to them.
 *
 * Where a symmetry block holds a single coordinate (H₂O ν3, CO₂ ν2 and ν3, the
 * CH₄ E bend, the C₂H₂ bends, the C₂H₄ out-of-plane modes) this is the exact
 * normal mode. Where a block holds two or three, real modes mix them a little
 * and these are the idealized textbook shapes.
 */
import { MOLECULES_BY_ID } from './molecules.js';
import { ELEMENTS, sub, scale, dot, cross, norm, unit } from './molecules-lib.js';

/** Largest atom excursion in Å. A real C–H stretch is ~0.07 Å rms; this is a little bolder so it reads. */
export const AMPLITUDE = 0.15;

// ============================================================================
// 1. INTERNAL COORDINATES → PATTERNS
// ============================================================================
//
// A pattern is one 3-vector per atom. Patterns add linearly, so a symmetry
// coordinate is a weighted sum of them.

const zeros = (n) => Array.from({ length: n }, () => [0, 0, 0]);

/** Wilson s-vector for stretching bond i–j. */
function stretch(P, i, j) {
  const e = unit(sub(P[j], P[i]));
  const s = zeros(P.length);
  s[i] = scale(e, -1);
  s[j] = e;
  return s;
}

/** Wilson s-vector for opening angle i–j–k (j at the vertex). */
function bend(P, i, j, k) {
  const r1 = norm(sub(P[i], P[j])), r2 = norm(sub(P[k], P[j]));
  const e1 = scale(sub(P[i], P[j]), 1 / r1);
  const e2 = scale(sub(P[k], P[j]), 1 / r2);
  const c = dot(e1, e2);
  const sn = Math.sqrt(1 - c * c);
  const s = zeros(P.length);
  s[i] = scale(sub(scale(e1, c), e2), 1 / (r1 * sn));
  s[k] = scale(sub(scale(e2, c), e1), 1 / (r2 * sn));
  s[j] = scale(add3(s[i], s[k]), -1);
  return s;
}

/** Push the listed atoms along given directions (out-of-plane and linear bends). */
function push(P, moves) {
  const s = zeros(P.length);
  for (const [i, v] of moves) s[i] = v;
  return s;
}

const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const combine = (terms) => terms
  .map(([c, s]) => s.map((v) => scale(v, c)))
  .reduce((acc, s) => acc.map((v, i) => add3(v, s[i])));

// ============================================================================
// 2. PATTERNS → MODES
// ============================================================================

const flat = (d) => d.flat();
const unflat = (f) => Array.from({ length: f.length / 3 }, (_, i) => f.slice(3 * i, 3 * i + 3));

/** Mass-weighted inner product Σ mᵢ aᵢ·bᵢ. */
export function massDot(masses, a, b) {
  return a.reduce((s, v, i) => s + masses[i] * dot(v, b[i]), 0);
}

// Translations and rotations as mass-weighted unit vectors (q = √m·d).
function rigidBasis(P, masses) {
  const raw = [];
  for (const e of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    raw.push(P.map((_, i) => scale(e, Math.sqrt(masses[i]))));
    raw.push(P.map((p, i) => scale(cross(e, p), Math.sqrt(masses[i]))));
  }
  const basis = [];
  for (const v of raw) {
    let f = flat(v);
    for (const b of basis) f = f.map((x, i) => x - dot1(f, b) * b[i]);
    const n = Math.hypot(...f);
    if (n > 1e-9) basis.push(f.map((x) => x / n)); // a linear molecule has no rotation about its axis
  }
  return basis;
}
const dot1 = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

/**
 * Turn symmetry coordinates into orthogonal Cartesian modes.
 * specs: [{ n, sym, nu, label, desc, part?, coord }] where coord is a pattern.
 */
function buildModes(mol, specs) {
  const P = mol.atoms.map((a) => a.pos);
  const masses = mol.atoms.map((a) => ELEMENTS[a.el].mass);
  const sq = masses.flatMap((m) => [Math.sqrt(m), Math.sqrt(m), Math.sqrt(m)]);
  const rigid = rigidBasis(P, masses);

  // mass-weighted vectors q = √m · (s / m)
  const qs = specs.map((sp) => {
    let q = flat(sp.coord).map((x, i) => x / sq[i]);
    for (const b of rigid) q = q.map((x, i) => x - dot1(q, b) * b[i]);
    return q;
  });

  // Gram–Schmidt from the highest wavenumber down; ties keep listed order
  const order = specs.map((_, i) => i).sort((a, b) => specs[b].nu - specs[a].nu || a - b);
  const done = [];
  const out = new Array(specs.length);
  for (const i of order) {
    let q = qs[i];
    for (const b of done) q = q.map((x, k) => x - dot1(q, b) * b[k]);
    const n = Math.hypot(...q);
    if (n < 1e-6) throw new Error(`${mol.id} ${specs[i].n}: mode collapsed`);
    q = q.map((x) => x / n);
    done.push(q);
    // back to Cartesian, largest atom excursion = 1
    const d = unflat(q.map((x, k) => x / sq[k]));
    const big = Math.max(...d.map(norm));
    const { coord, ...meta } = specs[i];
    out[i] = { ...meta, disp: d.map((v) => scale(v, 1 / big)) };
  }
  return out;
}

const mode = (n, sym, nu, label, desc, coord, part) => ({ n, sym, nu, label, desc, coord, ...(part && { part }) });

// ============================================================================
// 3. MOLECULES
// ============================================================================
//
// Atom indices follow molecules.js.

const SPECS = {
  // O0, H1, H2. C2v.
  h2o(P) {
    const r = (j) => stretch(P, 0, j);
    return [
      mode('ν1', 'a₁', 3657, 'Symmetric stretch', 'Both O–H bonds stretch and shrink together.',
        combine([[1, r(1)], [1, r(2)]])),
      mode('ν2', 'a₁', 1595, 'Bend (scissor)', 'The H–O–H angle opens and closes; the hydrogens swing like scissors.',
        bend(P, 1, 0, 2)),
      mode('ν3', 'b₂', 3756, 'Antisymmetric stretch', 'One O–H bond stretches while the other shrinks.',
        combine([[1, r(1)], [-1, r(2)]])),
    ];
  },

  // N0, H1–H3. C3v. ν2 observed as an inversion doublet 932/968; 950 is the mean.
  nh3(P) {
    const r = (j) => stretch(P, 0, j);
    const a = (i, k) => bend(P, i, 0, k);
    return [
      mode('ν1', 'a₁', 3337, 'Symmetric stretch', 'All three N–H bonds stretch and shrink together.',
        combine([[1, r(1)], [1, r(2)], [1, r(3)]])),
      mode('ν2', 'a₁', 950, 'Umbrella', 'The hydrogens flap together like an umbrella opening and closing; nitrogen bobs along the axis.',
        combine([[1, a(1, 2)], [1, a(1, 3)], [1, a(2, 3)]])),
      mode('ν3', 'e', 3444, 'Antisymmetric stretch', 'One N–H bond stretches while the other two shrink.',
        combine([[2, r(1)], [-1, r(2)], [-1, r(3)]]), '1 of 2'),
      mode('ν3', 'e', 3444, 'Antisymmetric stretch', 'One N–H bond stretches as another shrinks; the third is still.',
        combine([[1, r(2)], [-1, r(3)]]), '2 of 2'),
      mode('ν4', 'e', 1627, 'Antisymmetric bend', 'One H–N–H angle opens while the other two close.',
        combine([[2, a(2, 3)], [-1, a(1, 3)], [-1, a(1, 2)]]), '1 of 2'),
      mode('ν4', 'e', 1627, 'Antisymmetric bend', 'One H–N–H angle opens as another closes.',
        combine([[1, a(1, 3)], [-1, a(1, 2)]]), '2 of 2'),
    ];
  },

  // C0, H1–H4. Td.
  ch4(P) {
    const r = (j) => stretch(P, 0, j);
    const a = (i, k) => bend(P, i, 0, k);
    const rs = (c) => combine(c.map((x, i) => [x, r(i + 1)]));
    const T2 = (i, k, j, l) => combine([[1, a(i, k)], [-1, a(j, l)]]);
    return [
      mode('ν1', 'a₁', 2917, 'Symmetric stretch', 'All four C–H bonds stretch and shrink together; carbon stays still.',
        rs([1, 1, 1, 1])),
      mode('ν2', 'e', 1534, 'Symmetric bend', 'Opposite pairs of H–C–H angles open and close in turn; carbon stays still.',
        combine([[2, a(1, 2)], [-1, a(1, 3)], [-1, a(1, 4)], [-1, a(2, 3)], [-1, a(2, 4)], [2, a(3, 4)]]), '1 of 2'),
      mode('ν2', 'e', 1534, 'Symmetric bend', 'Opposite pairs of H–C–H angles open and close in turn; carbon stays still.',
        combine([[1, a(1, 3)], [-1, a(1, 4)], [-1, a(2, 3)], [1, a(2, 4)]]), '2 of 2'),
      mode('ν3', 't₂', 3019, 'Antisymmetric stretch', 'Two C–H bonds stretch while the other two shrink; carbon shuttles between them.',
        rs([1, 1, -1, -1]), '1 of 3'),
      mode('ν3', 't₂', 3019, 'Antisymmetric stretch', 'Two C–H bonds stretch while the other two shrink; carbon shuttles between them.',
        rs([1, -1, 1, -1]), '2 of 3'),
      mode('ν3', 't₂', 3019, 'Antisymmetric stretch', 'Two C–H bonds stretch while the other two shrink; carbon shuttles between them.',
        rs([1, -1, -1, 1]), '3 of 3'),
      mode('ν4', 't₂', 1306, 'Antisymmetric bend', 'One H–C–H angle opens as the opposite one closes; carbon rocks between them.',
        T2(1, 2, 3, 4), '1 of 3'),
      mode('ν4', 't₂', 1306, 'Antisymmetric bend', 'One H–C–H angle opens as the opposite one closes; carbon rocks between them.',
        T2(1, 3, 2, 4), '2 of 3'),
      mode('ν4', 't₂', 1306, 'Antisymmetric bend', 'One H–C–H angle opens as the opposite one closes; carbon rocks between them.',
        T2(1, 4, 2, 3), '3 of 3'),
    ];
  },

  // C0 (+y), C1 (−y); H2 (+x) and H3 (−x) on C0, H4 (+x) and H5 (−x) on C1.
  // Flat in xy. D2h; symmetry labels as in Shimanouchi.
  c2h4(P) {
    const r = (c) => combine([[c[0], stretch(P, 0, 2)], [c[1], stretch(P, 0, 3)], [c[2], stretch(P, 1, 4)], [c[3], stretch(P, 1, 5)]]);
    const b = (c) => combine([[c[0], bend(P, 1, 0, 2)], [c[1], bend(P, 1, 0, 3)], [c[2], bend(P, 0, 1, 4)], [c[3], bend(P, 0, 1, 5)]]);
    const z = (c) => push(P, c.map((s, i) => [i + 2, [0, 0, s]]));
    return [
      mode('ν1', 'ag', 3026, 'CH₂ symmetric stretch', 'All four C–H bonds stretch and shrink together.', r([1, 1, 1, 1])),
      mode('ν2', 'ag', 1623, 'C=C stretch', 'The carbons move apart and together; the CH₂ groups ride along.',
        stretch(P, 0, 1)),
      mode('ν3', 'ag', 1342, 'CH₂ scissor', 'Both H–C–H angles open and close together.', b([1, 1, 1, 1])),
      mode('ν4', 'au', 1023, 'CH₂ twist', 'The two CH₂ ends turn in opposite senses about the C=C axis.', z([1, -1, -1, 1])),
      mode('ν5', 'b1g', 3103, 'CH₂ antisymmetric stretch', 'In each CH₂ one C–H stretches as the other shrinks, mirrored across the molecule.',
        r([1, -1, -1, 1])),
      mode('ν6', 'b1g', 1236, 'CH₂ rock', 'Both CH₂ groups swivel in the plane in the same sense.', b([1, -1, -1, 1])),
      mode('ν7', 'b1u', 949, 'CH₂ wag', 'All four hydrogens flap up and down together; the carbons answer the other way.',
        z([1, 1, 1, 1])),
      mode('ν8', 'b2g', 943, 'CH₂ wag', 'One CH₂ flaps up while the other flaps down.', z([1, 1, -1, -1])),
      mode('ν9', 'b2u', 3106, 'CH₂ antisymmetric stretch', 'In each CH₂ one C–H stretches as the other shrinks, in step across the molecule.',
        r([1, -1, 1, -1])),
      mode('ν10', 'b2u', 826, 'CH₂ rock', 'The two CH₂ groups swivel in the plane in opposite senses.', b([1, -1, 1, -1])),
      mode('ν11', 'b3u', 2989, 'CH₂ symmetric stretch', 'One CH₂ stretches both C–H bonds while the other shrinks them.',
        r([1, 1, -1, -1])),
      mode('ν12', 'b3u', 1444, 'CH₂ scissor', 'One CH₂ opens its H–C–H angle while the other closes it.', b([1, 1, -1, -1])),
    ];
  },

  // C0 (+y), C1 (−y), H2 (+y end), H3 (−y end). D∞h.
  c2h2(P) {
    const trans = (e) => push(P, [[2, e], [3, scale(e, -1)]]);
    const cis = (e) => push(P, [[2, e], [3, e]]);
    return [
      mode('ν1', 'σg⁺', 3374, 'Symmetric C–H stretch', 'Both C–H bonds stretch and shrink together.',
        combine([[1, stretch(P, 0, 2)], [1, stretch(P, 1, 3)]])),
      mode('ν2', 'σg⁺', 1974, 'C≡C stretch', 'The carbons move apart and together; the hydrogens ride along.', stretch(P, 0, 1)),
      mode('ν3', 'σu⁺', 3289, 'Antisymmetric C–H stretch', 'One C–H bond stretches while the other shrinks.',
        combine([[1, stretch(P, 0, 2)], [-1, stretch(P, 1, 3)]])),
      mode('ν4', 'πg', 612, 'Trans bend', 'The hydrogens swing to opposite sides, a zigzag.', trans([0, 0, 1]), '1 of 2'),
      mode('ν4', 'πg', 612, 'Trans bend', 'The hydrogens swing to opposite sides, a zigzag.', trans([1, 0, 0]), '2 of 2'),
      mode('ν5', 'πu', 730, 'Cis bend', 'Both hydrogens swing to the same side; the carbons answer the other way.', cis([0, 0, 1]), '1 of 2'),
      mode('ν5', 'πu', 730, 'Cis bend', 'Both hydrogens swing to the same side; the carbons answer the other way.', cis([1, 0, 0]), '2 of 2'),
    ];
  },

  // C0, O1 (−y), O2 (+y). D∞h. ν1 is Raman-only and Fermi-mixed with 2ν2:
  // observed as the 1285/1388 doublet; 1333 is the unperturbed value.
  co2(P) {
    const bendDir = (e) => push(P, [[1, e], [2, e]]);
    return [
      mode('ν1', 'σg⁺', 1333, 'Symmetric stretch', 'Both oxygens move out and in together; carbon stays still. IR-silent.',
        combine([[1, stretch(P, 0, 1)], [1, stretch(P, 0, 2)]])),
      mode('ν2', 'πu', 667, 'Bend', 'The oxygens swing to one side as carbon swings to the other.', bendDir([0, 0, 1]), '1 of 2'),
      mode('ν2', 'πu', 667, 'Bend', 'The oxygens swing to one side as carbon swings to the other.', bendDir([1, 0, 0]), '2 of 2'),
      mode('ν3', 'σu⁺', 2349, 'Antisymmetric stretch', 'Carbon shuttles between the oxygens: one C=O stretches as the other shrinks.',
        combine([[1, stretch(P, 0, 1)], [-1, stretch(P, 0, 2)]])),
    ];
  },
};

export const MODES = Object.fromEntries(Object.entries(SPECS).map(([id, f]) => {
  const mol = MOLECULES_BY_ID[id];
  return [id, buildModes(mol, f(mol.atoms.map((a) => a.pos)))];
}));

// ============================================================================
// 4. ANIMATION
// ============================================================================

/** Atom positions at excursion s (Å) along a mode: eq + s·disp. */
export function displace(atoms, disp, s) {
  return atoms.map((a, i) => [a.pos[0] + s * disp[i][0], a.pos[1] + s * disp[i][1], a.pos[2] + s * disp[i][2]]);
}

/**
 * On-screen frequency in Hz. Real modes run at 10¹³–10¹⁴ Hz; this keeps their
 * order (a 3000 cm⁻¹ stretch visibly outpaces a 600 cm⁻¹ bend) but compresses
 * the range to something watchable: 600 cm⁻¹ → 0.5 Hz, 3800 cm⁻¹ → 1.5 Hz.
 */
export const animRate = (nu) => 0.5 * (nu / 600) ** 0.6;
