# Molecule Viewer: deploy unit

Static site, no build step. Three.js 0.160 loads from unpkg via an import map.

## Run locally

```bash
cd deploy
python3 -m http.server 8816
# open http://localhost:8816   (deep links: #ch4 #nh3 #h2o #c2h4 #c2h2 #co2)
```

It needs a server, not `file://`, because it uses ES modules and a module Web Worker.

## Test

```bash
cd deploy
node --test test_molecules.mjs     # about 1 s
```

Checks bond lengths and angles against experiment, orthonormality of every
atom's hybrids, that each σ hybrid actually peaks along its bond, lone-pair
placement, C₂H₄'s π lobes mirrored above and below the plane, CO₂'s and C₂H₂'s
orthogonal π systems, and that every lobe matches its rotated canonical mesh.

## Deploy

```bash
cd deploy
wrangler pages deploy . --project-name molecule-viewer
```

## Files

| File | Role |
|------|------|
| `orbitals.js` | Exact copy of the orbital viewer's physics: hydrogen-like ψ, hybrids, 90% isosurface meshing. No Three.js. |
| `molecules-lib.js` | Puts hybrids on real geometry: `hybridAlong`, Coulson s-fractions from bond angles, lone pairs by orthogonal completion, canonical lobe keys. No Three.js. |
| `molecules.js` | The six molecules: atoms, bonds, which atoms hybridize, lone pairs, leftover p orbitals. |
| `worker.js` | Meshes one canonical lobe off the main thread. |
| `main.js` | Scene, ball-and-stick framework, translucent lobes, compute queue, UI. |
| `index.html` | Layout, styles, import map. |
| `test_molecules.mjs` | `node --test` suite. |

## How the orbitals are placed

Every lobe is symmetric about its own axis, so each distinct shape (element,
s-fraction, contour level) is meshed once along +z and copied onto the atoms
with a rotation. A whole molecule costs 2 to 5 meshes, about 0.1 to 0.25 s each.

Hybrid s-character comes from the actual bond angles (Coulson's theorem), so
water's O–H hybrids are 20% s and its lone pairs 30% s, not a flat 25%.
Orbitals use Slater effective charges (C 3.25, N 3.90, O 4.55) and the
molecular hydrogen exponent 1.24.

## Adding a molecule

Add a `buildMolecule(meta, atoms, bonds, centers)` call to `molecules.js` and
append it to `MOLECULES`. Each center lists its σ neighbors, its lone pairs
(a count to derive them by orthogonality, or explicit directions), and any
leftover p orbitals as `pi: [{ dir, partner }]`. Then run the tests.
