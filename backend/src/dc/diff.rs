//! What changed between two snapshots of a room — the history page's diff
//! (§8). Pure: entities are matched by id (cells by shelf and number) and
//! compared field by field through their JSON form, so a field added to a type
//! later is diffed without touching this file.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use super::model::Snapshot;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FieldChange {
    pub field: String,
    pub before: Value,
    pub after: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "change", rename_all = "snake_case")]
pub enum EntityChange {
    Added {
        key: String,
        after: Value,
    },
    Removed {
        key: String,
        before: Value,
    },
    Changed {
        key: String,
        name: String,
        fields: Vec<FieldChange>,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct SnapshotDiff {
    pub objects: Vec<EntityChange>,
    pub devices: Vec<EntityChange>,
    pub cells: Vec<EntityChange>,
    pub annotations: Vec<EntityChange>,
}

#[cfg(test)]
impl SnapshotDiff {
    pub fn is_empty(&self) -> bool {
        self.objects.is_empty()
            && self.devices.is_empty()
            && self.cells.is_empty()
            && self.annotations.is_empty()
    }
}

/// Entities keyed for matching. Values are the entity's JSON object.
fn keyed<T: Serialize>(items: &[T], key: impl Fn(&Value) -> String) -> BTreeMap<String, Value> {
    items
        .iter()
        .filter_map(|i| serde_json::to_value(i).ok())
        .map(|v| (key(&v), v))
        .collect()
}

fn by_id(v: &Value) -> String {
    v["id"].to_string()
}

fn by_cell(v: &Value) -> String {
    format!("{}:{}", v["shelf_id"], v["cell_no"])
}

fn compare(before: BTreeMap<String, Value>, after: BTreeMap<String, Value>) -> Vec<EntityChange> {
    let mut out = Vec::new();
    for (k, b) in &before {
        match after.get(k) {
            None => out.push(EntityChange::Removed {
                key: k.clone(),
                before: b.clone(),
            }),
            Some(a) if a != b => {
                let (Value::Object(bo), Value::Object(ao)) = (b, a) else {
                    continue;
                };
                let mut fields: Vec<FieldChange> = ao
                    .iter()
                    .filter(|(f, v)| bo.get(*f) != Some(v))
                    .map(|(f, v)| FieldChange {
                        field: f.clone(),
                        before: bo.get(f).cloned().unwrap_or(Value::Null),
                        after: v.clone(),
                    })
                    .collect();
                fields.sort_by(|x, y| x.field.cmp(&y.field));
                let name = a["name"]
                    .as_str()
                    .or_else(|| a["payload"]["name"].as_str())
                    .or_else(|| a["payload"]["text"].as_str())
                    .unwrap_or("")
                    .to_string();
                out.push(EntityChange::Changed {
                    key: k.clone(),
                    name,
                    fields,
                });
            }
            Some(_) => {}
        }
    }
    for (k, a) in after {
        if !before.contains_key(&k) {
            out.push(EntityChange::Added { key: k, after: a });
        }
    }
    out
}

pub fn diff(before: &Snapshot, after: &Snapshot) -> SnapshotDiff {
    SnapshotDiff {
        objects: compare(keyed(&before.objects, by_id), keyed(&after.objects, by_id)),
        devices: compare(keyed(&before.devices, by_id), keyed(&after.devices, by_id)),
        cells: compare(keyed(&before.cells, by_cell), keyed(&after.cells, by_cell)),
        annotations: compare(
            keyed(&before.annotations, by_id),
            keyed(&after.annotations, by_id),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dc::model::{
        DcObject, Device, DeviceFields, DeviceKind, DeviceStatus, Face, ShelfCell,
    };
    use serde_json::json;

    fn obj(id: i64, name: &str, x0: i32) -> DcObject {
        DcObject {
            id,
            catalog_id: 1,
            name: name.into(),
            x0_mm: x0,
            z0_mm: 0,
            y0_mm: 0,
            rotation_deg: 0,
            instance: json!({}),
            contents_known: false,
            note: Default::default(),
        }
    }

    fn dev(id: i64, name: &str, u: i32) -> Device {
        Device {
            id,
            fields: DeviceFields {
                rack_id: 1,
                u_bottom: u,
                u_height: 1,
                face: Face::Front,
                depth_mm: None,
                kind: DeviceKind::Server,
                name: name.into(),
                owner: String::new(),
                serial: String::new(),
                power_w: None,
                power_src: None,
                status: DeviceStatus::Active,
                note: String::new(),
            },
        }
    }

    #[test]
    fn identical_snapshots_have_no_diff() {
        let s = Snapshot {
            objects: vec![obj(1, "r1", 0)],
            ..Default::default()
        };
        assert!(diff(&s, &s.clone()).is_empty());
    }

    #[test]
    fn a_move_is_one_changed_field() {
        let a = Snapshot {
            objects: vec![obj(1, "r1", 0)],
            ..Default::default()
        };
        let b = Snapshot {
            objects: vec![obj(1, "r1", 10)],
            ..Default::default()
        };
        let d = diff(&a, &b);
        assert_eq!(
            d.objects,
            vec![EntityChange::Changed {
                key: "1".into(),
                name: "r1".into(),
                fields: vec![FieldChange {
                    field: "x0_mm".into(),
                    before: json!(0),
                    after: json!(10)
                }]
            }]
        );
    }

    #[test]
    fn added_and_removed_devices_and_cells() {
        let a = Snapshot {
            devices: vec![dev(1, "old", 1)],
            cells: vec![ShelfCell {
                shelf_id: 5,
                cell_no: 3,
                name: "tower".into(),
                owner: String::new(),
                power_w: None,
                note: String::new(),
            }],
            ..Default::default()
        };
        let b = Snapshot {
            devices: vec![dev(2, "new", 5)],
            ..Default::default()
        };
        let d = diff(&a, &b);
        assert!(matches!(&d.devices[0], EntityChange::Removed { key, .. } if key == "1"));
        assert!(matches!(&d.devices[1], EntityChange::Added { key, .. } if key == "2"));
        assert!(matches!(&d.cells[0], EntityChange::Removed { key, .. } if key == "5:3"));
    }
}
