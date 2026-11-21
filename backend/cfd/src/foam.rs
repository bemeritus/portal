//! A minimal reader for OpenFOAM's ASCII files: the mesh (points, faces,
//! owner, neighbour, boundary) and the internal values of a field. A port
//! of `foamread.py`; no OpenFOAM utilities or function objects needed.

use std::collections::BTreeMap;
use std::path::Path;

fn read(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// The text after the `FoamFile { … }` header, comments removed.
fn body(text: &str) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('/') {
        out.push_str(&rest[..i]);
        let r = &rest[i..];
        rest = if let Some(c) = r.strip_prefix("/*") {
            c.find("*/").map(|j| &c[j + 2..]).unwrap_or("")
        } else if let Some(c) = r.strip_prefix("//") {
            c.find('\n').map(|j| &c[j..]).unwrap_or("")
        } else {
            out.push('/');
            &r[1..]
        };
    }
    out.push_str(rest);
    let i = out.find("FoamFile").ok_or("no FoamFile header")?;
    let j = out[i..].find('}').ok_or("unterminated header")? + i;
    Ok(out[j + 1..].to_string())
}

/// The first `N (` list at or after `from`: its length and where its
/// contents start.
fn list_start(b: &str, from: usize) -> Result<(usize, usize), String> {
    let bytes = b.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric()) {
            let s = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            let mut k = i;
            while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                k += 1;
            }
            if k < bytes.len() && bytes[k] == b'(' {
                let n = b[s..i].parse().map_err(|e| format!("list size: {e}"))?;
                return Ok((n, k + 1));
            }
        } else {
            i += 1;
        }
    }
    Err("no list found".into())
}

/// `n` numbers from `s`, ignoring parentheses.
fn numbers<T: std::str::FromStr>(s: &str, n: usize) -> Result<Vec<T>, String> {
    let mut out = Vec::with_capacity(n);
    for tok in s
        .split(|c: char| c.is_ascii_whitespace() || c == '(' || c == ')')
        .filter(|t| !t.is_empty())
    {
        if out.len() == n {
            break;
        }
        out.push(tok.parse().map_err(|_| format!("not a number: {tok}"))?);
    }
    if out.len() < n {
        return Err(format!("expected {n} numbers, found {}", out.len()));
    }
    Ok(out)
}

pub struct Mesh {
    pub points: Vec<[f64; 3]>,
    pub faces: Vec<Vec<usize>>,
    pub owner: Vec<usize>,
    pub neighbour: Vec<usize>,
    /// Patch name → (start face, number of faces).
    pub patches: BTreeMap<String, (usize, usize)>,
}

impl Mesh {
    pub fn read(case: &Path) -> Result<Mesh, String> {
        let dir = case.join("constant/polyMesh");
        let b = body(&read(&dir.join("points"))?)?;
        let (n, at) = list_start(&b, 0)?;
        let flat: Vec<f64> = numbers(&b[at..], n * 3)?;
        let points = flat.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();

        let b = body(&read(&dir.join("faces"))?)?;
        let (n, at) = list_start(&b, 0)?;
        let mut faces = Vec::with_capacity(n);
        let mut rest = &b[at..];
        for _ in 0..n {
            let open = rest.find('(').ok_or("short face list")?;
            let close = rest[open..].find(')').ok_or("short face list")? + open;
            let count: usize = rest[..open].trim().parse().map_err(|_| "face size")?;
            faces.push(numbers(&rest[open + 1..close], count)?);
            rest = &rest[close + 1..];
        }

        let labels = |name: &str| -> Result<Vec<usize>, String> {
            let b = body(&read(&dir.join(name))?)?;
            let (n, at) = list_start(&b, 0)?;
            numbers(&b[at..], n)
        };
        let owner = labels("owner")?;
        let neighbour = labels("neighbour")?;

        let b = body(&read(&dir.join("boundary"))?)?;
        let mut patches = BTreeMap::new();
        let (_, mut at) = list_start(&b, 0)?;
        while let Some(open) = b[at..].find('{') {
            let open = open + at;
            let close = b[open..].find('}').ok_or("unterminated patch")? + open;
            let name = b[at..open]
                .split_whitespace()
                .last()
                .unwrap_or("")
                .to_string();
            let entry = |key: &str| -> Option<usize> {
                let d = &b[open + 1..close];
                let i = d.find(key)?;
                d[i + key.len()..].split(';').next()?.trim().parse().ok()
            };
            if let (Some(s), Some(n)) = (entry("startFace"), entry("nFaces")) {
                patches.insert(name, (s, n));
            }
            at = close + 1;
        }
        Ok(Mesh {
            points,
            faces,
            owner,
            neighbour,
            patches,
        })
    }

