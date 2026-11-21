"""make_case.py from dc-handoff/reference/airflow-cfd with its geometry in whole millimetres, rounded as
portal_cfd::reference::reference_input() rounds it (half away from zero), so that both writers get the
same input. Everything from "STL writers" on is make_case.py verbatim, except the grille rectangles,
also rounded to whole millimetres.

Generate an OpenFOAM case (buoyantBoussinesqSimpleFoam, k-epsilon) for the Eskiz server room.

Geometry: the tape-measured room (room.json v2 values, metres). Every input that is not measured
is in ASSUMPTIONS and is printed into the result's header, so the picture never hides a guess.
Axes: x along the 5.545 m wall, y up, z from the shelf wall (0) to the wall behind the racks (3.845).
"""
import os, json, random, sys

CASE = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/work/cfd/room'
CELL = float(sys.argv[2]) if len(sys.argv) > 2 else 0.06

L, H, W = 5.545, 2.41, 3.845

ASSUMPTIONS = {
    'ac_airflow_m3h': 1100,          # per unit — model unknown, typical for 5-7 kW ducted units
    'supply_temp_C': 17.0,
    'deflector_pitch_deg': 30,       # vanes aim the jet down
    'ac_return': 'rear half of the underside',
    'rack_heat_kW': [3.0, 3.0, 3.0, 1.5],
    'rack_delta_T_K': 10.0,          # air temperature rise through a rack
    'tower_heat_W': 120,             # each colocation tower on the shelf
    'doors': 'all racks open to airflow (door types not yet recorded)',
    'walls': 'adiabatic',
}
A = ASSUMPTIONS

# ---------------------------------------------------------------- geometry (boxes: x0,x1,y0,y1,z0,z1)
import math
rnd = lambda v: math.floor(v + 0.5)          # mm, half away from zero (all values positive)
solids = []          # (name, box) in metres
def B(name, x0, x1, y0, y1, z0, z1): solids.append((name, tuple(v / 1000 for v in (x0, x1, y0, y1, z0, z1))))

S0, SL, SD = 200.0, 4530.0, 910
split = S0 + SL / 14 * 5
for a, b in ((S0, split), (split, S0 + SL)):
    for x in (a, b - 40.0):
        for z in (0, SD - 40):
            B('shelf_post', rnd(x), rnd(x) + 40, -20, 1795, z - (20 if z == 0 else 0), z + 40)
for y in (120, 950, 1795):
    B('shelf_board', rnd(S0), rnd(S0 + SL), y - 35, y, -20, SD)

acs = [(4005.0, 5255.0, 70), (2487.5, 3632.5, 65), (297.5, 1442.5, 95)]
def under_ac(x): return any(x + 120 > a - 30 and x - 120 < b + 30 for a, b, _ in acs)
towers, seed = [], 3
for bi, y in enumerate((120, 950, 1795)):
    for i in range(14):
        seed = (seed * 7 + 5) % 97
        if seed % 6 == 0: continue
        xc = S0 + SL / 14 * (i + .5)
        if bi == 2 and under_ac(xc): continue
        x0 = rnd(xc - 100)
        B('tower', x0, x0 + 200, y, y + 420, 400, 850)
        towers.append(tuple(v / 1000 for v in (x0, x0 + 200, y + 50, y + 400, 300, 400)))

B('locker', 4984, 5490, -20, 1230, -20, 410)

ac_boxes, ac_mm = [], []
for i, (x0, x1, gap) in enumerate(acs):
    x0m = rnd(x0); x1m = x0m + rnd(x1 - x0)
    yb, yt = 2410 - gap - 380, 2410 - gap
    ac_mm.append((x0m, x1m, yb, yt))
    ac_boxes.append((f'ac{i+1}', tuple(v / 1000 for v in (x0m, x1m, yb, yt, -20, 680))))
acs = [(a / 1000, b / 1000, g / 1000) for a, b, g in acs]

