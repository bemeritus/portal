//! What a revision did, in facts a person can read (FEEDBACK-6 §6): devices
//! added, removed, moved from one place to another, owners changed, objects
//! moved; whether it created the room, imported a file or restored an older
//! revision. Pure: computed from the revision's snapshot and the one before
//! it. The UI turns a digest into a sentence in the user's language, so no
//! stored English summary is ever shown.

use std::collections::HashMap;

use serde::Serialize;

use super::model::{AnnotationPayload, Device, DeviceKind, Snapshot};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RevisionKind {
    /// The room as measured: the first revision.
    Created,
    /// A CSV import of devices.
    Import,
    /// An older revision restored.
    Restore,
    /// Anything else: edits made in the room.
    Edit,
}

/// Where a device sits: rack name and U range.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Place {
    pub rack: String,
    pub u_bottom: i32,
    pub u_height: i32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DeviceAt {
    pub name: String,
    pub kind: DeviceKind,
    #[serde(flatten)]
    pub place: Place,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DeviceMoved {
    pub name: String,
    pub kind: DeviceKind,
    pub from: Place,
    pub to: Place,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OwnerChange {
    pub name: String,
    pub before: String,
    pub after: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Digest {
    pub kind: RevisionKind,
    /// For a restore: the revision whose state came back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored: Option<i32>,
    pub devices_added: Vec<DeviceAt>,
    pub devices_removed: Vec<DeviceAt>,
    pub devices_moved: Vec<DeviceMoved>,
    pub owners: Vec<OwnerChange>,
    /// Devices with other fields changed (name, power, status, …).
    pub devices_changed: Vec<String>,
    pub objects_added: Vec<String>,
    pub objects_removed: Vec<String>,
    /// Objects moved or turned on the floor.
    pub objects_moved: Vec<String>,
    /// Objects with other fields changed.
    pub objects_changed: Vec<String>,
    pub notes_added: usize,
    pub views_added: usize,
    pub annotations_removed: usize,
    pub cells_changed: usize,
}

/// The kind of a revision, from its number and the summary the server wrote.
pub fn kind(revision: i32, summary: &str) -> (RevisionKind, Option<i32>) {
    if revision == 1 {
        return (RevisionKind::Created, None);
    }
    if summary.starts_with("CSV import") {
        return (RevisionKind::Import, None);
    }
    if let Some(n) = summary.strip_prefix("restored revision ") {
        return (RevisionKind::Restore, n.trim().parse().ok());
    }
    (RevisionKind::Edit, None)
}

fn place(d: &Device, racks: &HashMap<i64, String>) -> Place {
    Place {
        rack: racks.get(&d.fields.rack_id).cloned().unwrap_or_default(),
        u_bottom: d.fields.u_bottom,
        u_height: d.fields.u_height,
    }
}

/// What `after` changed against `before` (an empty room for the first).
pub fn digest(revision: i32, summary: &str, before: Option<&Snapshot>, after: &Snapshot) -> Digest {
    let (kind, restored) = kind(revision, summary);
    let empty = Snapshot {
        objects: vec![],
        devices: vec![],
        cells: vec![],
        annotations: vec![],
    };
    let before = before.unwrap_or(&empty);
    let racks: HashMap<i64, String> = before
        .objects
        .iter()
        .chain(&after.objects)
        .map(|o| (o.id, o.name.clone()))
        .collect();
    let mut d = Digest {
        kind,
        restored,
        devices_added: vec![],
        devices_removed: vec![],
        devices_moved: vec![],
        owners: vec![],
        devices_changed: vec![],
        objects_added: vec![],
        objects_removed: vec![],
        objects_moved: vec![],
        objects_changed: vec![],
        notes_added: 0,
        views_added: 0,
        annotations_removed: 0,
        cells_changed: 0,
    };

    let old: HashMap<i64, &Device> = before.devices.iter().map(|x| (x.id, x)).collect();
    let new: HashMap<i64, &Device> = after.devices.iter().map(|x| (x.id, x)).collect();
    let at = |x: &Device| DeviceAt {
        name: x.fields.name.clone(),
        kind: x.fields.kind,
        place: place(x, &racks),
    };
    for x in &after.devices {
        let Some(was) = old.get(&x.id) else {
            d.devices_added.push(at(x));
            continue;
        };
        let (a, b) = (&was.fields, &x.fields);
        if (a.rack_id, a.u_bottom, a.u_height) != (b.rack_id, b.u_bottom, b.u_height) {
            d.devices_moved.push(DeviceMoved {
                name: b.name.clone(),
                kind: b.kind,
                from: place(was, &racks),
                to: place(x, &racks),
            });
        }
        if a.owner != b.owner {
            d.owners.push(OwnerChange {
                name: b.name.clone(),
                before: a.owner.clone(),
                after: b.owner.clone(),
            });
        }
        let mut rest_a = a.clone();
        rest_a.rack_id = b.rack_id;
        rest_a.u_bottom = b.u_bottom;
        rest_a.u_height = b.u_height;
        rest_a.owner = b.owner.clone();
        if rest_a != *b {
            d.devices_changed.push(b.name.clone());
        }
    }
    for x in &before.devices {
        if !new.contains_key(&x.id) {
            d.devices_removed.push(at(x));
        }
    }

    let old_o: HashMap<i64, _> = before.objects.iter().map(|o| (o.id, o)).collect();
    let new_ids: Vec<i64> = after.objects.iter().map(|o| o.id).collect();
    for o in &after.objects {
        match old_o.get(&o.id) {
            None => d.objects_added.push(o.name.clone()),
            Some(was) => {
                let moved = (was.x0_mm, was.z0_mm, was.y0_mm, was.rotation_deg)
                    != (o.x0_mm, o.z0_mm, o.y0_mm, o.rotation_deg);
                if moved {
                    d.objects_moved.push(o.name.clone());
                }
                let mut rest = (*was).clone();
                rest.x0_mm = o.x0_mm;
                rest.z0_mm = o.z0_mm;
                rest.y0_mm = o.y0_mm;
                rest.rotation_deg = o.rotation_deg;
                // Recording a rack's contents is part of importing them.
                if kind == RevisionKind::Import {
                    rest.contents_known = o.contents_known;
                }
                if rest != *o {
                    d.objects_changed.push(o.name.clone());
                }
            }
        }
    }
    for o in &before.objects {
        if !new_ids.contains(&o.id) {
            d.objects_removed.push(o.name.clone());
        }
    }

    let old_a: Vec<i64> = before.annotations.iter().map(|a| a.id).collect();
    let new_a: Vec<i64> = after.annotations.iter().map(|a| a.id).collect();
    for a in &after.annotations {
        if !old_a.contains(&a.id) {
            match a.payload {
                AnnotationPayload::Note(_) => d.notes_added += 1,
                AnnotationPayload::View(_) => d.views_added += 1,
            }
        }
    }
    d.annotations_removed = old_a.iter().filter(|id| !new_a.contains(id)).count();

    let key = |c: &super::model::ShelfCell| (c.shelf_id, c.cell_no);
    let old_c: HashMap<_, _> = before.cells.iter().map(|c| (key(c), c)).collect();
    let new_c: HashMap<_, _> = after.cells.iter().map(|c| (key(c), c)).collect();
    d.cells_changed = after
        .cells
        .iter()
        .filter(|c| old_c.get(&key(c)) != Some(c))
        .count()
        + before
            .cells
            .iter()
            .filter(|c| !new_c.contains_key(&key(c)))
            .count();
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dc::model::{DcObject, DeviceFields, DeviceStatus, Face, Text};
    use serde_json::json;

    fn rack(id: i64, name: &str, x0: i32) -> DcObject {
        DcObject {
            id,
            catalog_id: 1,
            name: name.into(),
            x0_mm: x0,
            z0_mm: 0,
            y0_mm: 0,
            rotation_deg: 0,
            instance: json!({}),
            contents_known: true,
            note: Text::default(),
        }
    }

    fn dev(id: i64, rack_id: i64, u: i32, owner: &str) -> Device {
        Device {
            id,
            fields: DeviceFields {
                rack_id,
                u_bottom: u,
                u_height: 2,
                face: Face::Front,
                depth_mm: None,
                kind: DeviceKind::Server,
                name: format!("srv-{id}"),
                owner: owner.into(),
                serial: String::new(),
                power_w: Some(450),
                power_src: None,
                status: DeviceStatus::Active,
                note: String::new(),
            },
        }
    }

    fn snap(devices: Vec<Device>) -> Snapshot {
        Snapshot {
            objects: vec![rack(1, "Стойка 1", 0), rack(3, "Стойка 3", 2000)],
            devices,
            cells: vec![],
            annotations: vec![],
        }
    }

    #[test]
    fn a_move_between_racks_says_from_where_to_where() {
        let a = snap(vec![dev(7, 1, 18, "A"), dev(8, 1, 20, "A")]);
        let b = snap(vec![dev(7, 3, 30, "A"), dev(8, 3, 32, "B")]);
        let d = digest(25, "2 changes: device.update ×2", Some(&a), &b);
        assert_eq!(d.kind, RevisionKind::Edit);
        assert_eq!(d.devices_moved.len(), 2);
        let m = &d.devices_moved[0];
        assert_eq!((m.from.rack.as_str(), m.from.u_bottom), ("Стойка 1", 18));
        assert_eq!((m.to.rack.as_str(), m.to.u_bottom), ("Стойка 3", 30));
        assert_eq!(
            d.owners,
            vec![OwnerChange {
                name: "srv-8".into(),
                before: "A".into(),
                after: "B".into()
            }]
        );
        // A move and an owner change are not "other" changes.
        assert!(d.devices_changed.is_empty());
    }

    #[test]
    fn kinds_come_from_the_number_and_the_server_summary() {
        assert_eq!(kind(1, "seed"), (RevisionKind::Created, None));
        assert_eq!(
            kind(5, "CSV import: 92 new, 0 updated"),
            (RevisionKind::Import, None)
        );
        assert_eq!(
            kind(6, "restored revision 4"),
            (RevisionKind::Restore, Some(4))
        );
        assert_eq!(kind(7, "Сохранён вид"), (RevisionKind::Edit, None));
        let first = digest(1, "seed", None, &snap(vec![dev(1, 1, 1, "")]));
        assert_eq!(first.kind, RevisionKind::Created);
        assert_eq!(first.devices_added.len(), 1);
    }

    #[test]
    fn an_import_counts_devices_but_not_the_recorded_flag() {
        let mut a = snap(vec![]);
        a.objects[0].contents_known = false;
        let b = snap(vec![dev(1, 1, 1, "A"), dev(2, 1, 3, "A")]);
        let d = digest(2, "CSV import: 2 new, 0 updated", Some(&a), &b);
        assert_eq!(d.devices_added.len(), 2);
        assert!(d.objects_changed.is_empty());
    }
}
