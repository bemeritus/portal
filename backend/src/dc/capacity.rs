//! "Where can a 2U, 450 W server go?" — the capacity finder (§1, §11.1).
//!
//! Pure: given each rack's units and devices, a requested height, face and
//! power, list the racks with a free contiguous range and rank them.
//!
//! Ranking, most suitable first:
//! 1. racks where the power fits the budget (or no budget/power to check),
//!    before racks that would exceed it;
//! 2. racks whose recorded power is complete, before racks with devices of
//!    unknown power (their headroom is not known);
//! 3. best fit: the smallest free run that still holds the device, so large
//!    runs stay free for large devices;
//! 4. lower recorded load;
//! 5. rack name.
//!
//! Within a rack the suggestion is the bottom of the best-fitting run.
//! A rack whose contents were never recorded is not a candidate: an
//! unrecorded rack is not an empty one.

use serde::Serialize;

use super::model::Face;

/// One device as the finder sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct Mounted {
    pub u_bottom: i32,
    pub u_height: i32,
    pub face: Face,
    pub power_w: Option<i32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RackState {
    pub id: i64,
    pub name: String,
    pub units: i32,
    pub contents_known: bool,
    pub devices: Vec<Mounted>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Request {
    pub u: i32,
    pub face: Face,
    pub power_w: Option<i32>,
}

/// Units `from..=to`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Range {
    pub from: i32,
    pub to: i32,
}

