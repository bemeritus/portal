//! The OpenFOAM case for a [`CaseInput`]: a port of `make_case.py` and
//! `bc.py` from `reference/airflow-cfd/`, with the settings that converge
//! there (castellated hex mesh with `snap false`, pressure-outlet returns,
//! its relaxation and schemes). Pure: it returns file contents, the worker
//! writes them.
//!
//! `buoyantBoussinesqSimpleFoam`, k-ε. Racks are fan-driven fluid zones
//! (`meanVelocityForce`) with their heat as a temperature source; cooling
//! units are solid bodies whose supply grilles have a fixed velocity and
//! whose returns are pressure outlets, so the mass balance closes itself.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use crate::input::{Box3, CaseInput, Face, Grille, Unit};

/// ρ·c_p of air, J/(m³·K), as in the reference.
pub const RHO_CP: f64 = 1.2 * 1005.0;
/// Turbulence at the supply grilles, and the initial field.
const K_IN: f64 = 0.015;
const EPS_IN: f64 = 0.015;
/// The initial room temperature, K.
const T_INIT: f64 = 299.0;

/// Metres from millimetres.
pub fn m(v: i32) -> f64 {
    v as f64 / 1000.0
}

fn hdr(class: &str, object: &str, location: &str) -> String {
    format!(
        "FoamFile {{ version 2.0; format ascii; class {class}; location \"{location}\"; object {object}; }}\n"
    )
}

/// The patch names of a unit's grilles, in the order of its supplies, then
/// its returns.
pub fn supply_patch(u: &Unit, k: usize) -> String {
    format!("{}_supply{}", u.key, k + 1)
}

pub fn return_patch(u: &Unit, k: usize) -> String {
    format!("{}_return{}", u.key, k + 1)
}

/// Number of background cells along each axis.
pub fn block_cells(input: &CaseInput) -> [i64; 3] {
    let c = input.settings.cell_mm as f64;
    input
        .room
        .map(|v| ((v as f64 / c).round_ties_even() as i64).max(1))
}

/// Every file of the case, relative to its directory. `0/U` carries the
/// nominal supply velocities; [`u_field`] rewrites it from the meshed
/// grille areas once the mesh exists.
pub fn files(input: &CaseInput) -> Vec<(String, String)> {
    let mut out = vec![
        (
            "constant/triSurface/obstacles.stl".into(),
            obstacles_stl(input),
        ),
        ("system/blockMeshDict".into(), block_mesh_dict(input)),
        ("system/snappyHexMeshDict".into(), snappy_dict(input)),
        ("system/topoSetDict".into(), topo_set_dict(input)),
        ("constant/fvOptions".into(), fv_options(input)),
        (
            "constant/transportProperties".into(),
            hdr("dictionary", "transportProperties", "constant")
                + "transportModel Newtonian; nu 1.5e-05; beta 3.3e-03; TRef 300; Pr 0.71; Prt 0.85;\n",
        ),
        (
            "constant/turbulenceProperties".into(),
            hdr("dictionary", "turbulenceProperties", "constant")
                + "simulationType RAS; RAS { RASModel kEpsilon; turbulence on; printCoeffs on; }\n",
        ),
        (
            "constant/g".into(),
            hdr("uniformDimensionedVectorField", "g", "constant")
                + "dimensions [0 1 -2 0 0 0 0]; value (0 -9.81 0);\n",
        ),
        (
            "system/controlDict".into(),
            control_dict(input, input.settings.iterations),
        ),
        ("system/fvSchemes".into(), FV_SCHEMES.to_string()),
        ("system/fvSolution".into(), FV_SOLUTION.to_string()),
        (
            "system/decomposeParDict".into(),
            decompose_par_dict(input, 1),
        ),
        ("0/U".into(), u_field(input, &BTreeMap::new())),
    ];
    for u in &input.units {
        out.push((format!("constant/triSurface/{}.stl", u.key), unit_stl(u)));
    }
    out.extend(scalar_fields(input));
    out
}