    pub fn n_cells(&self) -> usize {
        self.owner
            .iter()
            .chain(&self.neighbour)
            .max()
            .map_or(0, |m| m + 1)
    }

    fn face_centre(&self, f: &[usize]) -> [f64; 3] {
        let mut c = [0.0; 3];
        for &p in f {
            for (ca, pa) in c.iter_mut().zip(self.points[p]) {
                *ca += pa;
            }
        }
        c.map(|v| v / f.len() as f64)
    }

    /// Cell centres as the mean of their faces' centres (`foamread.py`).
    pub fn cell_centres(&self) -> Vec<[f64; 3]> {
        let n = self.n_cells();
        let mut sum = vec![[0.0; 3]; n];
        let mut count = vec![0u32; n];
        for (i, f) in self.faces.iter().enumerate() {
            let fc = self.face_centre(f);
            let mut add = |c: usize| {
                for a in 0..3 {
                    sum[c][a] += fc[a];
                }
                count[c] += 1;
            };
            add(self.owner[i]);
            if let Some(&nb) = self.neighbour.get(i) {
                add(nb);
            }
        }
        sum.iter()
            .zip(&count)
            .map(|(s, &c)| s.map(|v| v / c.max(1) as f64))
            .collect()
    }

    /// The sum of a patch's face area vectors, m² (`bc.py`).
    pub fn patch_area(&self, name: &str) -> Option<[f64; 3]> {
        let &(start, n) = self.patches.get(name)?;
        let mut total = [0.0; 3];
        for f in &self.faces[start..start + n] {
            let c = self.face_centre(f);
            for i in 0..f.len() {
                let p = self.points[f[i]];
                let q = self.points[f[(i + 1) % f.len()]];
                let (u, v) = (sub(p, c), sub(q, c));
                let x = [
                    u[1] * v[2] - u[2] * v[1],
                    u[2] * v[0] - u[0] * v[2],
                    u[0] * v[1] - u[1] * v[0],
                ];
                for a in 0..3 {
                    total[a] += x[a] / 2.0;
                }
            }
        }
        Some(total)
    }
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// The internal values of a scalar field.
pub fn scalar_field(path: &Path) -> Result<Vec<f64>, String> {
    let b = body(&read(path)?)?;
    let at = internal_list(&b)?;
    let (n, start) = list_start(&b, at)?;
    numbers(&b[start..], n)
}

/// The internal values of a vector field.
pub fn vector_field(path: &Path) -> Result<Vec<[f64; 3]>, String> {
    let b = body(&read(path)?)?;
    let at = internal_list(&b)?;
    let (n, start) = list_start(&b, at)?;
    let flat: Vec<f64> = numbers(&b[start..], n * 3)?;
    Ok(flat.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect())
}

/// The values of a scalar field on one patch (`n` faces).
pub fn patch_scalars(path: &Path, patch: &str, n: usize) -> Result<Vec<f64>, String> {
    let b = body(&read(path)?)?;
    let bf = b.find("boundaryField").ok_or("no boundaryField")?;
    let mut at = bf;
    let block = loop {
        let i = b[at..]
            .find(patch)
            .map(|i| i + at)
            .ok_or_else(|| format!("no patch {patch}"))?;
        let before = b[..i].chars().next_back().unwrap_or(' ');
        let after = b[i + patch.len()..].trim_start();
        if before.is_whitespace() && after.starts_with('{') {
            let open = b[i..].find('{').unwrap() + i;
            let close = b[open..].find('}').ok_or("unterminated patch")? + open;
            break &b[open + 1..close];
        }
        at = i + patch.len();
    };
    let v = block
        .find("value")
        .map(|i| block[i + "value".len()..].trim_start())
        .ok_or_else(|| format!("{patch}: no value"))?;
    if let Some(u) = v.strip_prefix("uniform") {
        let x: f64 = u
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .parse()
            .map_err(|_| format!("{patch}: bad value"))?;
        return Ok(vec![x; n]);
    }
    let (count, start) = list_start(v, 0)?;
    if count != n {
        return Err(format!("{patch}: {count} values for {n} faces"));
    }
    numbers(&v[start..], n)
}

fn internal_list(b: &str) -> Result<usize, String> {
    let i = b.find("internalField").ok_or("no internalField")?;
    let rest = &b[i + "internalField".len()..];
    if rest.trim_start().starts_with("uniform") {
        return Err("the field is uniform: the solver did not run".into());
    }
    Ok(i + "internalField".len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comments_and_header_are_skipped() {
        let t = "/* a\n b */\nFoamFile { version 2.0; }\n// x 9 (\n3\n(\n1 2 3\n)\n";
        let b = body(t).unwrap();
        let (n, at) = list_start(&b, 0).unwrap();
        assert_eq!(n, 3);
        assert_eq!(numbers::<i32>(&b[at..], 3).unwrap(), vec![1, 2, 3]);
    }

    #[test]
    fn list_sizes_inside_words_are_not_lists() {
        // `List<scalar> 2(` — the `2` belongs to the list, the `<` to the word.
        let b = "internalField nonuniform List<vector> 2\n(\n(1 2 3)\n(4 5 6)\n)\n;";
        let at = internal_list(b).unwrap();
        let (n, s) = list_start(b, at).unwrap();
        assert_eq!(n, 2);
        assert_eq!(
            numbers::<f64>(&b[s..], 6).unwrap(),
            vec![1., 2., 3., 4., 5., 6.]
        );
    }

    #[test]
    fn patch_values_are_found_by_whole_name() {
        let dir = std::env::temp_dir().join(format!("pcfd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("phiMean");
        std::fs::write(
            &f,
            "FoamFile { class surfaceScalarField; }\ninternalField nonuniform List<scalar> 1(0);\n\
             boundaryField {\n  u1_return10 { type calculated; value uniform 9; }\n\
             u1_return1 { type calculated; value nonuniform List<scalar> 2(0.5 -0.25); }\n\
             u1_supply1 { type calculated; value uniform -0.1; }\n}\n",
        )
        .unwrap();
        assert_eq!(
            patch_scalars(&f, "u1_return1", 2).unwrap(),
            vec![0.5, -0.25]
        );
        assert_eq!(patch_scalars(&f, "u1_supply1", 3).unwrap(), vec![-0.1; 3]);
        assert!(patch_scalars(&f, "u1_return1", 3).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_unit_square_face_has_unit_area() {
        let mesh = Mesh {
            points: vec![[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.]],
            faces: vec![vec![0, 1, 2, 3]],
            owner: vec![0],
            neighbour: vec![],
            patches: BTreeMap::from([("p".to_string(), (0, 1))]),
        };
        assert_eq!(mesh.patch_area("p").unwrap(), [0., 0., 1.]);
        assert_eq!(mesh.cell_centres(), vec![[0.5, 0.5, 0.]]);
    }
}
