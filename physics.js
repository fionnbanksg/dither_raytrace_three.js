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
const LEAF = 9;   // tree / bush foliage is walk-through too (trunks and boulders still collide)
const LAVA = 8;   // lava voxels are walk-through for now (damage/wading would hook in here)

// ---------------------------------------------------------------- solid cell grid
function cellIsSolid(world, cx, cy, cz) {
  const { data, size } = world;
  const sx = size.x, sy = size.y, sz = size.z;
  const need = (CELL_VOX ** 3) / 2;            // majority vote
  let count = 0;
  for (let z = cz * CELL_VOX; z < cz * CELL_VOX + CELL_VOX; z++) {
    for (let y = 1 + cy * CELL_VOX; y < 1 + cy * CELL_VOX + CELL_VOX; y++) {
      for (let x = cx * CELL_VOX; x < cx * CELL_VOX + CELL_VOX; x++) {
        if (x >= sx || y >= sy || z >= sz) { count++; continue; }   // outside the world counts as stone
        const id = data[x + sx * (y + sy * z)];
        if (id !== 0 && id !== GRASS && id !== LAVA && id !== LEAF) count++;                      // grass above the floor is walk-through
      }
    }
  }
  return count >= need ? 1 : 0;
}

export function buildCellGrid(world) {
  const { size } = world;
  const nx = Math.ceil(size.x / CELL_VOX);
  const nz = Math.ceil(size.z / CELL_VOX);
  const ny = Math.ceil((size.y - 1) / CELL_VOX);   // cell rows start at voxel y = 1
  const solid = new Uint8Array(nx * ny * nz);
  for (let cz = 0; cz < nz; cz++) for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
    solid[cx + nx * (cy + ny * cz)] = cellIsSolid(world, cx, cy, cz);
  }
  return { solid, nx, ny, nz };
}

// Re-vote every cell that overlaps a voxel box ({x0,y0,z0,x1,y1,z1}, end-exclusive).
// Returns the box of cells that actually flipped (or null) so only those chunks get re-meshed.
export function refreshCells(world, grid, box) {
  const { solid, nx, ny, nz } = grid;
  const c0x = Math.max(0, Math.floor(box.x0 / CELL_VOX)), c1x = Math.min(nx - 1, Math.floor((box.x1 - 1) / CELL_VOX));
  const c0y = Math.max(0, Math.floor((box.y0 - 1) / CELL_VOX)), c1y = Math.min(ny - 1, Math.floor((box.y1 - 2) / CELL_VOX));
  const c0z = Math.max(0, Math.floor(box.z0 / CELL_VOX)), c1z = Math.min(nz - 1, Math.floor((box.z1 - 1) / CELL_VOX));
  let changed = null;
  for (let cz = c0z; cz <= c1z; cz++) for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) {
    const i = cx + nx * (cy + ny * cz);
    const s = cellIsSolid(world, cx, cy, cz);
    if (s === solid[i]) continue;
    solid[i] = s;
    if (!changed) changed = { x0: cx, y0: cy, z0: cz, x1: cx, y1: cy, z1: cz };
    else {
      changed.x0 = Math.min(changed.x0, cx); changed.x1 = Math.max(changed.x1, cx);
      changed.y0 = Math.min(changed.y0, cy); changed.y1 = Math.max(changed.y1, cy);
      changed.z0 = Math.min(changed.z0, cz); changed.z1 = Math.max(changed.z1, cz);
    }
  }
  return changed;
}