// --- Geometry ----------------------------------------------------------------

/// A rectangle on a face, as `[a0, a1, b0, b1]` in the face's plane axes.
type Rect = [i32; 4];

/// One quad of a face, outward-facing, in metres.
fn quad(stl: &mut String, face: Face, plane: i32, r: Rect) {
    let [a, b] = face.plane_axes();
    let n = face.axis();
    let p = |va: i32, vb: i32| {
        let mut q = [0i32; 3];
        q[n] = plane;
        q[a] = va;
        q[b] = vb;
        q
    };
    let mut pts = [p(r[0], r[2]), p(r[1], r[2]), p(r[1], r[3]), p(r[0], r[3])];
    // e_a × e_b points along +x, −y and +z for the x, y and z faces.
    let natural = if n == 1 { -1.0 } else { 1.0 };
    if natural != face.sign() {
        pts.reverse();
    }
    for t in [[0, 1, 2], [0, 2, 3]] {
        stl.push_str("facet normal 0 0 0\n outer loop\n");
        for i in t {
            let q = pts[i];
            let _ = writeln!(stl, "  vertex {:.5} {:.5} {:.5}", m(q[0]), m(q[1]), m(q[2]));
        }
        stl.push_str(" endloop\nendfacet\n");
    }
}

const FACES: [Face; 6] = [
    Face::XMin,
    Face::XMax,
    Face::YMin,
    Face::YMax,
    Face::ZMin,
    Face::ZMax,
];

/// A face of `b` as a rectangle in its plane axes.
fn face_rect(b: &Box3, face: Face) -> Rect {
    let [a, c] = face.plane_axes();
    [b[2 * a], b[2 * a + 1], b[2 * c], b[2 * c + 1]]
}

fn obstacles_stl(input: &CaseInput) -> String {
    let mut s = String::from("solid obstacles\n");
    for o in &input.solids {
        for f in FACES {
            quad(&mut s, f, f.plane_of(&o.b), face_rect(&o.b, f));
        }
    }
    s.push_str("endsolid obstacles\n");
    s
}

/// A unit's surface in regions: `walls`, `supplyN`, `returnN`. A face with
/// grilles is cut along every grille edge; each piece belongs to the grille
/// that contains it, or to the walls.
fn unit_stl(u: &Unit) -> String {
    let mut regions: BTreeMap<String, String> = BTreeMap::new();
    let grilles: Vec<(String, &Grille)> = u
        .supplies
        .iter()
        .enumerate()
        .map(|(k, s)| (format!("supply{}", k + 1), &s.grille))
        .chain(
            u.returns
                .iter()
                .enumerate()
                .map(|(k, g)| (format!("return{}", k + 1), g)),
        )
        .collect();
    for f in FACES {
        let plane = f.plane_of(&u.body);
        let full = face_rect(&u.body, f);
        let on: Vec<&(String, &Grille)> = grilles.iter().filter(|g| g.1.face == f).collect();
        let mut cuts_a = vec![full[0], full[1]];
        let mut cuts_b = vec![full[2], full[3]];
        for (_, g) in &on {
            cuts_a.extend([g.rect[0], g.rect[1]]);
            cuts_b.extend([g.rect[2], g.rect[3]]);
        }
        for c in [&mut cuts_a, &mut cuts_b] {
            c.sort_unstable();
            c.dedup();
        }
        for wa in cuts_a.windows(2) {
            for wb in cuts_b.windows(2) {
                let r = [wa[0], wa[1], wb[0], wb[1]];
                let (ca, cb) = ((r[0] + r[1]) as f64 / 2.0, (r[2] + r[3]) as f64 / 2.0);
                let region = on
                    .iter()
                    .find(|(_, g)| {
                        let q = g.rect;
                        q[0] as f64 <= ca
                            && ca <= q[1] as f64
                            && q[2] as f64 <= cb
                            && cb <= q[3] as f64
                    })
                    .map(|(name, _)| name.clone())
                    .unwrap_or_else(|| "walls".into());
                quad(regions.entry(region).or_default(), f, plane, r);
            }
        }
    }
    let mut s = String::new();
    for (name, facets) in regions {
        let _ = write!(s, "solid {name}\n{facets}endsolid {name}\n");
    }
    s
}

