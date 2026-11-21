"""Regenerates ../post/: solved fields of one run (a coarse run of the reference case, see README.md) and
what post.py makes of them, unrounded, plus the energy balance through the grilles.

    python3 gen_post.py CASE TIME INPUT.json OUT_DIR

Only the cells within 0.35 m of a sampling point are kept (as float32); post.py and the Rust post both
read exactly those values, so the comparison is unaffected."""
import sys, os, json, gzip, re, subprocess, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import foamread as f

case, time, inp, out = sys.argv[1:5]
I = json.load(open(inp)); m = lambda v: v / 1000.0
cc = f.cell_centres(case)
T = f.field(case, time, 'TMean'); U = f.field(case, time, 'UMean')

# post.py's sampling points: rack intakes and exhausts, unit returns.
pts = []
for r in I['racks']:
    x0, z0, z1 = m(r['body'][0]), m(r['body'][4]), m(r['body'][5])
    for x in np.linspace(x0 + .1, x0 + .5, 5):
        for y in (1.75, 1.05, 0.35):
            pts += [(x, y, z0 - .04), (x, y, z1 + .04)]
for u in I['units']:
    b = [m(v) for v in u['body']]
    for x in np.linspace(b[0] + .2, b[1] - .2, 6):
        for z in (0.12, 0.2, 0.28):
            pts.append((x, b[2] - 0.05, z))
pts = np.array(pts)
from scipy.spatial import cKDTree
d, _ = cKDTree(pts).query(cc)
keep = d <= 0.35
data = np.hstack([cc[keep], T[keep, None], U[keep]]).astype('<f4')
os.makedirs(out, exist_ok=True)
with gzip.open(f'{out}/cells.f32.gz', 'wb', 9) as g:
    g.write(np.uint32(len(data)).astype('<u4').tobytes()); g.write(data.tobytes())
json.dump(I, open(f'{out}/input.json', 'w'), indent=1)

# The grilles' averaged boundary values, for the energy balance.
def bvals(field, patch):
    s = open(f'{case}/{time}/{field}').read(); i = s.index('boundaryField')
    blk = re.search(rf'\b{patch}\s*\{{(.*?)\}}', s[i:], re.S).group(1); v = blk[blk.index('value'):]
    if v.split()[1] == 'uniform': return float(v.split()[2].rstrip(';'))
    n = int(re.search(r'List<scalar>\s*(\d+)', v).group(1))
    return np.fromstring(v[v.index('(') + 1:].replace(')', ' '), sep=' ', count=n).tolist()
openings = {}
for u in I['units']:
    for kind, n in (('supply', len(u['supplies'])), ('return', len(u['returns']))):
        for k in range(n):
            p = f"{u['key']}_{kind}{k + 1}"
            phi = bvals('phiMean', p); t = bvals('TMean', p)
            if not isinstance(t, list): t = [t] * len(phi)
            openings[p] = {'phi': phi, 't': t}
json.dump(openings, open(f'{out}/openings.json', 'w'))
Ts = 273.15 + I['supply_temp_c']
removed = sum(1.2 * 1005.0 * ph * (t - Ts) for o in openings.values() for ph, t in zip(o['phi'], o['t']))
net = sum(ph for o in openings.values() for ph in o['phi'])

# post.py, unrounded, on exactly the kept float32 values.
work = '/tmp/postcase'; os.makedirs(f'{work}/avg', exist_ok=True)
c32 = data[:, :3].astype(float); np.save(f'{work}/cc.npy', c32)
def write_field(name, cls, vals):
    body = '\n'.join(('(%r %r %r)' % tuple(map(float, v))) if cls == 'vector' else repr(float(v)) for v in vals)
    open(f'{work}/avg/{name}', 'w').write('FoamFile { version 2.0; format ascii; class vol%sField; object %s; }\n'
        'internalField nonuniform List<%s> %d\n(\n%s\n)\n;\n' % (cls.capitalize(), name, cls, len(vals), body))
write_field('T', 'scalar', data[:, 3]); write_field('U', 'vector', data[:, 4:7])
json.dump(dict(solids=[[s['name'], [m(v) for v in s['b']]] for s in I['solids']],
               ac_boxes=[[u['key'], [m(v) for v in u['body']]] for u in I['units']],
               racks=[[m(r['body'][0]), m(r['body'][4])] for r in I['racks']]), open('/tmp/case_geom.json', 'w'))
grilles = {}
for u in I['units']:
    g = u['supplies'][0]['grille']['rect']; z = m(u['body'][5])
    grilles[u['key']] = {'supply_box': [m(g[0]), m(g[1]), m(g[2]), m(g[3]), z]}
json.dump({'assumptions': {'supply_temp_C': I['supply_temp_c'], 'rack_delta_T_K': I['settings']['rack_delta_t_k']},
           'grilles': grilles}, open(f'{work}/case.json', 'w'))
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'post.py')).read()
src = '_keep = lambda v, n=None: v\n' + src.replace('round(', '_keep(')
open('/tmp/post_unrounded.py', 'w').write(src)
subprocess.run([sys.executable, '/tmp/post_unrounded.py', work, 'avg'], check=True, stdout=subprocess.DEVNULL,
               cwd=os.path.dirname(os.path.abspath(__file__)), env={**os.environ, 'PYTHONPATH': os.path.dirname(os.path.abspath(__file__))})
S = json.load(open(f'{work}/summary.json'))
S.pop('assumptions', None)
S['heat_removed_w'] = removed; S['net_flux_m3s'] = net; S['cells_kept'] = int(len(data)); S['cells_run'] = int(len(cc))
json.dump(S, open(f'{out}/expected.json', 'w'), indent=1)
print('kept', len(data), 'of', len(cc), 'cells; removed', round(removed), 'W')