racks = [(0.53, 2.25), (1.595, 2.26), (2.635, 2.22), (3.435, 2.215)]
rack_zones = []
for i, (x0, fz) in enumerate([(530, 2250), (1595, 2260), (2635, 2220), (3435, 2215)]):
    z0, z1 = fz, fz + 1000
    B('rack_plinth', x0, x0 + 600, -20, 100, z0, z1)
    B('rack_top', x0, x0 + 600, 1980, 2040, z0, z1)
    if i != 0:
        B('rack_side', x0, x0 + 50, 100, 1980, z0, z1)
        B('rack_side', x0 + 550, x0 + 600, 100, 1980, z0, z1)
    rack_zones.append(tuple(v / 1000 for v in (x0 + 50, x0 + 550, 100, 1980, z0 + 100, z1 - 100)))

# ---------------------------------------------------------------- STL writers
def quad(f, a, b, c, d):
    for t in ((a, b, c), (a, c, d)):
        f.write('facet normal 0 0 0\n outer loop\n' + ''.join(f'  vertex {p[0]:.5f} {p[1]:.5f} {p[2]:.5f}\n' for p in t) + ' endloop\nendfacet\n')
def box_faces(b):
    x0, x1, y0, y1, z0, z1 = b
    P = lambda x, y, z: (x, y, z)
    return {
        'xm': (P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)),
        'xp': (P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)),
        'ym': (P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)),
        'yp': (P(x0, y1, z0), P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0)),
        'zm': (P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0)),
        'zp': (P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)),
    }
os.makedirs(f'{CASE}/constant/triSurface', exist_ok=True)
with open(f'{CASE}/constant/triSurface/obstacles.stl', 'w') as f:
    f.write('solid obstacles\n')
    for _, b in solids:
        for q in box_faces(b).values(): quad(f, *q)
    f.write('endsolid obstacles\n')

# each AC: walls, a supply grille on its front face (+z), a return grille under its rear half
def split_face_z(x0, x1, y0, y1, z, gx0, gx1, gy0, gy1):
    """front face at z (normal +z) split into the grille rectangle and four frame strips"""
    P = lambda x, y: (x, y, z)
    frame = [((x0, y0), (gx0, y1)), ((gx1, y0), (x1, y1)), ((gx0, y0), (gx1, gy0)), ((gx0, gy1), (gx1, y1))]
    fr = [(P(a[0], a[1]), P(b[0], a[1]), P(b[0], b[1]), P(a[0], b[1])) for a, b in frame]
    gr = (P(gx0, gy0), P(gx1, gy0), P(gx1, gy1), P(gx0, gy1))
    return fr, gr
def split_face_ym(x0, x1, y, z0, z1, gx0, gx1, gz0, gz1):
    P = lambda x, z: (x, y, z)
    frame = [((x0, z0), (gx0, z1)), ((gx1, z0), (x1, z1)), ((gx0, z0), (gx1, gz0)), ((gx0, gz1), (gx1, z1))]
    fr = [(P(a[0], a[1]), P(a[0], b[1]), P(b[0], b[1]), P(b[0], a[1])) for a, b in frame]
    gr = (P(gx0, gz0), P(gx0, gz1), P(gx1, gz1), P(gx1, gz0))
    return fr, gr
grilles = {}
for name, b in ac_boxes:
    x0, x1, y0, y1, z0, z1 = b
    X0, X1, Y0, Y1 = ac_mm[int(name[2:]) - 1]; Wu, Hu = X1 - X0, Y1 - Y0
    sx0, sx1, sy0, sy1 = (rnd(X0 + .13 * Wu) / 1000, rnd(X1 - .13 * Wu) / 1000, rnd(Y0 + .23 * Hu) / 1000, rnd(Y1 - .23 * Hu) / 1000)
    rx0, rx1, rz0, rz1 = rnd(X0 + .12 * Wu) / 1000, rnd(X1 - .12 * Wu) / 1000, 0.08, 0.32
    grilles[name] = dict(supply_area=(sx1 - sx0) * (sy1 - sy0), return_area=(rx1 - rx0) * (rz1 - rz0),
                         supply_box=(sx0, sx1, sy0, sy1, z1), return_box=(rx0, rx1, rz0, rz1, y0))
    fz, gz = split_face_z(x0, x1, y0, y1, z1, sx0, sx1, sy0, sy1)
    fy, gy = split_face_ym(x0, x1, y0, z0, z1, rx0, rx1, rz0, rz1)
    F = box_faces(b)
    with open(f'{CASE}/constant/triSurface/{name}.stl', 'w') as f:
        f.write('solid walls\n')
        for k in ('xm', 'xp', 'yp', 'zm'): quad(f, *F[k])
        for q in fz + fy: quad(f, *q)
        f.write('endsolid walls\nsolid supply\n'); quad(f, *gz); f.write('endsolid supply\nsolid return\n'); quad(f, *gy); f.write('endsolid return\n')