/// A point of the room's air, used as `locationInMesh`: on a lattice offset
/// from the cell faces, at least one cell from every wall, object and rack,
/// the one nearest the room's centre.
pub fn location_in_mesh(input: &CaseInput) -> [f64; 3] {
    let c = input.settings.cell_mm;
    let mut boxes: Vec<Box3> = input.solids.iter().map(|s| s.b).collect();
    boxes.extend(input.units.iter().map(|u| u.body));
    boxes.extend(input.racks.iter().map(|r| r.body));
    let free = |p: [f64; 3]| {
        (0..3).all(|a| p[a] >= c as f64 && p[a] <= (input.room[a] - c) as f64)
            && boxes.iter().all(|b| {
                (0..3).any(|a| p[a] < (b[2 * a] - c) as f64 || p[a] > (b[2 * a + 1] + c) as f64)
            })
    };
    let n = block_cells(input);
    let centre = input.room.map(|v| v as f64 / 2.0);
    let mut best: Option<(f64, [f64; 3])> = None;
    for i in 0..n[0] {
        for j in 0..n[1] {
            for k in 0..n[2] {
                let p = [i, j, k].map(|v| (v as f64 + 0.37) * c as f64);
                if !free(p) {
                    continue;
                }
                let d: f64 = (0..3).map(|a| (p[a] - centre[a]).powi(2)).sum();
                if best.is_none_or(|(bd, _)| d < bd) {
                    best = Some((d, p));
                }
            }
        }
    }
    best.map(|(_, p)| p.map(|v| v / 1000.0))
        .unwrap_or(centre.map(|v| v / 1000.0))
}

// --- Dictionaries --------------------------------------------------------------

fn block_mesh_dict(input: &CaseInput) -> String {
    let [l, h, w] = input.room.map(m);
    let [nx, ny, nz] = block_cells(input);
    hdr("dictionary", "blockMeshDict", "system")
        + &format!(
            "
convertToMeters 1;
vertices ( (0 0 0) ({l} 0 0) ({l} {h} 0) (0 {h} 0) (0 0 {w}) ({l} 0 {w}) ({l} {h} {w}) (0 {h} {w}) );
blocks ( hex (0 1 2 3 4 5 6 7) ({nx} {ny} {nz}) simpleGrading (1 1 1) );
boundary ( room {{ type wall; faces ( (0 3 2 1) (4 5 6 7) (0 4 7 3) (1 2 6 5) (0 1 5 4) (3 7 6 2) ); }} );
"
        )
}

fn grille_names(u: &Unit) -> Vec<String> {
    (0..u.supplies.len())
        .map(|k| format!("supply{}", k + 1))
        .chain((0..u.returns.len()).map(|k| format!("return{}", k + 1)))
        .collect()
}

