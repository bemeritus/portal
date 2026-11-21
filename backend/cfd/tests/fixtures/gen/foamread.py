"""Minimal ASCII OpenFOAM reader: mesh cell centres and internal fields (no function objects needed)."""
import numpy as np, re, os

def _body(path):
    s = open(path).read()
    s = re.sub(r'/\*.*?\*/', '', s, flags=re.S)
    s = re.sub(r'//[^\n]*', '', s)
    i = s.index('FoamFile'); j = s.index('}', i)
    return s[j+1:]

def _list(body, start=0):
    m = re.search(r'(\d+)\s*\(', body[start:])
    n = int(m.group(1)); a = start + m.end()
    return n, a

def points(case):
    b = _body(f'{case}/constant/polyMesh/points'); n, a = _list(b)
    txt = b[a:].replace('(', ' ').replace(')', ' ')
    return np.fromstring(txt, sep=' ', count=n*3).reshape(n, 3)

def faces(case):
    b = _body(f'{case}/constant/polyMesh/faces'); n, a = _list(b)
    toks = re.findall(r'(\d+)\(([\d ]+)\)', b[a:])
    return [np.array(t[1].split(), int) for t in toks[:n]]

def labels(case, name):
    b = _body(f'{case}/constant/polyMesh/{name}'); n, a = _list(b)
    return np.fromstring(b[a:].replace(')', ' '), sep=' ', dtype=np.int64, count=n) if False else np.array(b[a:].split(')')[0].split(), np.int64)

def cell_centres(case):
    cache = f'{case}/cc.npy'
    if os.path.exists(cache): return np.load(cache)
    P = points(case); F = faces(case); own = labels(case, 'owner'); nei = labels(case, 'neighbour')
    fc = np.array([P[f].mean(0) for f in F])
    nc = int(max(own.max(), nei.max())) + 1
    s = np.zeros((nc, 3)); c = np.zeros(nc)
    np.add.at(s, own, fc); np.add.at(c, own, 1)
    np.add.at(s, nei, fc[:len(nei)]); np.add.at(c, nei, 1)
    cc = s / c[:, None]; np.save(cache, cc); return cc

def field(case, time, name):
    b = _body(f'{case}/{time}/{name}')
    m = re.search(r'internalField\s+(uniform|nonuniform)', b)
    if m.group(1) == 'uniform':
        raise ValueError('uniform field')
    n, a = _list(b, m.end())
    seg = b[a:]
    if 'Vector' in open(f'{case}/{time}/{name}').read(1500):
        txt = seg.split(')\n;')[0] if ')\n;' in seg else seg
        vals = np.fromstring(txt.replace('(', ' ').replace(')', ' '), sep=' ', count=n*3)
        return vals.reshape(n, 3)
    return np.fromstring(seg.replace(')', ' '), sep=' ', count=n)

def boundary(case):
    b = _body(f'{case}/constant/polyMesh/boundary')
    out = {}
    for m in re.finditer(r'(\w+)\s*\{([^}]*)\}', b):
        d = dict(re.findall(r'(\w+)\s+([^;]+);', m.group(2)))
        if 'nFaces' in d: out[m.group(1)] = (int(d['startFace']), int(d['nFaces']))
    return out

def patch_area_vectors(case, name):
    P = points(case); F = faces(case); s, n = boundary(case)[name]
    S = []
    for f in F[s:s+n]:
        p = P[f]; c = p.mean(0); a = np.zeros(3)
        for i in range(len(p)):
            a += np.cross(p[i] - c, p[(i+1) % len(p)] - c) / 2
        S.append(a)
    return np.array(S)
