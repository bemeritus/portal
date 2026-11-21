//! The reference case of `dc-handoff/reference/airflow-cfd/make_case.py`
//! as a [`CaseInput`]: the seeded room with the reference's assumptions,
//! including its 22 colocation towers (which the room model does not
//! record). Used to check the port against the re-baselined reference
//! (SPEC §17.1b): `portal-cfd-worker reference-input`.
//!
//! The reference works in metres with sub-millimetre values (2487.5 mm,
//! 13 % of a width); they are rounded to whole millimetres here.

use serde_json::json;

use crate::input::{
    Assumption, Box3, CaseInput, Face, Grille, HeatZone, Rack, Settings, Solid, Src, Supply, Unit,
};

fn r(v: f64) -> i32 {
    v.round() as i32
}

pub fn reference_input() -> CaseInput {
    let (l, h, w) = (5545, 2410, 3845);
    let mut solids: Vec<Solid> = vec![];
    let mut add = |name: &str, b: Box3| {
        solids.push(Solid {
            name: name.into(),
            b,
        })
    };

    // Shelf: two sections of posts and three boards.
    let (s0, sl, sd) = (200.0, 4530.0, 910);
    let split = s0 + sl / 14.0 * 5.0;
    for (a, b) in [(s0, split), (split, s0 + sl)] {
        for x in [a, b - 40.0] {
            for z in [0, sd - 40] {
                let z0 = if z == 0 { -20 } else { z };
                add("shelf_post", [r(x), r(x) + 40, -20, 1795, z0, z + 40]);
            }
        }
    }
    for y in [120, 950, 1795] {
        add("shelf_board", [r(s0), r(s0 + sl), y - 35, y, -20, sd]);
    }

    // The towers, placed as the reference places them; their heat goes into
    // the air behind them.
    let acs = [
        (4005.0, 5255.0, 70),
        (2487.5, 3632.5, 65),
        (297.5, 1442.5, 95),
    ];
    let under_ac = |x: f64| {
        acs.iter()
            .any(|&(a, b, _)| x + 120.0 > a - 30.0 && x - 120.0 < b + 30.0)
    };
    let mut exhausts = vec![];
    let mut seed = 3;
    for (bi, y) in [120, 950, 1795].into_iter().enumerate() {
        for i in 0..14 {
            seed = (seed * 7 + 5) % 97;
            if seed % 6 == 0 {
                continue;
            }
            let xc = s0 + sl / 14.0 * (i as f64 + 0.5);
            if bi == 2 && under_ac(xc) {
                continue;
            }
            let x0 = r(xc - 100.0);
            add("tower", [x0, x0 + 200, y, y + 420, 400, 850]);
            exhausts.push([x0, x0 + 200, y + 50, y + 400, 300, 400]);
        }
    }
    add("locker", [4984, 5490, -20, 1230, -20, 410]);

    // Ducted units under the ceiling, against the wall; supply on the front
    // face, return under the rear half.
    let units = acs
        .iter()
        .enumerate()
        .map(|(i, &(x0f, x1f, gap))| {
            let (x0, x1) = (r(x0f), r(x0f) + r(x1f - x0f));
            let (yb, yt) = (h - gap - 380, h - gap);
            let wf = (x1 - x0) as f64;
            let hf = (yt - yb) as f64;
            Unit {
                key: format!("u{}", i + 1),
                object_id: 0,
                name: format!("Unit {}", i + 1),
                body: [x0, x1, yb, yt, -20, 680],
                supplies: vec![Supply {
                    grille: Grille {
                        face: Face::ZMax,
                        rect: [
                            r(x0 as f64 + 0.13 * wf),
                            r(x1 as f64 - 0.13 * wf),
                            r(yb as f64 + 0.23 * hf),
                            r(yt as f64 - 0.23 * hf),
                        ],
                    },
                    pitch_deg: 30.0,
                    yaw_deg: 0.0,
                }],
                returns: vec![Grille {
                    face: Face::YMin,
                    rect: [r(x0 as f64 + 0.12 * wf), r(x1 as f64 - 0.12 * wf), 80, 320],
                }],
                airflow_m3h: 1100,
            }
        })
        .collect();

    // Racks: solid shell pieces around a fan-driven interior.
    let heat = [3000, 3000, 3000, 1500];
    let mut racks = vec![];
    for (i, &(x0, fz)) in [(530, 2250), (1595, 2260), (2635, 2220), (3435, 2215)]
        .iter()
        .enumerate()
    {
        let (z0, z1) = (fz, fz + 1000);
        add("rack_plinth", [x0, x0 + 600, -20, 100, z0, z1]);
        add("rack_top", [x0, x0 + 600, 1980, 2040, z0, z1]);
        if i != 0 {
            // Rack 1 is an open frame: no side panels.
            add("rack_side", [x0, x0 + 50, 100, 1980, z0, z1]);
            add("rack_side", [x0 + 550, x0 + 600, 100, 1980, z0, z1]);
        }
        racks.push(Rack {
            key: format!("r{}", i + 1),
            object_id: 0,
            name: format!("Rack {}", i + 1),
            body: [x0, x0 + 600, 0, 2040, z0, z1],
            zone: [x0 + 50, x0 + 550, 100, 1980, z0 + 100, z1 - 100],
            front: Face::ZMin,
            heat_w: heat[i],
        });
    }

    let towers = exhausts.len() as i32;
    let a = |key: &str, value: serde_json::Value| Assumption {
        key: key.into(),
        object_id: None,
        subject: None,
        value,
        src: Src::Assumed,
    };
    CaseInput {
        room: [l, h, w],
        solids,
        units,
        racks,
        heat: vec![HeatZone {
            key: "towers".into(),
            name: "towers".into(),
            boxes: exhausts,
            heat_w: towers * 120,
        }],
        supply_temp_c: 17.0,
        settings: Settings::default(),
        assumptions: vec![
            a("unit_airflow_m3h", json!(1100)),
            a("supply_temp_c", json!(17.0)),
            a("deflector_pitch_deg", json!(30)),
            a("unit_return", json!("rear half of the underside")),
            a("rack_heat_w", json!(heat)),
            a("rack_delta_t_k", json!(10.0)),
            a("cell_heat_w", json!(120)),
            a("rack_doors", json!("open")),
            a("walls", json!("adiabatic")),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reference_case_is_valid_and_complete() {
        let c = reference_input();
        c.validate().unwrap();
        // case.json of the reference: 22 towers, 10.5 kW in racks, 2.64 kW
        // on the shelf.
        assert_eq!(c.heat[0].boxes.len(), 22);
        assert_eq!(c.heat_in_w(), 13_140.0);
        assert_eq!(c.units[1].body[..4], [2488, 3633, 1965, 2345]);
        assert_eq!(c.units[0].supplies[0].grille.rect, [4168, 5093, 2047, 2253]);
    }
}