fn snappy_dict(input: &CaseInput) -> String {
    let mut geo = String::new();
    let mut refine = String::new();
    if !input.solids.is_empty() {
        geo.push_str("  obstacles.stl { type triSurfaceMesh; name obstacles; }\n");
        refine.push_str("    obstacles { level (1 1); patchInfo { type wall; } }\n");
    }
    for u in &input.units {
        let k = &u.key;
        let names = grille_names(u);
        let regions: String = names
            .iter()
            .map(|r| format!(" {r} {{ name {k}_{r}; }}"))
            .collect();
        let _ = writeln!(
            geo,
            "  {k}.stl {{ type triSurfaceMesh; name {k}; regions {{ walls {{ name {k}_walls; }}{regions} }} }}"
        );
        let levels: String = names
            .iter()
            .map(|r| format!(" {r} {{ level (2 2); patchInfo {{ type patch; }} }}"))
            .collect();
        let _ = writeln!(
            refine,
            "    {k} {{ level (2 2); patchInfo {{ type wall; }} regions {{{levels} }} }}"
        );
    }
    let [lx, ly, lz] = location_in_mesh(input);
    hdr("dictionary", "snappyHexMeshDict", "system") + &format!(
        "
castellatedMesh true; snap false; addLayers false;
geometry {{
{geo}}}
castellatedMeshControls {{
  maxLocalCells 2000000; maxGlobalCells 6000000; minRefinementCells 0; maxLoadUnbalance 0.1; nCellsBetweenLevels 2;
  features ( );
  refinementSurfaces {{
{refine}  }}
  resolveFeatureAngle 30; refinementRegions {{ }};
  locationInMesh ({lx} {ly} {lz}); allowFreeStandingZoneFaces true;
}}
snapControls {{ nSmoothPatch 3; tolerance 2.0; nSolveIter 50; nRelaxIter 5; nFeatureSnapIter 10; implicitFeatureSnap true; explicitFeatureSnap false; multiRegionFeatureSnap false; }}
addLayersControls {{ relativeSizes true; layers {{ }}; expansionRatio 1.0; finalLayerThickness 0.3; minThickness 0.1; nGrow 0; featureAngle 60; nRelaxIter 3; nSmoothSurfaceNormals 1; nSmoothNormals 3; nSmoothThickness 10; maxFaceThicknessRatio 0.5; maxThicknessToMedialRatio 0.3; minMedialAxisAngle 90; nBufferCellsNoExtrude 0; nLayerIter 50; }}
meshQualityControls {{ maxNonOrtho 65; maxBoundarySkewness 20; maxInternalSkewness 4; maxConcave 80; minVol 1e-13; minTetQuality 1e-15; minArea -1; minTwist 0.02; minDeterminant 0.001; minFaceWeight 0.05; minVolRatio 0.01; minTriangleTwist -1; nSmoothScale 4; errorReduction 0.75; relaxed {{ maxNonOrtho 75; }} }}
mergeTolerance 1e-6;
"
    )
}

fn pt(x: i32, y: i32, z: i32) -> String {
    format!("({} {} {})", m(x), m(y), m(z))
}

fn topo_set_dict(input: &CaseInput) -> String {
    let mut s = hdr("dictionary", "topoSetDict", "system") + "actions (\n";
    for r in &input.racks {
        let b = r.zone;
        let _ = writeln!(
            s,
            "  {{ name {}; type cellZoneSet; action new; source boxToCell; box {} {}; }}",
            r.key,
            pt(b[0], b[2], b[4]),
            pt(b[1], b[3], b[5])
        );
    }
    for h in &input.heat {
        let boxes: Vec<String> = h
            .boxes
            .iter()
            .map(|b| format!("{} {}", pt(b[0], b[2], b[4]), pt(b[1], b[3], b[5])))
            .collect();
        let _ = writeln!(
            s,
            "  {{ name {k}; type cellSet; action new; source boxToCell; boxes ({}); }}\n  {{ name {k}; type cellZoneSet; action new; source setToCellZone; set {k}; }}",
            boxes.join(" "),
            k = h.key
        );
    }
    s + ");\n"
}

/// A rack's fan flow, m³/s: the air its heat warms by `rack_delta_t_k`.
pub fn rack_flow_m3s(heat_w: i32, delta_t_k: f64) -> f64 {
    heat_w as f64 / (RHO_CP * delta_t_k)
}

