import * as THREE from 'three';
import { lakeLevelAt, type Lakes } from '../world/lakes';
import { WATER_FRESH, WATER_SALT } from '../world/palette';

// World frame: x metres east, y metres up (absolute height), z metres south (so local y north = -z).

/**
 * Flat water for every trapped lake at its level on gameDay: one quad per 50 m cell touching the lake's posts,
 * plus a one-cell margin. The ground hides the plane wherever it rises above the level, which draws the shore.
 * Fresh and salt lakes are separate meshes with their own material.
 */
export function buildLakeWater(lakes: Lakes, gameDay: number): THREE.Group {
  const { cellM, postsX, postsY } = lakes.meta;
  const nx = postsX - 1;
  const ny = postsY - 1;
  // Cells per lake id (cell index set).
  const cells = new Map<number, Set<number>>();
  for (let j = 0; j < postsY; j++) {
    for (let i = 0; i < postsX; i++) {
      const id = lakes.ids[j * postsX + i] as number;
      if (id === 0) continue;
      let set = cells.get(id);
      if (!set) {
        set = new Set();
        cells.set(id, set);
      }
      // Cells around the post, one cell further out for the margin.
      for (let cy = j - 2; cy <= j + 1; cy++) {
        for (let cx = i - 2; cx <= i + 1; cx++) {
          if (cx >= 0 && cy >= 0 && cx < nx && cy < ny) set.add(cy * nx + cx);
        }
      }
    }
  }

  const group = new THREE.Group();
  group.name = 'lakes';
  for (const salt of [false, true]) {
    const pos: number[] = [];
    for (const [id, set] of cells) {
      const lake = lakes.meta.lakes[id - 1];
      if (!lake || lake.salt !== salt) continue;
      const level = lakeLevelAt(lake, gameDay);
      for (const c of set) {
        const x0 = (c % nx) * cellM;
        const y0 = Math.floor(c / nx) * cellM;
        const x1 = x0 + cellM;
        const y1 = y0 + cellM;
        // Two triangles, counter-clockwise seen from above.
        pos.push(x0, level, -y0, x1, level, -y0, x0, level, -y1);
        pos.push(x1, level, -y0, x1, level, -y1, x0, level, -y1);
      }
    }
    if (pos.length === 0) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mat = new THREE.MeshPhongMaterial({
      color: salt ? WATER_SALT : WATER_FRESH,
      specular: salt ? 0x5a5f58 : 0x7a8a90,
      shininess: salt ? 40 : 90,
      transparent: true,
      opacity: salt ? 0.92 : 0.85,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = salt ? 'lakes-salt' : 'lakes-fresh';
    // Drawn after the terrain so the ground's depth trims the shore.
    mesh.renderOrder = 1;
    group.add(mesh);
  }
  return group;
}
