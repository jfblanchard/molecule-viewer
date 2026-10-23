# Molecule Viewer: deploy unit

Static site, no build step. Three.js 0.160 loads from unpkg via an import map.

## Run locally

```bash
cd deploy
python3 -m http.server 8816
# open http://localhost:8816   (deep links: #ch4 #nh3 #h2o #c2h4 #c2h2 #co2)
```

It needs a server, not `file://`, because it uses ES modules.

## Test

The geometry/orbital math checks live with the orbital engine in
[`electron-orbital-viewer`](https://github.com/jfblanchard/electron-orbital-viewer)
(`tests/test_molecules.mjs`, `tests/test_orbitals.mjs`, `node --test`).

## Deploy

```bash
cd deploy
wrangler pages deploy . --project-name molecule-viewer
```

## Files

| File | Role |
|------|------|
| `molecules-lib.js` | Geometry helpers and the CPK element table; also computes each molecule's hybrid/lone-pair/pi directions, which feed the info card (and the orbital viewer's data). No Three.js. |
| `molecules.js` | The six molecules: atoms, bonds, hybridization, shape, lone pairs. |
| `vibrations.js` | Normal modes per molecule: displacement vectors, frequencies, amplitude, animation rate. |
| `main.js` | Scene, ball-and-stick framework, per-frame vibration animation, UI. |
| `index.html` | Layout, styles, import map. |

## Where did the orbitals go?

Orbital rendering moved to the
[Electron Orbital Viewer](https://orbital-viewer.pages.dev) — this viewer is
structures and vibrations only. The "See its orbitals →" link in the info card
deep-links to the same molecule there (`orbital-viewer.pages.dev/#h2o` etc.).

## Adding a molecule

Add a `buildMolecule(meta, atoms, bonds, centers)` call to `molecules.js` and
append it to `MOLECULES`. `centers` describes each heavy atom's σ neighbors,
lone pairs, and leftover p orbitals — the molecule viewer uses the geometry,
the orbital viewer uses the rest. Normal modes go in `vibrations.js`.