fn fv_options(input: &CaseInput) -> String {
    let mut s = hdr("dictionary", "fvOptions", "constant");
    for r in input.racks.iter().filter(|r| r.heat_w > 0) {
        let z = r.zone;
        let axis = r.front.axis();
        let other: Vec<usize> = (0..3).filter(|&a| a != axis).collect();
        let section: f64 = other.iter().map(|&a| m(z[2 * a + 1] - z[2 * a])).product();
        let ubar = rack_flow_m3s(r.heat_w, input.settings.rack_delta_t_k) / section;
        // Air enters at the front face and leaves at the opposite one.
        let mut v = [0.0f64; 3];
        v[axis] = -r.front.sign() * ubar;
        let _ = writeln!(
            s,
            "{k}Fan {{ type meanVelocityForce; active true; selectionMode cellZone; cellZone {k}; fields (U); Ubar ({:.4} {:.4} {:.4}); relaxation 0.2; }}",
            v[0] + 0.0,
            v[1] + 0.0,
            v[2] + 0.0,
            k = r.key
        );
        let _ = writeln!(
            s,
            "{k}Heat {{ type scalarSemiImplicitSource; active true; selectionMode cellZone; cellZone {k}; volumeMode absolute; injectionRateSuSp {{ T ({:.5} 0); }} }}",
            r.heat_w as f64 / RHO_CP,
            k = r.key
        );
    }
    for h in input.heat.iter().filter(|h| h.heat_w > 0) {
        let _ = writeln!(
            s,
            "{k} {{ type scalarSemiImplicitSource; active true; selectionMode cellZone; cellZone {k}; volumeMode absolute; injectionRateSuSp {{ T ({:.5} 0); }} }}",
            h.heat_w as f64 / RHO_CP,
            k = h.key
        );
    }
    s
}

/// The points the solver logs the temperature at every iteration: each
/// rack's intake band (the same points the result's intake temperatures
/// are sampled at), for the stability check.
pub fn probe_points(input: &CaseInput) -> Vec<[f64; 3]> {
    input
        .racks
        .iter()
        .flat_map(|r| crate::post::intake_points(r))
        .flat_map(|(_, pts)| pts)
        .collect()
}