# ---------------------------------------------------------------- dictionaries
HDR = lambda cls, obj, loc='system': f'''FoamFile {{ version 2.0; format ascii; class {cls}; location "{loc}"; object {obj}; }}\n'''
def w(path, text):
    os.makedirs(os.path.dirname(f'{CASE}/{path}'), exist_ok=True)
    open(f'{CASE}/{path}', 'w').write(text)
nx, ny, nz = round(L / CELL), round(H / CELL), round(W / CELL)
w('system/blockMeshDict', HDR('dictionary', 'blockMeshDict') + f'''
convertToMeters 1;
vertices ( (0 0 0) ({L} 0 0) ({L} {H} 0) (0 {H} 0) (0 0 {W}) ({L} 0 {W}) ({L} {H} {W}) (0 {H} {W}) );
blocks ( hex (0 1 2 3 4 5 6 7) ({nx} {ny} {nz}) simpleGrading (1 1 1) );
boundary ( room {{ type wall; faces ( (0 3 2 1) (4 5 6 7) (0 4 7 3) (1 2 6 5) (0 1 5 4) (3 7 6 2) ); }} );
''')
acgeo = ''.join(f'  {n}.stl {{ type triSurfaceMesh; name {n}; regions {{ walls {{ name {n}_walls; }} supply {{ name {n}_supply; }} return {{ name {n}_return; }} }} }}\n' for n, _ in ac_boxes)
acref = ''.join(f'    {n} {{ level (2 2); patchInfo {{ type wall; }} regions {{ supply {{ level (2 2); patchInfo {{ type patch; }} }} return {{ level (2 2); patchInfo {{ type patch; }} }} }} }}\n' for n, _ in ac_boxes)
w('system/snappyHexMeshDict', HDR('dictionary', 'snappyHexMeshDict') + f'''
castellatedMesh true; snap false; addLayers false;
geometry {{
  obstacles.stl {{ type triSurfaceMesh; name obstacles; }}
{acgeo}}}
castellatedMeshControls {{
  maxLocalCells 2000000; maxGlobalCells 6000000; minRefinementCells 0; maxLoadUnbalance 0.1; nCellsBetweenLevels 2;
  features ( );
  refinementSurfaces {{
    obstacles {{ level (1 1); patchInfo {{ type wall; }} }}
{acref}  }}
  resolveFeatureAngle 30; refinementRegions {{ }};
  locationInMesh (2.0 1.2 1.6); allowFreeStandingZoneFaces true;
}}
snapControls {{ nSmoothPatch 3; tolerance 2.0; nSolveIter 50; nRelaxIter 5; nFeatureSnapIter 10; implicitFeatureSnap true; explicitFeatureSnap false; multiRegionFeatureSnap false; }}
addLayersControls {{ relativeSizes true; layers {{ }}; expansionRatio 1.0; finalLayerThickness 0.3; minThickness 0.1; nGrow 0; featureAngle 60; nRelaxIter 3; nSmoothSurfaceNormals 1; nSmoothNormals 3; nSmoothThickness 10; maxFaceThicknessRatio 0.5; maxThicknessToMedialRatio 0.3; minMedialAxisAngle 90; nBufferCellsNoExtrude 0; nLayerIter 50; }}
meshQualityControls {{ maxNonOrtho 65; maxBoundarySkewness 20; maxInternalSkewness 4; maxConcave 80; minVol 1e-13; minTetQuality 1e-15; minArea -1; minTwist 0.02; minDeterminant 0.001; minFaceWeight 0.05; minVolRatio 0.01; minTriangleTwist -1; nSmoothScale 4; errorReduction 0.75; relaxed {{ maxNonOrtho 75; }} }}
mergeTolerance 1e-6;
''')
w('system/topoSetDict', HDR('dictionary', 'topoSetDict') + 'actions (\n' + ''.join(
    f'  {{ name rack{i+1}; type cellZoneSet; action new; source boxToCell; box ({b[0]} {b[2]} {b[4]}) ({b[1]} {b[3]} {b[5]}); }}\n' for i, b in enumerate(rack_zones)) +
    '  { name towersHeat; type cellSet; action new; source boxToCell; boxes (' + ' '.join(f'({t[0]} {t[2]} {t[4]}) ({t[1]} {t[3]} {t[5]})' for t in towers) + '); }\n'
    '  { name towersHeat; type cellZoneSet; action new; source setToCellZone; set towersHeat; }\n);\n')

