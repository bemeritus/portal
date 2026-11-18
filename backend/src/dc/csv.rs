//! Device inventory as CSV: export, and import with a dry-run diff (§16).
//!
//! The format is `dc-handoff/data/inventory-template.csv`: `;`-separated,
//! UTF-8 with a BOM, one header row, columns
//! `room;rack;face;u_bottom;u_height;kind;name;owner;serial;power_w;power_src;status;note`.
//! Values of `face`, `kind`, `status` and `power_src` are the API's codes in
//! every language; an empty `power_w` means unknown. Headers are written in the
//! exporting user's language and accepted in any of the three on import.
//!
//! Pure: parsing, writing and planning an import against the room's current
//! devices. Applying the plan is `routes::dc`, in one transaction.

use std::collections::HashMap;

use serde::Serialize;

use super::model::{
    Device, DeviceFields, DeviceKind, DeviceStatus, Face, PowerSrc, enum_str, parse_enum,
};
use crate::models::Language;

/// Column keys, in file order.
pub const COLUMNS: [&str; 13] = [
    "room",
    "rack",
    "face",
    "u_bottom",
    "u_height",
    "kind",
    "name",
    "owner",
    "serial",
    "power_w",
    "power_src",
    "status",
    "note",
];

/// Header text per language, in [`COLUMNS`] order.
fn headers(lang: Language) -> [&'static str; 13] {
    match lang {
        Language::En => COLUMNS,
        Language::Ru => [
            "комната",
            "стойка",
            "сторона",
            "юнит_низ",
            "высота_u",
            "тип",
            "название",
            "владелец",
            "серийный_номер",
            "мощность_вт",
            "источник_мощности",
            "статус",
            "примечание",
        ],
        Language::Uz => [
            "xona",
            "stoyka",
            "tomon",
            "pastki_u",
            "balandlik_u",
            "tur",
            "nomi",
            "egasi",
            "seriya_raqami",
            "quvvat_vt",
            "quvvat_manbai",
            "holat",
            "izoh",
        ],
    }
}

/// Which column a header cell names, in any language.
fn column_of(header: &str) -> Option<&'static str> {
    let h = header.trim().to_lowercase();
    [Language::En, Language::Ru, Language::Uz]
        .into_iter()
        .find_map(|l| headers(l).iter().position(|x| *x == h))
        .map(|i| COLUMNS[i])
}

// --- Low-level reading and writing ---------------------------------------------

/// Split `;`-separated text into records, honouring `"…"` quoting with `""`
/// as an escaped quote and newlines inside quotes. Returns each record with
/// the 1-based line it starts on.
pub fn split_records(text: &str) -> Result<Vec<(usize, Vec<String>)>, usize> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = Vec::new();
    let mut field = String::new();
    let mut record: Vec<String> = Vec::new();
    let mut quoted = false;
    let mut line = 1;
    let mut start = 1;
    let mut chars = text.chars().peekable();
    let mut any = false;
    while let Some(c) = chars.next() {
        any = true;
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    field.push('"');
                }
                '"' => quoted = false,
                '\n' => {
                    line += 1;
                    field.push('\n');
                }
                _ => field.push(c),
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            ';' => record.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                record.push(std::mem::take(&mut field));
                out.push((start, std::mem::take(&mut record)));
                line += 1;
                start = line;
                any = false;
            }
            _ => field.push(c),
        }
    }
    if quoted {
        return Err(start);
    }
    if any {
        record.push(field);
        out.push((start, record));
    }
    // Blank lines are not records.
    out.retain(|(_, r)| r.iter().any(|f| !f.trim().is_empty()));
    Ok(out)
}

