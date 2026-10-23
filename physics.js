// Physics world: Rapier + a regular triangle mesh built from the voxel grid.
//
// Units: physics runs in metres (a tile is 4 m). The renderer works in voxels, so use the
// helpers at the bottom to convert. Voxel row y = 1 is physics y = 0 (voxel row 0 is the floor
// slab itself, so the walkable surface sits exactly on its top face).
//
// The collision mesh is deliberately coarser than the render grid: voxels are grouped into
// cells of 0.25 m, a cell is solid when most of its voxels are, and flat faces are merged
// (greedy meshing). Single-voxel rubble and grass never snag the capsule.

import RAPIER from '@dimforge/rapier3d-compat';
import { T } from './world.js';

export const TILE_M = 4;                       // metres per tile edge
export const VOX = TILE_M / T;                 // metres per render voxel
export const CELL_VOX = Math.max(1, Math.round(T / 16));   // voxels per collision cell edge (4 at T = 64)
export const CELL = CELL_VOX * VOX;            // 0.25 m
export const FIXED_DT = 1 / 60;                // physics tick

const GRASS = 2;

// ---------------------------------------------------------------- solid cell grid
export function buildCellGrid(world) {
  const { data, size } = world;
  const sx = size.x, sy = size.y, sz = size.z;
  const nx = Math.ceil(sx / CELL_VOX);
  const nz = Math.ceil(sz / CELL_VOX);
  const ny = Math.ceil((sy - 1) / CELL_VOX);   // cell rows start at voxel y = 1
  const solid = new Uint8Array(nx * ny * nz);
  const need = (CELL_VOX ** 3) / 2;            // majority vote

  for (let cz = 0; cz < nz; cz++) for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
    let count = 0;
    for (let z = cz * CELL_VOX; z < cz * CELL_VOX + CELL_VOX; z++) {
      for (let y = 1 + cy * CELL_VOX; y < 1 + cy * CELL_VOX + CELL_VOX; y++) {
        for (let x = cx * CELL_VOX; x < cx * CELL_VOX + CELL_VOX; x++) {
          if (x >= sx || y >= sy || z >= sz) { count++; continue; }   // outside the world counts as stone
          const id = data[x + sx * (y + sy * z)];
          if (id !== 0 && id !== GRASS) count++;                      // grass above the floor is walk-through
        }
      }
    }
    if (count >= need) solid[cx + nx * (cy + ny * cz)] = 1;
  }
  return { solid, nx, ny, nz };
}

// ---------------------------------------------------------------- greedy mesher
// Emits one quad per merged rectangle of exposed cell faces. Everything outside the grid
// (and below it) is treated as solid, so the world boundary produces no faces.
export function greedyMesh({ solid, nx, ny, nz }) {
  const n = [nx, ny, nz];
  const at = (x, y, z) => {
    if (y < 0) return 1;                                   // ground slab below cell row 0
    if (x < 0 || z < 0 || x >= nx || z >= nz || y >= ny) return 1;
    return solid[x + nx * (y + ny * z)];
  };

  const verts = [];
  const idx = [];
  const x = [0, 0, 0], q = [0, 0, 0];

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, v = (d + 2) % 3;
    q[0] = q[1] = q[2] = 0; q[d] = 1;
    const mask = new Int8Array(n[u] * n[v]);

    for (x[d] = -1; x[d] < n[d]; ) {
      // 1. exposed faces between slice x[d] and x[d] + 1
      let c = 0;
      for (x[v] = 0; x[v] < n[v]; x[v]++) {
        for (x[u] = 0; x[u] < n[u]; x[u]++) {
          const a = at(x[0], x[1], x[2]);
          const b = at(x[0] + q[0], x[1] + q[1], x[2] + q[2]);
          mask[c++] = a === b ? 0 : (a ? 1 : -1);          // +1: normal +d, -1: normal -d
        }
      }
      x[d]++;                                              // x[d] is now the plane coordinate

      // 2. merge into rectangles
      c = 0;
      for (let j = 0; j < n[v]; j++) {
        for (let i = 0; i < n[u]; ) {
          const m = mask[c];
          if (!m) { i++; c++; continue; }

          let w = 1;
          while (i + w < n[u] && mask[c + w] === m) w++;
          let h = 1;
          outer: for (; j + h < n[v]; h++) {
            for (let k = 0; k < w; k++) if (mask[c + k + h * n[u]] !== m) break outer;
          }

          const base = verts.length / 3;
          const corner = (ci, cj) => {
            const p = [0, 0, 0];
            p[d] = x[d] * CELL; p[u] = ci * CELL; p[v] = cj * CELL;
            verts.push(p[0], p[1], p[2]);
          };
          corner(i, j); corner(i + w, j); corner(i + w, j + h); corner(i, j + h);
          if (m > 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
          else       idx.push(base, base + 2, base + 1, base, base + 3, base + 2);

          for (let l = 0; l < h; l++) for (let k = 0; k < w; k++) mask[c + k + l * n[u]] = 0;
          i += w; c += w;
        }
      }
    }
  }
  return { vertices: new Float32Array(verts), indices: new Uint32Array(idx) };
}

export function buildCollisionMesh(world) {
  const grid = buildCellGrid(world);
  const mesh = greedyMesh(grid);
  return { ...mesh, grid };
}

// ---------------------------------------------------------------- Rapier world
export async function createPhysics(world) {
  await RAPIER.init();
  const pw = new RAPIER.World({ x: 0, y: 0, z: 0 });       // gravity is applied by the player controller
  pw.timestep = FIXED_DT;

  const mesh = buildCollisionMesh(world);
  const body = pw.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const desc = RAPIER.ColliderDesc.trimesh(mesh.vertices, mesh.indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES);
  pw.createCollider(desc, body);
  pw.step();   // build the query pipeline

  return { RAPIER, world: pw, mesh, triangles: mesh.indices.length / 3 };
}

// ---------------------------------------------------------------- unit conversion
export const M2V = 1 / VOX;                      // metres -> voxels
export const mToVoxX = (m) => m * M2V;
export const mToVoxY = (m) => m * M2V + 1;       // voxel row 1 is physics y = 0
export const mToVoxZ = (m) => m * M2V;