rho_cp = 1.2 * 1005.0
Q = A['ac_airflow_m3h'] / 3600.0
TS = 273.15 + A['supply_temp_C']
import math
pt = math.radians(A['deflector_pitch_deg'])
fv = ''
for i, kw in enumerate(A['rack_heat_kW']):
    b = rack_zones[i]; vol = (b[1] - b[0]) * (b[3] - b[2]) * (b[5] - b[4])
    flow = kw * 1000 / (rho_cp * A['rack_delta_T_K'])            # m3/s
    ubar = flow / ((b[1] - b[0]) * (b[3] - b[2]))
    fv += f'''rack{i+1}Fan {{ type meanVelocityForce; active true; selectionMode cellZone; cellZone rack{i+1}; fields (U); Ubar (0 0 {ubar:.4f}); relaxation 0.2; }}
rack{i+1}Heat {{ type scalarSemiImplicitSource; active true; selectionMode cellZone; cellZone rack{i+1}; volumeMode absolute; injectionRateSuSp {{ T ({kw*1000/rho_cp:.5f} 0); }} }}
'''
fv += f'''towersHeat {{ type scalarSemiImplicitSource; active true; selectionMode cellZone; cellZone towersHeat; volumeMode absolute; injectionRateSuSp {{ T ({len(towers)*A['tower_heat_W']/rho_cp:.5f} 0); }} }}
'''
w('constant/fvOptions', HDR('dictionary', 'fvOptions', 'constant') + fv)
w('constant/transportProperties', HDR('dictionary', 'transportProperties', 'constant') + 'transportModel Newtonian; nu 1.5e-05; beta 3.3e-03; TRef 300; Pr 0.71; Prt 0.85;\n')
w('constant/turbulenceProperties', HDR('dictionary', 'turbulenceProperties', 'constant') + 'simulationType RAS; RAS { RASModel kEpsilon; turbulence on; printCoeffs on; }\n')
w('constant/g', HDR('uniformDimensionedVectorField', 'g', 'constant') + 'dimensions [0 1 -2 0 0 0 0]; value (0 -9.81 0);\n')
w('system/controlDict', HDR('dictionary', 'controlDict') + '''application buoyantBoussinesqSimpleFoam; startFrom latestTime; startTime 0; stopAt endTime; endTime 2000; deltaT 1;
writeControl timeStep; writeInterval 500; purgeWrite 0; writeFormat ascii; writePrecision 6; writeCompression off; timeFormat general; timePrecision 6; runTimeModifiable true;
functions { average { type fieldAverage; libs (fieldFunctionObjects); writeControl writeTime; timeStart 1500;
  fields ( U { mean on; prime2Mean off; base iteration; } T { mean on; prime2Mean off; base iteration; } ); } }
''')
w('system/fvSchemes', HDR('dictionary', 'fvSchemes') + '''ddtSchemes { default steadyState; }
gradSchemes { default Gauss linear; grad(U) cellLimited Gauss linear 1; grad(T) cellLimited Gauss linear 1; }
divSchemes { default none; div(phi,U) bounded Gauss linearUpwind grad(U); div(phi,T) bounded Gauss linearUpwind grad(T);
  div(phi,k) bounded Gauss upwind; div(phi,epsilon) bounded Gauss upwind; div((nuEff*dev2(T(grad(U))))) Gauss linear; }
laplacianSchemes { default Gauss linear limited corrected 0.5; }
interpolationSchemes { default linear; }
snGradSchemes { default limited corrected 0.5; }
wallDist { method meshWave; }
''')
w('system/fvSolution', HDR('dictionary', 'fvSolution') + '''solvers {
  p_rgh { solver GAMG; smoother GaussSeidel; tolerance 1e-7; relTol 0.01; }
  "(U|T|k|epsilon)" { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-7; relTol 0.1; }
}
SIMPLE { momentumPredictor yes; nNonOrthogonalCorrectors 1;
  residualControl { p_rgh 1e-4; U 1e-5; T 1e-5; "(k|epsilon)" 1e-5; } }
relaxationFactors { fields { p_rgh 0.7; } equations { U 0.3; T 0.5; "(k|epsilon)" 0.5; } }
''')
w('system/decomposeParDict', HDR('dictionary', 'decomposeParDict') + 'numberOfSubdomains 2; method simple; coeffs { n (2 1 1); }\n')