fn quote(field: &str) -> String {
    if field.contains([';', '"', '\n', '\r']) {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

/// One device as a row of the export, with its rack's name.
pub struct ExportRow<'a> {
    pub rack: &'a str,
    pub device: &'a DeviceFields,
}

/// The inventory file: BOM, localized headers, CRLF line ends (what Excel
/// expects from a `;` file).
pub fn write(room: &str, rows: &[ExportRow<'_>], lang: Language) -> String {
    let mut s = String::from('\u{feff}');
    s.push_str(&headers(lang).join(";"));
    s.push_str("\r\n");
    for r in rows {
        let d = r.device;
        let cells = [
            room.to_string(),
            r.rack.to_string(),
            enum_str(&d.face),
            d.u_bottom.to_string(),
            d.u_height.to_string(),
            enum_str(&d.kind),
            d.name.clone(),
            d.owner.clone(),
            d.serial.clone(),
            d.power_w.map(|p| p.to_string()).unwrap_or_default(),
            d.power_src.map(|p| enum_str(&p)).unwrap_or_default(),
            enum_str(&d.status),
            d.note.clone(),
        ];
        let line: Vec<String> = cells.iter().map(|c| quote(c)).collect();
        s.push_str(&line.join(";"));
        s.push_str("\r\n");
    }
    s
}

// --- Parsing an import -----------------------------------------------------------

/// A problem with the file or one of its rows. `code` is translated by the UI
/// (`dc.import.error.<code>`); `column` and `value` fill it in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RowError {
    pub line: usize,
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

fn err(
    line: usize,
    code: &'static str,
    column: Option<&'static str>,
    value: Option<&str>,
) -> RowError {
    RowError {
        line,
        code,
        column,
        value: value.map(str::to_string),
    }
}

/// One parsed row: the rack by name, the device's fields minus the rack id.
#[derive(Clone, Debug, PartialEq)]
pub struct ImportRow {
    pub line: usize,
    pub room: String,
    pub rack: String,
    pub fields: DeviceFields,
}

/// Parse a whole file. Rows with errors are left out of `rows`; every error is
/// reported, so the user can fix them all in one pass.
pub fn parse(text: &str) -> (Vec<ImportRow>, Vec<RowError>) {
    let records = match split_records(text) {
        Ok(r) => r,
        Err(line) => return (vec![], vec![err(line, "unclosed_quote", None, None)]),
    };
    let Some(((hline, header), body)) = records.split_first() else {
        return (vec![], vec![err(1, "empty_file", None, None)]);
    };
    let mut index: HashMap<&'static str, usize> = HashMap::new();
    let mut errors = Vec::new();
    for (i, h) in header.iter().enumerate() {
        match column_of(h) {
            Some(c) => {
                index.insert(c, i);
            }
            None if h.trim().is_empty() => {}
            None => errors.push(err(*hline, "unknown_column", None, Some(h.trim()))),
        }
    }
    for required in ["rack", "u_bottom", "u_height", "kind", "name"] {
        if !index.contains_key(required) {
            errors.push(err(*hline, "missing_column", Some(required), None));
        }
    }
    if !errors.is_empty() {
        return (vec![], errors);
    }
    let mut rows = Vec::new();
    for (line, rec) in body {
        let line = *line;
        let get = |c: &str| {
            index
                .get(c)
                .and_then(|&i| rec.get(i))
                .map(|s| s.trim())
                .unwrap_or("")
        };
        let before = errors.len();
        let mut int = |c: &'static str, required: bool| -> Option<i32> {
            let v = get(c);
            if v.is_empty() {
                if required {
                    errors.push(err(line, "required", Some(c), None));
                }
                return None;
            }
            match v.parse::<i32>() {
                Ok(n) => Some(n),
                Err(_) => {
                    errors.push(err(line, "not_a_number", Some(c), Some(v)));
                    None
                }
            }
        };
        let u_bottom = int("u_bottom", true);
        let u_height = int("u_height", true);
        let power_w = int("power_w", false);
        let code = |c: &'static str| -> Option<String> {
            let v = get(c);
            (!v.is_empty()).then(|| v.to_lowercase())
        };
        let face = code("face");
        let kind = code("kind");
        let status = code("status");
        let power_src = code("power_src");

        let face = match face.as_deref() {
            None => Some(Face::Front),
            Some(v) => parse_enum::<Face>(v).or_else(|| {
                errors.push(err(line, "bad_value", Some("face"), Some(v)));
                None
            }),
        };
        let kind = match kind.as_deref() {
            None => {
                errors.push(err(line, "required", Some("kind"), None));
                None
            }
            Some(v) => parse_enum::<DeviceKind>(v).or_else(|| {
                errors.push(err(line, "bad_value", Some("kind"), Some(v)));
                None
            }),
        };
        let status = match status.as_deref() {
            None => Some(DeviceStatus::Active),
            Some(v) => parse_enum::<DeviceStatus>(v).or_else(|| {
                errors.push(err(line, "bad_value", Some("status"), Some(v)));
                None
            }),
        };
        let power_src = match power_src.as_deref() {
            None => Some(None),
            Some(v) => match parse_enum::<PowerSrc>(v) {
                Some(p) => Some(Some(p)),
                None => {
                    errors.push(err(line, "bad_value", Some("power_src"), Some(v)));
                    None
                }
            },
        };
        let name = get("name");
        if name.is_empty() {
            errors.push(err(line, "required", Some("name"), None));
        }
        let rack = get("rack");
        if rack.is_empty() {
            errors.push(err(line, "required", Some("rack"), None));
        }
        if let Some(p) = power_w
            && p < 0
        {
            errors.push(err(line, "negative", Some("power_w"), None));
        }
        if let Some(Some(_)) = power_src
            && power_w.is_none()
        {
            errors.push(err(line, "source_without_power", Some("power_src"), None));
        }
        if let (Some(b), Some(h)) = (u_bottom, u_height)
            && (b < 1 || h < 1)
        {
            errors.push(err(line, "bad_units", Some("u_bottom"), None));
        }
        if errors.len() > before {
            continue;
        }
        let (Some(u_bottom), Some(u_height), Some(face), Some(kind), Some(status), Some(power_src)) =
            (u_bottom, u_height, face, kind, status, power_src)
        else {
            continue;
        };
        rows.push(ImportRow {
            line,
            room: get("room").to_string(),
            rack: rack.to_string(),
            fields: DeviceFields {
                rack_id: 0,
                u_bottom,
                u_height,
                face,
                depth_mm: None,
                kind,
                name: name.to_string(),
                owner: get("owner").to_string(),
                serial: get("serial").to_string(),
                power_w,
                power_src,
                status,
                note: get("note").to_string(),
            },
        });
    }
    (rows, errors)
}

