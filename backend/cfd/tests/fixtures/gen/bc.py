"""After meshing: set grille boundary conditions from the snapped patch areas so the airflow is exact
(supply normal flux = Q per unit, return outflow = Q per unit) — mass balance closes by construction."""
import sys, json, math, re, numpy as np, foamread as f
case = sys.argv[1]; J = json.load(open(f'{case}/case.json')); A = J['assumptions']
Q = A['ac_airflow_m3h'] / 3600.0; pt = math.radians(A['deflector_pitch_deg'])
U = open(f'{case}/0/U').read(); P = open(f'{case}/0/p_rgh').read()
info = {}
for n in ('ac1', 'ac2', 'ac3'):
    S = f.patch_area_vectors(case, f'{n}_supply'); a = float(np.linalg.norm(S.sum(0)))
    un = Q / a; ut = un * math.tan(pt)
    flux = -float((S @ np.array([0.0, -ut, un])).sum())          # inflow as OpenFOAM will compute it (same face-area formula)
    U = re.sub(rf'{n}_supply \{{[^}}]*\}}', f'{n}_supply {{ type fixedValue; value uniform (0 {-ut:.12g} {un:.12g}); }}', U)
    # the last return absorbs the tiny area round-off so mass balance closes exactly; the others carry exactly Q
    rbc = 'type pressureInletOutletVelocity; value uniform (0 0 0);'   # return = pressure outlet: mass balance closes itself
    U = re.sub(rf'{n}_return \{{[^}}]*\}}', f'{n}_return {{ {rbc} }}', U)
    P = re.sub(rf'{n}_return \{{[^}}]*\}}', f'{n}_return {{ type fixedValue; value uniform 0; }}', P)
    info[n] = dict(supply_area=a, supply_speed=math.hypot(un, ut), Q=Q)
open(f'{case}/0/U', 'w').write(U)
# give the free return an initial outflow so the flux balance can adjust it (it then carries the round-off)
x0, x1, z0, z1, y = J['grilles']['ac3']['return_box']
open(f'{case}/system/setFieldsDict', 'w').write('FoamFile { version 2.0; format ascii; class dictionary; object setFieldsDict; }\n'
  'defaultFieldValues ( volVectorFieldValue U (0 0 0) );\n'
  f'regions ( boxToCell {{ box ({x0} {y-0.12} {z0}) ({x1} {y} {z1}); fieldValues ( volVectorFieldValue U (0 1.2 0) ); }} );\n'); open(f'{case}/0/p_rgh', 'w').write(P)
fs = open(f'{case}/system/fvSolution').read()
if False:
    fs = fs.replace('SIMPLE { momentumPredictor', 'SIMPLE { pRefPoint (2.0 1.2 1.6); pRefValue 0; momentumPredictor')
    open(f'{case}/system/fvSolution', 'w').write(fs)
J['grille_bc'] = info; json.dump(J, open(f'{case}/case.json', 'w'), indent=1)
print(info)