impl Range {
    pub fn units(&self) -> i32 {
        self.to - self.from + 1
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Candidate {
    pub rack_id: i64,
    pub rack_name: String,
    /// Where to put it: the bottom of the best-fitting run.
    pub suggestion: Range,
    /// Every free run on the requested face long enough for the device.
    pub ranges: Vec<Range>,
    pub free_units: i32,
    /// Σ known `power_w` in the rack.
    pub used_power_w: i32,
    /// Devices in the rack whose power is unknown.
    pub unknown_power: i32,
    pub budget_w: Option<i32>,
    /// `budget − used − requested`; `None` without a budget.
    pub headroom_w: Option<i32>,
    /// `None` when there is no budget or no requested power to compare.
    pub fits_power: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Answer {
    pub candidates: Vec<Candidate>,
    /// Racks whose contents were never recorded.
    pub not_recorded: Vec<String>,
    /// Recorded racks with no run long enough.
    pub no_space: Vec<String>,
}

/// Units taken on `face` (front sees front and both, rear sees rear and both,
/// both sees everything), as a bitmap indexed by unit − 1.
fn taken(rack: &RackState, face: Face) -> Vec<bool> {
    let mut t = vec![false; rack.units.max(0) as usize];
    for d in &rack.devices {
        if !d.face.conflicts(face) {
            continue;
        }
        for u in d.u_bottom..d.u_bottom + d.u_height {
            if (1..=rack.units).contains(&u) {
                t[(u - 1) as usize] = true;
            }
        }
    }
    t
}

/// Maximal runs of free units on `face`, bottom to top.
pub fn free_runs(rack: &RackState, face: Face) -> Vec<Range> {
    let t = taken(rack, face);
    let mut out = Vec::new();
    let mut start: Option<i32> = None;
    for (i, &busy) in t.iter().enumerate() {
        let u = i as i32 + 1;
        match (busy, start) {
            (false, None) => start = Some(u),
            (true, Some(s)) => {
                out.push(Range { from: s, to: u - 1 });
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        out.push(Range {
            from: s,
            to: rack.units,
        });
    }
    out
}

pub fn find(racks: &[RackState], req: Request, budget_w: Option<i32>) -> Answer {
    let mut answer = Answer::default();
    for rack in racks {
        if !rack.contents_known {
            answer.not_recorded.push(rack.name.clone());
            continue;
        }
        let runs = free_runs(rack, req.face);
        let fitting: Vec<Range> = runs
            .iter()
            .copied()
            .filter(|r| r.units() >= req.u)
            .collect();
        let Some(best) = fitting.iter().min_by_key(|r| (r.units(), r.from)).copied() else {
            answer.no_space.push(rack.name.clone());
            continue;
        };
        let used_power_w = rack.devices.iter().filter_map(|d| d.power_w).sum();
        let unknown_power = rack.devices.iter().filter(|d| d.power_w.is_none()).count() as i32;
        let headroom_w = budget_w.map(|b| b - used_power_w - req.power_w.unwrap_or(0));
        let fits_power = match (budget_w, req.power_w) {
            (Some(_), Some(_)) => headroom_w.map(|h| h >= 0),
            _ => None,
        };
        answer.candidates.push(Candidate {
            rack_id: rack.id,
            rack_name: rack.name.clone(),
            suggestion: Range {
                from: best.from,
                to: best.from + req.u - 1,
            },
            free_units: runs.iter().map(Range::units).sum(),
            ranges: fitting,
            used_power_w,
            unknown_power,
            budget_w,
            headroom_w,
            fits_power,
        });
    }
    answer.candidates.sort_by(|a, b| {
        let key = |c: &Candidate| {
            let best = c.ranges.iter().map(Range::units).min().unwrap_or(i32::MAX);
            (
                c.fits_power == Some(false),
                c.unknown_power > 0,
                best,
                c.used_power_w,
                c.rack_name.clone(),
            )
        };
        key(a).cmp(&key(b))
    });
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(u: i32, h: i32, face: Face, p: Option<i32>) -> Mounted {
        Mounted {
            u_bottom: u,
            u_height: h,
            face,
            power_w: p,
        }
    }

    fn rack(id: i64, name: &str, devices: Vec<Mounted>) -> RackState {
        RackState {
            id,
            name: name.into(),
            units: 42,
            contents_known: true,
            devices,
        }
    }

    fn req(u: i32, face: Face, power_w: Option<i32>) -> Request {
        Request { u, face, power_w }
    }

    #[test]
    fn an_empty_rack_is_one_run() {
        let r = rack(1, "a", vec![]);
        assert_eq!(free_runs(&r, Face::Front), vec![Range { from: 1, to: 42 }]);
    }

    #[test]
    fn runs_respect_faces() {
        // 1-2 front, 10 rear, 20-21 both.
        let r = rack(
            1,
            "a",
            vec![
                dev(1, 2, Face::Front, None),
                dev(10, 1, Face::Rear, None),
                dev(20, 2, Face::Both, None),
            ],
        );
        assert_eq!(
            free_runs(&r, Face::Front),
            vec![Range { from: 3, to: 19 }, Range { from: 22, to: 42 }]
        );
        assert_eq!(
            free_runs(&r, Face::Rear),
            vec![
                Range { from: 1, to: 9 },
                Range { from: 11, to: 19 },
                Range { from: 22, to: 42 }
            ]
        );
        assert_eq!(
            free_runs(&r, Face::Both),
            vec![
                Range { from: 3, to: 9 },
                Range { from: 11, to: 19 },
                Range { from: 22, to: 42 }
            ]
        );
    }

    #[test]
    fn best_fit_takes_the_smallest_run_that_holds_the_device() {
        // Free: 1-2 (2U), 5-7 (3U), 10-42 (33U).
        let r = rack(
            1,
            "a",
            vec![
                dev(3, 2, Face::Front, Some(100)),
                dev(8, 2, Face::Front, Some(100)),
            ],
        );
        let a = find(&[r], req(2, Face::Front, None), None);
        assert_eq!(a.candidates[0].suggestion, Range { from: 1, to: 2 });
        let r = rack(
            1,
            "a",
            vec![
                dev(3, 2, Face::Front, Some(100)),
                dev(8, 2, Face::Front, Some(100)),
            ],
        );
        let a = find(&[r], req(3, Face::Front, None), None);
        assert_eq!(a.candidates[0].suggestion, Range { from: 5, to: 7 });
        assert_eq!(a.candidates[0].ranges.len(), 2);
    }

    #[test]
    fn full_and_unrecorded_racks_are_reported_not_ranked() {
        let full = rack(1, "full", vec![dev(1, 42, Face::Front, Some(10))]);
        let mut unknown = rack(2, "unknown", vec![]);
        unknown.contents_known = false;
        let free = rack(3, "free", vec![]);
        let a = find(&[full, unknown, free], req(1, Face::Front, None), None);
        assert_eq!(a.no_space, vec!["full"]);
        assert_eq!(a.not_recorded, vec!["unknown"]);
        assert_eq!(a.candidates.len(), 1);
        assert_eq!(a.candidates[0].rack_name, "free");
    }

    #[test]
    fn over_budget_racks_go_last() {
        // Budget 2000 W, asking for 450 W.
        let busy = rack(1, "busy", vec![dev(1, 2, Face::Front, Some(1800))]);
        let light = rack(2, "light", vec![dev(1, 30, Face::Front, Some(300))]);
        let a = find(&[busy, light], req(2, Face::Front, Some(450)), Some(2000));
        let names: Vec<_> = a.candidates.iter().map(|c| c.rack_name.as_str()).collect();
        assert_eq!(names, ["light", "busy"]);
        assert_eq!(a.candidates[0].headroom_w, Some(2000 - 300 - 450));
        assert_eq!(a.candidates[0].fits_power, Some(true));
        assert_eq!(a.candidates[1].fits_power, Some(false));
    }

    #[test]
    fn unknown_power_ranks_after_known_and_is_never_zero() {
        let unknown = rack(1, "unknown-power", vec![dev(1, 1, Face::Front, None)]);
        let known = rack(2, "known", vec![dev(1, 1, Face::Front, Some(900))]);
        let a = find(
            &[unknown, known],
            req(1, Face::Front, Some(100)),
            Some(5000),
        );
        let names: Vec<_> = a.candidates.iter().map(|c| c.rack_name.as_str()).collect();
        assert_eq!(names, ["known", "unknown-power"]);
        assert_eq!(a.candidates[1].unknown_power, 1);
        assert_eq!(a.candidates[1].used_power_w, 0);
    }

    #[test]
    fn without_a_budget_power_is_not_judged() {
        let r = rack(1, "a", vec![]);
        let a = find(&[r], req(1, Face::Front, Some(450)), None);
        assert_eq!(a.candidates[0].fits_power, None);
        assert_eq!(a.candidates[0].headroom_w, None);
    }

    #[test]
    fn ties_fall_back_to_load_then_name() {
        let b = rack(1, "b", vec![dev(40, 3, Face::Front, Some(100))]);
        let a2 = rack(2, "a", vec![dev(40, 3, Face::Front, Some(100))]);
        let c = rack(3, "c", vec![dev(40, 3, Face::Front, Some(50))]);
        let a = find(&[b, a2, c], req(1, Face::Front, None), None);
        let names: Vec<_> = a.candidates.iter().map(|c| c.rack_name.as_str()).collect();
        assert_eq!(names, ["c", "a", "b"]);
    }
}
