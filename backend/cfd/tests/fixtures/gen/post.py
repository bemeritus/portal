"""Post-process the converged OpenFOAM case into what the UI shows:
- a regular grid of T and U (for slices and streamlines),
- per-rack intake temperature at three heights, exhaust temperature,
- room indices RCI-HI / RTI with their inputs,
- streamlines seeded deliberately (evenly over chosen grilles, or backward from a rack intake).
Everything is deterministic."""
import sys, json, numpy as np, foamread as f
from scipy.spatial import cKDTree
from scipy.ndimage import map_coordinates, gaussian_filter

case, time = sys.argv[1], sys.argv[2]
G = json.load(open('/tmp/case_geom.json')); C = json.load(open(f'{case}/case.json'))
L, H, W = 5.545, 2.41, 3.845
cc = f.cell_centres(case); U = f.field(case, time, 'U'); T = f.field(case, time, 'T') - 273.15

# ---------------- regular grid (2.5 cm), nearest cell, solids masked
h = 0.025
xs, ys, zs = np.arange(h/2, L, h), np.arange(h/2, H, h), np.arange(h/2, W, h)
X, Y, Z = np.meshgrid(xs, ys, zs, indexing='ij')
pts = np.stack([X.ravel(), Y.ravel(), Z.ravel()], 1)
tree = cKDTree(cc); d, idx = tree.query(pts, k=4)
w = 1 / np.maximum(d, 1e-4); w /= w.sum(1, keepdims=True)
Tg = (T[idx] * w).sum(1).reshape(X.shape)
Ug = np.stack([(U[idx][:, :, k] * w).sum(1) for k in range(3)], 0).reshape(3, *X.shape)
solid = np.zeros(X.shape, bool)
for _, b in G['solids'] + G['ac_boxes']:
    solid |= (X >= b[0]) & (X <= b[1]) & (Y >= b[2]) & (Y <= b[3]) & (Z >= b[4]) & (Z <= b[5])
np.savez_compressed(f'{case}/grid.npz', T=Tg.astype(np.float32), U=Ug.astype(np.float32), solid=solid, h=h)

def sampleT(p):
    i = np.clip(((np.asarray(p) / h) - .5), 0, None)
    return float(map_coordinates(Tg, i.reshape(3, -1), order=1, mode='nearest')[0])

# ---------------- racks: intake (front face, 4 cm in front) and exhaust (rear, 4 cm behind)
racks = []
for i, (x0, fz) in enumerate(G['racks']):
    xsr = np.linspace(x0 + .1, x0 + .5, 5)
    def band(y, z): return float(np.mean([sampleT((x, y, z)) for x in xsr]))
    intake = {k: round(band(y, fz - .04), 1) for k, y in (('top', 1.75), ('mid', 1.05), ('bottom', 0.35))}
    exhaust = round(float(np.mean([band(y, fz + 1.04) for y in (0.35, 1.05, 1.75)])), 1)
    racks.append(dict(name=f'Rack {i+1}', intake=intake, exhaust=exhaust, max_intake=max(intake.values())))

# ---------------- room indices (ASHRAE: recommended max 27 °C, allowable 32 °C)
intakes = [v for r in racks for v in r['intake'].values()]
over = sum(max(0, t - 27) for t in intakes)
rci_hi = 100 * (1 - over / (len(intakes) * (32 - 27)))
ts = C['assumptions']['supply_temp_C']
ret = []
for _, b in G['ac_boxes']:
    ret.append(np.mean([sampleT((x, b[2] - 0.05, z)) for x in np.linspace(b[0] + .2, b[1] - .2, 6) for z in (0.12, 0.2, 0.28)]))
t_ret = float(np.mean(ret))
dt_eq = C['assumptions']['rack_delta_T_K']
rti = 100 * (t_ret - ts) / dt_eq
summary = dict(time=time, racks=racks, rci_hi=round(rci_hi, 1), rti=round(rti, 0), return_temp=round(t_ret, 1), supply_temp=ts,
               t_min=round(float(T.min()), 1), t_max=round(float(T.max()), 1), u_max=round(float(np.linalg.norm(U, axis=1).max()), 2),
               cells=len(cc), assumptions=C['assumptions'])

# ---------------- streamlines through the grid (RK4, 1 cm steps), each point carries T
def vel(p):
    i = np.clip((p / h) - .5, 0, None).reshape(3, 1)
    return np.array([map_coordinates(Ug[k], i, order=1, mode='nearest')[0] for k in range(3)])
def inside(p): return 0 < p[0] < L and 0 < p[1] < H and 0 < p[2] < W
def trace(p, sign=1, n=900, ds=0.012):
    pts = [p.copy()]
    for _ in range(n):
        k1 = vel(p); s = np.linalg.norm(k1)
        if s < 0.02: break
        k2 = vel(p + sign * k1 / s * ds / 2); s2 = np.linalg.norm(k2)
        if s2 < 1e-6: break
        p = p + sign * k2 / s2 * ds
        if not inside(p): break
        i = np.minimum((p / h).astype(int), np.array(solid.shape) - 1)
        if solid[tuple(i)]: break
        pts.append(p.copy())
    if sign < 0: pts = pts[::-1]
    return [[round(float(q[0] * 100), 1), round(float(q[1] * 100), 1), round(float(q[2] * 100), 1), round(sampleT(q), 2)] for q in pts[::2]]
sets = {}
# from each AC supply grille: an even 6 x 3 grid
for name, b in G['ac_boxes']:
    sb = C['grilles'][name]['supply_box']
    seeds = [np.array([x, y, sb[4] + 0.02]) for x in np.linspace(sb[0] + .05, sb[1] - .05, 6) for y in np.linspace(sb[2] + .02, sb[3] - .02, 3)]
    sets[name] = [trace(s) for s in seeds]
# backward from each rack's intake: where the air it breathes comes from
for i, (x0, fz) in enumerate(G['racks']):
    seeds = [np.array([x, y, fz - 0.03]) for x in np.linspace(x0 + .12, x0 + .48, 4) for y in np.linspace(.3, 1.8, 5)]
    sets[f'rack{i+1}_intake'] = [trace(s, -1) for s in seeds]
    seeds = [np.array([x, y, fz + 1.03]) for x in np.linspace(x0 + .12, x0 + .48, 3) for y in np.linspace(.3, 1.8, 4)]
    sets[f'rack{i+1}_exhaust'] = [trace(s, 1) for s in seeds]
json.dump(sets, open(f'{case}/streamlines.json', 'w'))
json.dump(summary, open(f'{case}/summary.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps({k: v for k, v in summary.items() if k != 'assumptions'}, ensure_ascii=False, indent=1))
