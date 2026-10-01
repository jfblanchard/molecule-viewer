// Meshes one canonical lobe (axis along +z) off the main thread.
// Request: { key, Z, terms, fraction, N }   Response: computeOrbital() result plus key, buffers transferred.
import { computeOrbital } from './orbitals.js';

self.onmessage = (e) => {
  const { key, Z, terms, fraction, N } = e.data;
  const res = computeOrbital({ id: key, set: [{ name: key, terms }] }, { N, fraction, Z });
  const transfer = res.surfaces.flatMap((s) => [s.positions.buffer, s.normals.buffer, s.indices.buffer]);
  self.postMessage({ key, ...res }, transfer);
};
