import * as THREE from 'three';
import type { Terrain } from '../world/terrain';

// World frame: x metres east, y metres up (absolute height), z metres south (so local y north = -z).

/** Height stops (metres) and colours for the stand-in tint: valley green, moor brown, tor grey. */
const STOPS: ReadonlyArray<readonly [number, number]> = [
  [100, 0x4a6a35],
  [250, 0x5f7a40],
  [380, 0x7a7a4c],
  [500, 0x80714f],
  [620, 0x8d8a82],
];

const stopColors = STOPS.map(([, hex]) => new THREE.Color(hex));
const tmp = new THREE.Color();

function tint(h: number, out: THREE.Color): THREE.Color {
  const first = STOPS[0] as readonly [number, number];
  if (h <= first[0]) return out.copy(stopColors[0] as THREE.Color);
  for (let k = 1; k < STOPS.length; k++) {
    const [h1] = STOPS[k] as readonly [number, number];
    if (h <= h1) {
      const [h0] = STOPS[k - 1] as readonly [number, number];
      return out.copy(stopColors[k - 1] as THREE.Color).lerp(stopColors[k] as THREE.Color, (h - h0) / (h1 - h0));
    }
  }
  return out.copy(stopColors[STOPS.length - 1] as THREE.Color);
}

/** One mesh over every height post, with height-tinted vertex colours. Stand-in until chunked LOD. */
export function buildTerrainMesh(terrain: Terrain): THREE.Mesh {
  const { postsX, postsY, cellM } = terrain.meta;
  const count = postsX * postsY;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let j = 0; j < postsY; j++) {
    for (let i = 0; i < postsX; i++) {
      const k = j * postsX + i;
      const h = (terrain.heightsDm[k] as number) / 10;
      positions[k * 3] = i * cellM;
      positions[k * 3 + 1] = h;
      positions[k * 3 + 2] = -j * cellM;
      tint(h, tmp);
      colors[k * 3] = tmp.r;
      colors[k * 3 + 1] = tmp.g;
      colors[k * 3 + 2] = tmp.b;
    }
  }
  const indices = new Uint32Array((postsX - 1) * (postsY - 1) * 6);
  let w = 0;
  for (let j = 0; j < postsY - 1; j++) {
    for (let i = 0; i < postsX - 1; i++) {
      const a = j * postsX + i;
      const b = a + 1;
      const c = a + postsX;
      const d = c + 1;
      // Counter-clockwise seen from above (+y).
      indices[w++] = a;
      indices[w++] = b;
      indices[w++] = c;
      indices[w++] = b;
      indices[w++] = d;
      indices[w++] = c;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.name = 'terrain';
  mesh.frustumCulled = false;
  return mesh;
}