// ---------------------------------------------------------------- greedy mesher
// Emits one quad per merged rectangle of exposed cell faces. Everything outside the grid
// (and below it) is treated as solid, so the world boundary produces no faces.
//
// `region` ({lo:[x,y,z], hi:[x,y,z]}, in cells, end-exclusive) meshes just one chunk. A face is
// owned by the chunk that contains its *solid* cell, so neighbouring chunks never duplicate
// faces and together they cover exactly the same surface as one whole-grid mesh.
export function greedyMesh({ solid, nx, ny, nz }, region) {
  const n = [nx, ny, nz];
  const lo = region ? region.lo : [0, 0, 0];
  const hi = region ? region.hi : [nx, ny, nz];
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
    const nu = hi[u] - lo[u], nv = hi[v] - lo[v];
    q[0] = q[1] = q[2] = 0; q[d] = 1;
    const mask = new Int8Array(nu * nv);

    for (x[d] = lo[d] - 1; x[d] < hi[d]; ) {
      // 1. exposed faces between slice x[d] and x[d] + 1 (only those owned by this region)
      let c = 0;
      for (x[v] = lo[v]; x[v] < hi[v]; x[v]++) {
        for (x[u] = lo[u]; x[u] < hi[u]; x[u]++) {
          const a = at(x[0], x[1], x[2]);
          const b = at(x[0] + q[0], x[1] + q[1], x[2] + q[2]);
          let m = a === b ? 0 : (a ? 1 : -1);              // +1: normal +d, -1: normal -d
          if (m !== 0) {
            // owner = the solid cell, unless that cell is the virtual solid outside the grid,
            // in which case the air cell next to it owns the face (floor, ceiling, world edge)
            const owner = m > 0 ? (x[d] < 0 ? 0 : x[d])
                                : (x[d] + 1 >= n[d] ? x[d] : x[d] + 1);
            if (owner < lo[d] || owner >= hi[d]) m = 0;
          }
          mask[c++] = m;
        }
      }
      x[d]++;                                              // x[d] is now the plane coordinate

      // 2. merge into rectangles
      c = 0;
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; ) {
          const m = mask[c];
          if (!m) { i++; c++; continue; }

          let w = 1;
          while (i + w < nu && mask[c + w] === m) w++;
          let h = 1;
          outer: for (; j + h < nv; h++) {
            for (let k = 0; k < w; k++) if (mask[c + k + h * nu] !== m) break outer;
          }

          const base = verts.length / 3;
          const corner = (ci, cj) => {
            const p = [0, 0, 0];
            p[d] = x[d] * CELL; p[u] = (lo[u] + ci) * CELL; p[v] = (lo[v] + cj) * CELL;
            verts.push(p[0], p[1], p[2]);
          };
          corner(i, j); corner(i + w, j); corner(i + w, j + h); corner(i, j + h);
          if (m > 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
          else       idx.push(base, base + 2, base + 1, base, base + 3, base + 2);

          for (let l = 0; l < h; l++) for (let k = 0; k < w; k++) mask[c + k + l * nu] = 0;
          i += w; c += w;
        }
      }
    }
  }
  return { vertices: new Float32Array(verts), indices: new Uint32Array(idx) };
}

// ---------------------------------------------------------------- smooth slope ramps
// Block collision turns a hillside into a staircase of 0.25 m steps that the capsule keeps catching on. So wherever
// the topmost surface is a walkable slope (or flat ground), the blocks above the surface are shaved off the collision
// grid and a smooth triangle surface, following the real voxel heights, takes their place. Cliffs, boulder sides,
// tree trunks and pit walls are steeper than MAX_SLOPE across a quad and keep their plain blocks. Cave floors and
// ceilings are never the topmost surface, so the tunnels are untouched.
const MAX_SLOPE = 1.3;                         // max rise per cell of run for a ramp quad (~50 degrees)
const SAMPLE_OFFS = [-2, 1];                   // corner height = average of the 4 voxel columns around it

// voxel row of the top face of the highest walkable surface in a voxel column (grass counts as a 2-voxel skin;
// tufts, leaves and lava are ignored, like in cellIsSolid)
function surfaceRow(world, x, z) {
  const { data, size } = world;
  const sx = size.x, sy = size.y;
  x = Math.max(0, Math.min(sx - 1, x)); z = Math.max(0, Math.min(size.z - 1, z));
  let y = sy - 1, id = 0;
  for (; y >= 1; y--) { id = data[x + sx * (y + sy * z)]; if (id !== 0 && id !== LAVA && id !== LEAF) break; }
  if (y < 1) return 0;
  if (id === GRASS) {
    let run = 0;
    while (y >= 1 && data[x + sx * (y + sy * z)] === GRASS) { y--; run++; }
    return Math.max(0, y) + Math.min(run, 2);
  }
  return y;
}

export function initRamps(world, grid) {
  grid.corner = new Float32Array((grid.nx + 1) * (grid.nz + 1));   // metres
  grid.elig = new Uint8Array(grid.nx * grid.nz);
  grid.mesh = Uint8Array.from(grid.solid);                          // solid grid with the ramp columns shaved
  refreshRamps(world, grid, 0, grid.nx - 1, 0, grid.nz - 1);
}