# ---------------------------------------------------------------- initial / boundary fields
k_in, eps_in = 0.015, 0.015
sup = lambda n: f'(0 {-Q/grilles[n]["supply_area"]*math.sin(pt):.4f} {Q/grilles[n]["supply_area"]*math.cos(pt):.4f})'
ret = lambda n: f'(0 {-Q/grilles[n]["return_area"]:.4f} 0)'     # out of the room = down into the unit's underside? no: into the unit = +y? see below
def field(name, cls, dims, internal, walls, supply, ret_):
    bf = f'  room {{ {walls} }}\n  obstacles {{ {walls} }}\n'
    for n, _ in ac_boxes:
        bf += f'  {n}_walls {{ {walls} }}\n  {n}_supply {{ {supply(n)} }}\n  {n}_return {{ {ret_(n)} }}\n'
    w(f'0/{name}', HDR(cls, name, '0') + f'dimensions {dims};\ninternalField uniform {internal};\nboundaryField {{\n{bf}}}\n')
# return grille is on the underside: air leaves the room upwards into the unit (+y)
field('U', 'volVectorField', '[0 1 -1 0 0 0 0]', '(0 0 0)', 'type noSlip;',
      lambda n: f'type fixedValue; value uniform {sup(n)};',
      lambda n: 'type pressureInletOutletVelocity; value uniform (0 0 0);')
field('T', 'volScalarField', '[0 0 0 1 0 0 0]', '299', 'type zeroGradient;',
      lambda n: f'type fixedValue; value uniform {TS:.2f};', lambda n: 'type inletOutlet; inletValue uniform 299; value uniform 299;')
field('p_rgh', 'volScalarField', '[0 2 -2 0 0 0 0]', '0', 'type fixedFluxPressure; value uniform 0;',
      lambda n: 'type fixedFluxPressure; value uniform 0;', lambda n: 'type fixedValue; value uniform 0;')
field('p', 'volScalarField', '[0 2 -2 0 0 0 0]', '0', 'type calculated; value uniform 0;',
      lambda n: 'type calculated; value uniform 0;', lambda n: 'type calculated; value uniform 0;')
field('k', 'volScalarField', '[0 2 -2 0 0 0 0]', '0.005', 'type kqRWallFunction; value uniform 0.005;',
      lambda n: f'type fixedValue; value uniform {k_in};', lambda n: 'type inletOutlet; inletValue uniform 0.005; value uniform 0.005;')
field('epsilon', 'volScalarField', '[0 2 -3 0 0 0 0]', '0.005', 'type epsilonWallFunction; value uniform 0.005;',
      lambda n: f'type fixedValue; value uniform {eps_in};', lambda n: 'type inletOutlet; inletValue uniform 0.005; value uniform 0.005;')
field('nut', 'volScalarField', '[0 2 -1 0 0 0 0]', '0', 'type nutkWallFunction; value uniform 0;',
      lambda n: 'type calculated; value uniform 0;', lambda n: 'type calculated; value uniform 0;')
field('alphat', 'volScalarField', '[0 2 -1 0 0 0 0]', '0', 'type alphatJayatillekeWallFunction; Prt 0.85; value uniform 0;',
      lambda n: 'type calculated; value uniform 0;', lambda n: 'type calculated; value uniform 0;')

json.dump(dict(assumptions=A, cell=CELL, solids=solids, ac_boxes=ac_boxes, racks=racks, rack_zones=rack_zones, acs=acs, grilles=grilles, towers=len(towers),
               rack_heat_total_kW=sum(A['rack_heat_kW']), tower_heat_total_kW=len(towers) * A['tower_heat_W'] / 1000),
          open(f'{CASE}/case.json', 'w'), indent=1)
print('case written', CASE, 'base cells', nx * ny * nz, 'towers', len(towers))