/// The patches air leaves or enters the room through.
pub fn opening_patches(input: &CaseInput) -> Vec<String> {
    input
        .units
        .iter()
        .flat_map(|u| {
            (0..u.supplies.len())
                .map(|k| supply_patch(u, k))
                .chain((0..u.returns.len()).map(|k| return_patch(u, k)))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Iterations a run is extended by while a band's mean is too uncertain
/// ([`crate::checks`]).
pub const EXTEND_STEP: i32 = 500;

fn gcd(a: i32, b: i32) -> i32 {
    if b == 0 {
        a.abs().max(1)
    } else {
        gcd(b, a % b)
    }
}

/// The iteration the mean starts from. It stays there when a run is
/// extended, so the window grows and its mean gets more certain.
pub fn average_start(input: &CaseInput) -> i32 {
    input.settings.iterations - input.settings.average_last
}

/// `system/controlDict` for a solve that ends at `end`. The result is the
/// mean from [`average_start`] to `end` (`fieldAverage` of U, T and φ);
/// the rack intakes are probed every iteration for the uncertainty of that
/// mean. Fields are written every [`EXTEND_STEP`] (where an extension
/// restarts; the average carries on), only the latest kept.
pub fn control_dict(input: &CaseInput, end: i32) -> String {
    let mut f = String::new();
    let _ = writeln!(
        f,
        "  average {{ type fieldAverage; libs (fieldFunctionObjects); writeControl writeTime; timeStart {}; restartOnRestart false; fields ( U {{ mean on; prime2Mean off; base iteration; }} T {{ mean on; prime2Mean off; base iteration; }} phi {{ mean on; prime2Mean off; base iteration; }} ); }}",
        average_start(input)
    );
    let probes: Vec<String> = probe_points(input)
        .iter()
        .map(|p| format!("({} {} {})", p[0], p[1], p[2]))
        .collect();
    if !probes.is_empty() {
        let _ = writeln!(
            f,
            "  intakes {{ type probes; libs (sampling); writeControl timeStep; writeInterval 1; log false; fields (T); probeLocations ( {} ); }}",
            probes.join(" ")
        );
    }
    let every = gcd(input.settings.iterations, EXTEND_STEP);
    hdr("dictionary", "controlDict", "system")
        + &format!(
            "application buoyantBoussinesqSimpleFoam; startFrom latestTime; startTime 0; stopAt endTime; endTime {end}; deltaT 1;
writeControl timeStep; writeInterval {every}; purgeWrite 1; writeFormat ascii; writePrecision 6; writeCompression off; timeFormat general; timePrecision 6; runTimeModifiable false;
functions {{
{f}}}
"
        )
}

/// `system/decomposeParDict` for `n` processes. `hierarchical`, not
/// `scotch`: scotch in the pinned image splits the same mesh differently
/// from run to run, and the pseudo-steady flow then drifts to means up to
/// 0.8 °C apart. A geometric split repeats exactly, so the same input on
/// the same number of processes gives the same result.
pub fn decompose_par_dict(input: &CaseInput, n: usize) -> String {
    let split = split(n, input.room);
    hdr("dictionary", "decomposeParDict", "system")
        + &format!(
            "numberOfSubdomains {n}; method hierarchical; coeffs {{ n ({} {} {}); order xyz; }}\n",
            split[0], split[1], split[2]
        )
}

/// `n` as a product along x, y, z, each prime factor (largest first) given
/// to the axis whose pieces are then longest.
fn split(n: usize, room: [i32; 3]) -> [usize; 3] {
    let mut factors = vec![];
    let mut m = n.max(1);
    let mut p = 2;
    while m > 1 {
        while m.is_multiple_of(p) {
            factors.push(p);
            m /= p;
        }
        p += 1;
    }
    let mut out = [1usize; 3];
    for f in factors.into_iter().rev() {
        let a = (0..3)
            .max_by(|&a, &b| {
                (room[a] as f64 / out[a] as f64).total_cmp(&(room[b] as f64 / out[b] as f64))
            })
            .unwrap_or(0);
        out[a] *= f;
    }
    out
}

const FV_SCHEMES: &str = r#"FoamFile { version 2.0; format ascii; class dictionary; location "system"; object fvSchemes; }
ddtSchemes { default steadyState; }
gradSchemes { default Gauss linear; grad(U) cellLimited Gauss linear 1; grad(T) cellLimited Gauss linear 1; }
divSchemes { default none; div(phi,U) bounded Gauss linearUpwind grad(U); div(phi,T) bounded Gauss linearUpwind grad(T);
  div(phi,k) bounded Gauss upwind; div(phi,epsilon) bounded Gauss upwind; div((nuEff*dev2(T(grad(U))))) Gauss linear; }
laplacianSchemes { default Gauss linear limited corrected 0.5; }
interpolationSchemes { default linear; }
snGradSchemes { default limited corrected 0.5; }
wallDist { method meshWave; }
"#;

const FV_SOLUTION: &str = r#"FoamFile { version 2.0; format ascii; class dictionary; location "system"; object fvSolution; }
solvers {
  p_rgh { solver GAMG; smoother GaussSeidel; tolerance 1e-7; relTol 0.01; }
  "(U|T|k|epsilon)" { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-7; relTol 0.1; }
}
SIMPLE { momentumPredictor yes; nNonOrthogonalCorrectors 1;
  residualControl { p_rgh 1e-4; U 1e-5; T 1e-5; "(k|epsilon)" 1e-5; } }
relaxationFactors { fields { p_rgh 0.7; } equations { U 0.3; T 0.5; "(k|epsilon)" 0.5; } }
"#;

// --- Fields --------------------------------------------------------------------

/// The boundary entries of one field: walls, supplies, returns.
#[allow(clippy::too_many_arguments)]
fn field(
    input: &CaseInput,
    name: &str,
    class: &str,
    dims: &str,
    internal: &str,
    walls: &str,
    supply: &dyn Fn(&Unit, usize) -> String,
    ret: &str,
) -> String {
    let mut bf = format!("  room {{ {walls} }}\n");
    if !input.solids.is_empty() {
        let _ = writeln!(bf, "  obstacles {{ {walls} }}");
    }
    for u in &input.units {
        let _ = writeln!(bf, "  {}_walls {{ {walls} }}", u.key);
        for k in 0..u.supplies.len() {
            let _ = writeln!(bf, "  {} {{ {} }}", supply_patch(u, k), supply(u, k));
        }
        for k in 0..u.returns.len() {
            let _ = writeln!(bf, "  {} {{ {ret} }}", return_patch(u, k));
        }
    }
    hdr(class, name, "0")
        + &format!(
            "dimensions {dims};\ninternalField uniform {internal};\nboundaryField {{\n{bf}}}\n"
        )
}

/// The velocity of one supply grille: its normal component carries the
/// unit's airflow over the unit's total supply area, tilted down by the
/// pitch and turned by the yaw (vertical faces only).
pub fn supply_velocity(u: &Unit, k: usize, un: f64) -> [f64; 3] {
    let s = &u.supplies[k];
    let n = s.grille.face.normal();
    if s.grille.face.axis() == 1 {
        return n.map(|v| v * un);
    }
    // Right of the jet, seen from behind the unit: n × up.
    let r = [-n[2], 0.0, n[0]];
    let (p, y) = (s.pitch_deg.to_radians(), s.yaw_deg.to_radians());
    let mut v = [0.0; 3];
    for a in 0..3 {
        v[a] = un * n[a] + un * y.tan() * r[a];
    }
    v[1] -= un * p.tan() / y.cos();
    v
}

/// `0/U`. `meshed_area_m2` holds each supply patch's area as meshed (the
/// castellated surface differs from the grille's); a missing patch takes
/// the grille's nominal area.
pub fn u_field(input: &CaseInput, meshed_area_m2: &BTreeMap<String, f64>) -> String {
    let speed: BTreeMap<String, f64> = input
        .units
        .iter()
        .map(|u| {
            let total: f64 = (0..u.supplies.len())
                .map(|k| {
                    meshed_area_m2
                        .get(&supply_patch(u, k))
                        .copied()
                        .unwrap_or(u.supplies[k].grille.area_mm2() / 1e6)
                })
                .sum();
            (u.key.clone(), u.airflow_m3h as f64 / 3600.0 / total)
        })
        .collect();
    let supply = |u: &Unit, k: usize| {
        let v = supply_velocity(u, k, speed[&u.key]);
        format!(
            "type fixedValue; value uniform ({} {} {});",
            v[0] + 0.0,
            v[1] + 0.0,
            v[2] + 0.0
        )
    };
    field(
        input,
        "U",
        "volVectorField",
        "[0 1 -1 0 0 0 0]",
        "(0 0 0)",
        "type noSlip;",
        &supply,
        "type pressureInletOutletVelocity; value uniform (0 0 0);",
    )
}

fn scalar_fields(input: &CaseInput) -> Vec<(String, String)> {
    let ts = 273.15 + input.supply_temp_c;
    let fixed = |v: String| move |_: &Unit, _: usize| v.clone();
    let mut out = vec![];
    let mut add = |name: &str, dims: &str, internal: &str, walls: &str, sup: String, ret: &str| {
        let text = field(
            input,
            name,
            "volScalarField",
            dims,
            internal,
            walls,
            &fixed(sup),
            ret,
        );
        out.push((format!("0/{name}"), text));
    };
    add(
        "T",
        "[0 0 0 1 0 0 0]",
        &T_INIT.to_string(),
        "type zeroGradient;",
        format!("type fixedValue; value uniform {ts:.2};"),
        "type inletOutlet; inletValue uniform 299; value uniform 299;",
    );
    add(
        "p_rgh",
        "[0 2 -2 0 0 0 0]",
        "0",
        "type fixedFluxPressure; value uniform 0;",
        "type fixedFluxPressure; value uniform 0;".into(),
        "type fixedValue; value uniform 0;",
    );
    add(
        "p",
        "[0 2 -2 0 0 0 0]",
        "0",
        "type calculated; value uniform 0;",
        "type calculated; value uniform 0;".into(),
        "type calculated; value uniform 0;",
    );
    add(
        "k",
        "[0 2 -2 0 0 0 0]",
        "0.005",
        "type kqRWallFunction; value uniform 0.005;",
        format!("type fixedValue; value uniform {K_IN};"),
        "type inletOutlet; inletValue uniform 0.005; value uniform 0.005;",
    );
    add(
        "epsilon",
        "[0 2 -3 0 0 0 0]",
        "0.005",
        "type epsilonWallFunction; value uniform 0.005;",
        format!("type fixedValue; value uniform {EPS_IN};"),
        "type inletOutlet; inletValue uniform 0.005; value uniform 0.005;",
    );
    add(
        "nut",
        "[0 2 -1 0 0 0 0]",
        "0",
        "type nutkWallFunction; value uniform 0;",
        "type calculated; value uniform 0;".into(),
        "type calculated; value uniform 0;",
    );
    add(
        "alphat",
        "[0 2 -1 0 0 0 0]",
        "0",
        "type alphatJayatillekeWallFunction; Prt 0.85; value uniform 0;",
        "type calculated; value uniform 0;".into(),
        "type calculated; value uniform 0;",
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn processes_split_along_the_longest_sides() {
        let room = [5545, 2410, 3845];
        assert_eq!(split(12, room), [3, 2, 2]);
        assert_eq!(split(1, room), [1, 1, 1]);
        assert_eq!(split(7, room), [7, 1, 1]);
        for n in 1..=32 {
            assert_eq!(split(n, room).iter().product::<usize>(), n);
        }
    }

    #[test]
    fn the_reference_case_has_every_file() {
        let input = crate::reference::reference_input();
        let files = files(&input);
        let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        for f in [
            "system/blockMeshDict",
            "system/snappyHexMeshDict",
            "system/controlDict",
            "constant/fvOptions",
            "constant/triSurface/u1.stl",
            "0/U",
            "0/T",
            "0/p_rgh",
        ] {
            assert!(names.contains(&f), "{f}");
        }
        let get = |n: &str| &files.iter().find(|(k, _)| k == n).unwrap().1;
        // make_case.py's background mesh: 79 × 34 × 55 cells of 7 cm.
        assert!(get("system/blockMeshDict").contains("(79 34 55)"));
        // The averaging window and the half-window writes.
        let cd = get("system/controlDict");
        assert!(cd.contains("endTime 2000;") && cd.contains("timeStart 1500;"));
        assert!(cd.contains("writeInterval 500;") && cd.contains("purgeWrite 1;"));
        // Rack 1's fan: 3 kW over ΔT 10 K through its 0.5 × 1.88 m section.
        let fv = get("constant/fvOptions");
        assert!(
            fv.contains("r1Fan") && fv.contains("Ubar (0.0000 0.0000 0.2646)"),
            "{fv}"
        );
        // Supply as a fixed velocity, returns as pressure outlets.
        let u = get("0/U");
        assert!(u.contains("u1_supply1 { type fixedValue;"));
        assert!(u.contains("u1_return1 { type pressureInletOutletVelocity;"));
        assert!(get("0/p_rgh").contains("u1_return1 { type fixedValue; value uniform 0; }"));
    }

    #[test]
    fn the_jet_keeps_the_airflow_and_turns_down() {
        let input = crate::reference::reference_input();
        let u = &input.units[0];
        let v = supply_velocity(u, 0, 2.0);
        // Normal component (+z) carries the flow; 30° below horizontal.
        assert!((v[2] - 2.0).abs() < 1e-12);
        assert!((v[1] + 2.0 * 30f64.to_radians().tan()).abs() < 1e-12);
        assert_eq!(v[0], 0.0);
    }
}