// Recompute corners / eligibility / shaved cells for columns c0x..c1x, c0z..c1z (inclusive). True if anything changed.
export function refreshRamps(world, grid, c0x, c1x, c0z, c1z) {
  const { nx, ny, nz, solid, mesh, corner, elig } = grid;
  c0x = Math.max(0, c0x); c0z = Math.max(0, c0z); c1x = Math.min(nx - 1, c1x); c1z = Math.min(nz - 1, c1z);
  const cw = nx + 1;
  let changed = false;
  for (let cz = c0z; cz <= c1z + 1; cz++) for (let cx = c0x; cx <= c1x + 1; cx++) {
    let sum = 0;
    for (const oz of SAMPLE_OFFS) for (const ox of SAMPLE_OFFS) sum += surfaceRow(world, cx * CELL_VOX + ox, cz * CELL_VOX + oz);
    const h = (sum / 4) * VOX;
    if (Math.abs(corner[cx + cw * cz] - h) > 1e-6) { corner[cx + cw * cz] = h; changed = true; }
  }
  for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
    const a = corner[cx + cw * cz], b = corner[cx + 1 + cw * cz], c = corner[cx + cw * (cz + 1)], d = corner[cx + 1 + cw * (cz + 1)];
    const mn = Math.min(a, b, c, d), mx = Math.max(a, b, c, d);
    const ok = mx > 0 && mx - mn <= MAX_SLOPE * CELL ? 1 : 0;
    if (elig[cx + nx * cz] !== ok) { elig[cx + nx * cz] = ok; changed = true; }
    for (let cy = 0; cy < ny; cy++) {
      const i = cx + nx * (cy + ny * cz);
      const v = ok && (cy + 1) * CELL > mn + 1e-6 ? 0 : solid[i];     // drop cells that poke above the ramp
      if (mesh[i] !== v) { mesh[i] = v; changed = true; }
    }
  }
  return changed;
}

// Smooth surface for the columns of a chunk (flat runs along x are merged into one quad).
export function rampMesh(grid, region) {
  const { nx, nz, corner, elig } = grid;
  const x0 = region ? region.lo[0] : 0, x1 = region ? region.hi[0] : nx;
  const z0 = region ? region.lo[2] : 0, z1 = region ? region.hi[2] : nz;
  const cw = nx + 1, verts = [], idx = [];
  const quad = (xa, xb, za, zb, ha, hb, hc, hd) => {
    const base = verts.length / 3;
    verts.push(xa * CELL, ha, za * CELL, xb * CELL, hb, za * CELL, xa * CELL, hc, zb * CELL, xb * CELL, hd, zb * CELL);
    if (Math.abs(ha - hd) <= Math.abs(hb - hc)) idx.push(base, base + 2, base + 3, base, base + 3, base + 1);
    else idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  };
  for (let cz = z0; cz < z1; cz++) {
    for (let cx = x0; cx < x1; cx++) {
      if (!elig[cx + nx * cz]) continue;
      const a = corner[cx + cw * cz], b = corner[cx + 1 + cw * cz], c = corner[cx + cw * (cz + 1)], d = corner[cx + 1 + cw * (cz + 1)];
      if (a === b && a === c && a === d) {                       // flat: extend the run
        let e = cx + 1;
        while (e < x1 && elig[e + nx * cz] && corner[e + 1 + cw * cz] === a && corner[e + 1 + cw * (cz + 1)] === a && corner[e + cw * cz] === a && corner[e + cw * (cz + 1)] === a) e++;
        quad(cx, e, cz, cz + 1, a, a, a, a);
        cx = e - 1;
      } else quad(cx, cx + 1, cz, cz + 1, a, b, c, d);
    }
  }
  return { vertices: new Float32Array(verts), indices: new Uint32Array(idx) };
}

function joinMeshes(a, b) {
  if (!b.indices.length) return a;
  if (!a.indices.length) return b;
  const off = a.vertices.length / 3;
  const vertices = new Float32Array(a.vertices.length + b.vertices.length);
  vertices.set(a.vertices); vertices.set(b.vertices, a.vertices.length);
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices);
  for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i] + off;
  return { vertices, indices };
}

const meshGrid = (grid) => ({ solid: grid.mesh, nx: grid.nx, ny: grid.ny, nz: grid.nz });

export function buildCollisionMesh(world) {
  const grid = buildCellGrid(world);
  initRamps(world, grid);
  const mesh = joinMeshes(greedyMesh(meshGrid(grid)), rampMesh(grid));
  return { ...mesh, grid };
}

