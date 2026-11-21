#!/bin/bash
# Regenerates ../case/: the reference writers (make_case_mm.py + bc.py) on the reference input.
# Run in the pinned OpenFOAM image with python3-numpy (see README.md):
#   docker run --rm -v "$PWD":/fx -w /fx/gen <image> bash gen-case.sh
. /usr/lib/openfoam/openfoam2606/etc/bashrc; set -e
A=/tmp/case; M=/tmp/mesh; OUT=/fx/case
rm -rf $A $M $OUT; mkdir -p $OUT
python3 make_case_mm.py $A 0.07 > /dev/null
# bc.py needs the meshed grille areas; mesh a copy, so the 0/ files stay as make_case wrote them.
cp -r $A $M
(cd $M && blockMesh > /dev/null && snappyHexMesh -overwrite > /dev/null)
cp -r $M/constant/polyMesh $A/constant/
python3 bc.py $A > /dev/null
cd $A
for f in system/blockMeshDict system/snappyHexMeshDict system/topoSetDict system/controlDict \
         system/fvSchemes system/fvSolution constant/fvOptions constant/transportProperties \
         constant/turbulenceProperties constant/g 0/U 0/T 0/p_rgh 0/p 0/k 0/epsilon 0/nut 0/alphat \
         constant/triSurface/*.stl; do
    mkdir -p $OUT/$(dirname $f); cp $f $OUT/$f
done
python3 -c "import json; J = json.load(open('case.json')); json.dump({n: v['supply_area'] for n, v in J['grille_bc'].items()}, open('$OUT/bc_areas.json', 'w'), indent=1)"
gzip -9 $OUT/constant/triSurface/*.stl