// --- Planning an import against the room -----------------------------------------

/// A rack of the room, for matching rows by name.
#[derive(Clone, Debug)]
pub struct RackRef {
    pub id: i64,
    pub name: String,
    pub units: i32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "action")]
pub enum Change {
    /// A new device.
    Create {
        line: usize,
        rack: String,
        after: DeviceFields,
    },
    /// A device already at that rack, face and bottom unit, with new values.
    Update {
        line: usize,
        rack: String,
        id: i64,
        before: DeviceFields,
        after: DeviceFields,
    },
    /// Already exactly as in the file.
    Unchanged { line: usize, rack: String, id: i64 },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Plan {
    pub changes: Vec<Change>,
    pub errors: Vec<RowError>,
}

impl Plan {
    pub fn counts(&self) -> (usize, usize, usize) {
        let mut c = (0, 0, 0);
        for ch in &self.changes {
            match ch {
                Change::Create { .. } => c.0 += 1,
                Change::Update { .. } => c.1 += 1,
                Change::Unchanged { .. } => c.2 += 1,
            }
        }
        c
    }
}

/// Match rows to the room: a row whose rack, face and bottom unit equal an
/// existing device's updates it, any other row creates a device. Nothing is
/// deleted by an import. Every row is checked against the rack's units and
/// for overlaps with the existing devices and with the other rows, exactly as
/// the database would; a plan with errors is not applied at all.
pub fn plan(room_name: &str, rows: Vec<ImportRow>, racks: &[RackRef], devices: &[Device]) -> Plan {
    let mut out = Plan::default();
    let by_name: HashMap<&str, &RackRef> = racks.iter().map(|r| (r.name.as_str(), r)).collect();
    // The devices as they will be after the import: existing ones (possibly
    // updated) and new ones, for the overlap check.
    let mut after: Vec<(Option<i64>, usize, DeviceFields)> = devices
        .iter()
        .map(|d| (Some(d.id), 0, d.fields.clone()))
        .collect();
    let mut planned: Vec<(usize, Change)> = Vec::new();

    for row in rows {
        if !row.room.is_empty() && row.room != room_name {
            out.errors
                .push(err(row.line, "other_room", Some("room"), Some(&row.room)));
            continue;
        }
        let Some(rack) = by_name.get(row.rack.as_str()) else {
            out.errors
                .push(err(row.line, "unknown_rack", Some("rack"), Some(&row.rack)));
            continue;
        };
        let mut fields = row.fields;
        fields.rack_id = rack.id;
        if fields.u_bottom + fields.u_height - 1 > rack.units {
            out.errors
                .push(err(row.line, "beyond_rack", Some("u_height"), None));
            continue;
        }
        let existing = after.iter().position(|(id, _, f)| {
            id.is_some()
                && f.rack_id == rack.id
                && f.face == fields.face
                && f.u_bottom == fields.u_bottom
        });
        if let Some(i) = existing
            && after[i].1 != 0
        {
            // A second row for the same device.
            out.errors.push(err(row.line, "duplicate_row", None, None));
            continue;
        }
        let change = match existing {
            Some(i) => {
                let (Some(id), _, before) = after[i].clone() else {
                    unreachable!("matched rows have an id")
                };
                let mut next = fields.clone();
                // The file has no depth column; keep what is recorded.
                next.depth_mm = before.depth_mm;
                after[i] = (Some(id), row.line, next.clone());
                if before == next {
                    Change::Unchanged {
                        line: row.line,
                        rack: rack.name.clone(),
                        id,
                    }
                } else {
                    Change::Update {
                        line: row.line,
                        rack: rack.name.clone(),
                        id,
                        before,
                        after: next,
                    }
                }
            }
            None => {
                after.push((None, row.line, fields.clone()));
                Change::Create {
                    line: row.line,
                    rack: rack.name.clone(),
                    after: fields,
                }
            }
        };
        planned.push((row.line, change));
    }

    // Overlaps, once every row has a place.
    for (i, (_, line_a, a)) in after.iter().enumerate() {
        for (_, line_b, b) in after.iter().skip(i + 1) {
            let clash = a.rack_id == b.rack_id
                && a.face.conflicts(b.face)
                && a.u_bottom < b.u_bottom + b.u_height
                && b.u_bottom < a.u_bottom + a.u_height;
            if !clash {
                continue;
            }
            // Report it on the file's line; between two existing devices it
            // cannot happen (the database forbids it).
            let line = (*line_b).max(*line_a);
            let other = if *line_b == line { &a.name } else { &b.name };
            out.errors.push(err(line, "overlap", None, Some(other)));
        }
    }
    out.errors.sort_by_key(|e| e.line);
    out.errors.dedup();
    out.changes = planned.into_iter().map(|(_, c)| c).collect();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEMPLATE: &str = include_str!("../../seeds/dc/inventory-template.csv");

    fn racks() -> Vec<RackRef> {
        (1..=4)
            .map(|i| RackRef {
                id: i,
                name: format!("Стойка {i}"),
                units: 42,
            })
            .collect()
    }

    #[test]
    fn the_template_parses() {
        let (rows, errors) = parse(TEMPLATE);
        assert_eq!(errors, vec![]);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].rack, "Стойка 2");
        assert_eq!(rows[0].fields.kind, DeviceKind::Ups);
        assert_eq!(rows[0].fields.power_w, Some(900));
        assert_eq!(rows[0].fields.power_src, Some(PowerSrc::Nameplate));
        // Empty power is unknown, not zero.
        assert_eq!(rows[2].fields.power_w, None);
        assert_eq!(
            rows[2].fields.note,
            "мощность неизвестна — оставьте пусто, не 0"
        );
    }

    #[test]
    fn quotes_semicolons_and_newlines_survive() {
        let text = "rack;u_bottom;u_height;kind;name;note\r\nСтойка 1;1;1;server;\"A; B\";\"say \"\"hi\"\"\nthere\"\n";
        let (rows, errors) = parse(text);
        assert_eq!(errors, vec![]);
        assert_eq!(rows[0].fields.name, "A; B");
        assert_eq!(rows[0].fields.note, "say \"hi\"\nthere");
    }

    #[test]
    fn headers_in_any_language_and_order() {
        let text = "название;тип;стойка;высота_u;юнит_низ\nX;switch;Стойка 1;1;40\n";
        let (rows, errors) = parse(text);
        assert_eq!(errors, vec![]);
        assert_eq!(rows[0].fields.u_bottom, 40);
        assert_eq!(rows[0].fields.face, Face::Front);
        let text = "nomi;tur;stoyka;balandlik_u;pastki_u\nX;switch;Стойка 1;1;40\n";
        assert!(parse(text).1.is_empty());
    }

    #[test]
    fn every_bad_cell_is_reported() {
        let text = "rack;u_bottom;u_height;kind;name;power_w;power_src;face\n\
                    Стойка 1;x;1;toaster;;-5;measured;side\n";
        let (rows, errors) = parse(text);
        assert!(rows.is_empty());
        let codes: Vec<_> = errors.iter().map(|e| (e.code, e.column)).collect();
        assert!(codes.contains(&("not_a_number", Some("u_bottom"))));
        assert!(codes.contains(&("bad_value", Some("kind"))));
        assert!(codes.contains(&("bad_value", Some("face"))));
        assert!(codes.contains(&("required", Some("name"))));
        assert!(codes.contains(&("negative", Some("power_w"))));
        assert!(errors.iter().all(|e| e.line == 2));
    }

    #[test]
    fn missing_and_unknown_columns() {
        let (_, errors) = parse("rack;colour\n");
        let codes: Vec<_> = errors.iter().map(|e| e.code).collect();
        assert!(codes.contains(&"unknown_column"));
        assert!(codes.contains(&"missing_column"));
    }

    #[test]
    fn export_round_trips_through_import() {
        let (rows, _) = parse(TEMPLATE);
        let export: Vec<ExportRow> = rows
            .iter()
            .map(|r| ExportRow {
                rack: &r.rack,
                device: &r.fields,
            })
            .collect();
        for lang in [Language::Ru, Language::Uz, Language::En] {
            let text = write("Серверная", &export, lang);
            assert!(text.starts_with('\u{feff}'));
            let (again, errors) = parse(&text);
            assert_eq!(errors, vec![]);
            assert_eq!(
                again.iter().map(|r| &r.fields).collect::<Vec<_>>(),
                rows.iter().map(|r| &r.fields).collect::<Vec<_>>()
            );
        }
    }

    fn existing(id: i64, rack: i64, u: i32, h: i32, name: &str) -> Device {
        Device {
            id,
            fields: DeviceFields {
                rack_id: rack,
                u_bottom: u,
                u_height: h,
                face: Face::Front,
                depth_mm: Some(700),
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
    fn plan_creates_updates_and_leaves_alone() {
        let text = "room;rack;u_bottom;u_height;kind;name;power_w\n\
                    Серверная;Стойка 1;1;1;server;Old;\n\
                    Серверная;Стойка 1;10;2;server;Renamed;450\n\
                    ;Стойка 2;5;1;switch;New;\n";
        let (rows, errors) = parse(text);
        assert!(errors.is_empty());
        let devices = vec![existing(7, 1, 1, 1, "Old"), existing(8, 1, 10, 2, "Before")];
        let p = plan("Серверная", rows, &racks(), &devices);
        assert_eq!(p.errors, vec![]);
        assert_eq!(p.counts(), (1, 1, 1));
        match &p.changes[1] {
            Change::Update {
                id, before, after, ..
            } => {
                assert_eq!(*id, 8);
                assert_eq!(before.name, "Before");
                assert_eq!(after.name, "Renamed");
                assert_eq!(after.power_w, Some(450));
                // Depth is not in the file and is kept.
                assert_eq!(after.depth_mm, Some(700));
            }
            other => panic!("expected an update, got {other:?}"),
        }
    }

    #[test]
    fn plan_refuses_overlaps_unknown_racks_and_other_rooms() {
        let text = "room;rack;u_bottom;u_height;kind;name\n\
                    ;Стойка 1;2;2;server;Clashes with existing\n\
                    ;Стойка 2;1;2;server;A\n\
                    ;Стойка 2;2;1;server;Clashes with A\n\
                    ;Стойка 9;1;1;server;No such rack\n\
                    Другая;Стойка 1;30;1;server;Other room\n\
                    ;Стойка 3;42;2;server;Too tall\n";
        let (rows, _) = parse(text);
        let devices = vec![existing(7, 1, 1, 2, "Existing")];
        let p = plan("Серверная", rows, &racks(), &devices);
        let codes: Vec<_> = p.errors.iter().map(|e| (e.line, e.code)).collect();
        assert_eq!(
            codes,
            vec![
                (2, "overlap"),
                (4, "overlap"),
                (5, "unknown_rack"),
                (6, "other_room"),
                (7, "beyond_rack")
            ]
        );
    }

    #[test]
    fn rear_and_front_share_units() {
        let text = "rack;face;u_bottom;u_height;kind;name\nСтойка 1;rear;1;1;patch;Rear patch\n";
        let (rows, _) = parse(text);
        let p = plan("x", rows, &racks(), &[existing(7, 1, 1, 1, "Front")]);
        assert_eq!(p.errors, vec![]);
        assert_eq!(p.counts(), (1, 0, 0));
    }
}