// ---------------------------------------------------------------- Rapier world
// The collision mesh is split into one trimesh collider per chunk (CHUNK_CELLS^2 cells in x/z,
// full height). A destructible world only has to re-mesh and re-create the few chunks an
// explosion touches (a few ms) instead of the whole level (~700 ms).
export const CHUNK_CELLS = Math.max(1, Math.round(T / CELL_VOX));   // one tile per chunk

export async function createPhysics(world) {
  await RAPIER.init();
  const pw = new RAPIER.World({ x: 0, y: 0, z: 0 });       // gravity is applied by the player controller
  pw.timestep = FIXED_DT;

  const grid = buildCellGrid(world);
  initRamps(world, grid);
  const body = pw.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const chunksX = Math.ceil(grid.nx / CHUNK_CELLS), chunksZ = Math.ceil(grid.nz / CHUNK_CELLS);
  const chunks = new Map();                                 // key -> { collider, tris }

  const physics = { RAPIER, world: pw, grid, triangles: 0 };

  function rebuildChunk(kx, kz) {
    const key = kx + chunksX * kz;
    const old = chunks.get(key);
    if (old) { pw.removeCollider(old.collider, false); physics.triangles -= old.tris; chunks.delete(key); }
    const region = {
      lo: [kx * CHUNK_CELLS, 0, kz * CHUNK_CELLS],
      hi: [Math.min(grid.nx, (kx + 1) * CHUNK_CELLS), grid.ny, Math.min(grid.nz, (kz + 1) * CHUNK_CELLS)],
    };
    const mesh = joinMeshes(greedyMesh(meshGrid(grid), region), rampMesh(grid, region));
    if (mesh.indices.length === 0) return;
    const desc = RAPIER.ColliderDesc.trimesh(mesh.vertices, mesh.indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES);
    const tris = mesh.indices.length / 3;
    chunks.set(key, { collider: pw.createCollider(desc, body), tris });
    physics.triangles += tris;
  }

  for (let kz = 0; kz < chunksZ; kz++) for (let kx = 0; kx < chunksX; kx++) rebuildChunk(kx, kz);

  // Call after editing world.data inside a voxel box ({x0,y0,z0,x1,y1,z1}, end-exclusive).
  // Re-votes the affected cells and rebuilds only the chunks whose surface changed.
  physics.updateRegion = (box) => {
    const ch = refreshCells(world, grid, box);
    // ramp heights look at the surface around the box, so refresh two cells further out
    const rx0 = Math.floor(box.x0 / CELL_VOX) - 2, rx1 = Math.floor((box.x1 - 1) / CELL_VOX) + 2;
    const rz0 = Math.floor(box.z0 / CELL_VOX) - 2, rz1 = Math.floor((box.z1 - 1) / CELL_VOX) + 2;
    const rampChanged = refreshRamps(world, grid, rx0, rx1, rz0, rz1);
    if (!ch && !rampChanged) return 0;
    // a flipped cell also exposes/hides faces owned by its neighbours, so grow by one cell
    const g = ch ? { x0: Math.min(ch.x0, rx0 + 1), x1: Math.max(ch.x1, rx1 - 1), z0: Math.min(ch.z0, rz0 + 1), z1: Math.max(ch.z1, rz1 - 1) } : { x0: rx0, x1: rx1, z0: rz0, z1: rz1 };
    const kx0 = Math.max(0, Math.floor((g.x0 - 1) / CHUNK_CELLS)), kx1 = Math.min(chunksX - 1, Math.floor((g.x1 + 1) / CHUNK_CELLS));
    const kz0 = Math.max(0, Math.floor((g.z0 - 1) / CHUNK_CELLS)), kz1 = Math.min(chunksZ - 1, Math.floor((g.z1 + 1) / CHUNK_CELLS));
    let n = 0;
    for (let kz = kz0; kz <= kz1; kz++) for (let kx = kx0; kx <= kx1; kx++) { rebuildChunk(kx, kz); n++; }
    pw.step();   // refresh the query pipeline so the character controller sees the new colliders
    return n;
  };

  pw.step();   // build the query pipeline
  return physics;
}

// ---------------------------------------------------------------- unit conversion
export const M2V = 1 / VOX;                      // metres -> voxels
export const mToVoxX = (m) => m * M2V;
export const mToVoxY = (m) => m * M2V + 1;       // voxel row 1 is physics y = 0
export const mToVoxZ = (m) => m * M2V;
export const voxToMX = (v) => v * VOX;
export const voxToMY = (v) => (v - 1) * VOX;
export const voxToMZ = (v) => v * VOX;