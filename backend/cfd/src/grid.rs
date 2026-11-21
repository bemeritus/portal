//! The grid the browser draws slices from (SPEC §14.2: "the fields
//! resampled to a regular grid for the browser, f16, compressed").
//!
//! Layout, gzipped as a whole:
//! - 4 bytes `PFG1`;
//! - u32 little-endian: the length of the JSON header that follows;
//! - the header, e.g. `{"n":[111,48,77],"h_mm":50,"fields":["t","ux","uy","uz"]}`;
//! - for each field in order, `n[0]·n[1]·n[2]` IEEE half floats,
//!   little-endian, x fastest, then y, then z (a WebGL 3D texture's order).
//!
//! Temperature is °C, velocity m/s. Points inside an obstacle are NaN in
//! every field.

use std::io::Write;

use flate2::Compression;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};

use crate::post::Grid;

/// The browser grid's spacing, mm.
pub const BROWSER_GRID_MM: i32 = 50;

pub const MAGIC: &[u8; 4] = b"PFG1";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Header {
    pub n: [usize; 3],
    pub h_mm: i32,
    pub fields: Vec<String>,
}

/// IEEE 754 half precision from single, rounding to nearest even.
pub fn f16_bits(v: f32) -> u16 {
    let x = v.to_bits();
    let sign = ((x >> 16) & 0x8000) as u16;
    let exp = ((x >> 23) & 0xff) as i32;
    let man = x & 0x7f_ffff;
    if exp == 0xff {
        // Inf stays Inf; NaN stays a (quiet) NaN.
        return sign | 0x7c00 | if man != 0 { 0x200 } else { 0 };
    }
    let e = exp - 127 + 15;
    if e >= 0x1f {
        return sign | 0x7c00;
    }
    if e <= 0 {
        if e < -10 {
            return sign;
        }
        // Subnormal: shift the mantissa (with its implicit 1) into place.
        let m = man | 0x80_0000;
        let shift = (14 - e) as u32;
        let half = 1u32 << (shift - 1);
        let rest = m & ((1 << shift) - 1);
        let mut h = m >> shift;
        if rest > half || (rest == half && h & 1 == 1) {
            h += 1;
        }
        return sign | h as u16;
    }
    let mut h = ((e as u32) << 10) | (man >> 13);
    let rest = man & 0x1fff;
    if rest > 0x1000 || (rest == 0x1000 && h & 1 == 1) {
        // A carry into the exponent is the correct rounding, up to Inf.
        h += 1;
    }
    sign | h as u16
}

/// The browser grid of `g`, encoded and gzipped.
pub fn encode(g: &Grid) -> Result<Vec<u8>, String> {
    let header = Header {
        n: g.n,
        h_mm: (g.h * 1000.0).round() as i32,
        fields: ["t", "ux", "uy", "uz"].map(String::from).to_vec(),
    };
    let json = serde_json::to_vec(&header).map_err(|e| e.to_string())?;
    let total = g.t.len();
    let mut raw = Vec::with_capacity(8 + json.len() + total * 8);
    raw.extend_from_slice(MAGIC);
    raw.extend_from_slice(&(json.len() as u32).to_le_bytes());
    raw.extend_from_slice(&json);
    let value = |i: usize, f: usize| -> f32 {
        if g.solid[i] {
            f32::NAN
        } else if f == 0 {
            g.t[i]
        } else {
            g.u[i][f - 1]
        }
    };
    for f in 0..4 {
        for i in 0..total {
            raw.extend_from_slice(&f16_bits(value(i, f)).to_le_bytes());
        }
    }
    gzip(&raw)
}

pub fn gzip(raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut z = GzEncoder::new(Vec::new(), Compression::default());
    z.write_all(raw).map_err(|e| e.to_string())?;
    z.finish().map_err(|e| e.to_string())
}

pub fn gunzip(z: &[u8]) -> Result<Vec<u8>, String> {
    let mut raw = vec![];
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(z), &mut raw)
        .map_err(|e| e.to_string())?;
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_floats_round_to_nearest_even() {
        assert_eq!(f16_bits(0.0), 0x0000);
        assert_eq!(f16_bits(-0.0), 0x8000);
        assert_eq!(f16_bits(1.0), 0x3c00);
        assert_eq!(f16_bits(-2.0), 0xc000);
        assert_eq!(f16_bits(65504.0), 0x7bff);
        assert_eq!(f16_bits(65520.0), 0x7c00); // rounds up to Inf
        assert_eq!(f16_bits(f32::INFINITY), 0x7c00);
        assert_eq!(f16_bits(f32::NAN) & 0x7c00, 0x7c00);
        assert_ne!(f16_bits(f32::NAN) & 0x3ff, 0);
        assert_eq!(f16_bits(5.960_464_5e-8), 0x0001); // smallest subnormal
        assert_eq!(f16_bits(6.103_515_6e-5), 0x0400); // smallest normal
        // 1 + 2^-11 is halfway between 1 and the next half: ties to even.
        assert_eq!(f16_bits(1.000_488_3), 0x3c00);
        assert_eq!(f16_bits(1.001_464_8), 0x3c02);
        // A temperature keeps about two decimals.
        let t = 27.3f32;
        let back = 2f32.powi(4) * (1.0 + (f16_bits(t) & 0x3ff) as f32 / 1024.0);
        assert!((back - t).abs() < 0.01);
    }

    #[test]
    fn the_container_starts_with_its_header() {
        let g = Grid {
            h: 0.05,
            n: [2, 1, 1],
            t: vec![20.0, 21.0],
            u: vec![[0.0; 3], [1.0, 0.0, 0.0]],
            solid: vec![false, true],
        };
        let z = encode(&g).unwrap();
        let mut raw = vec![];
        std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&z[..]), &mut raw).unwrap();
        assert_eq!(&raw[..4], MAGIC);
        let len = u32::from_le_bytes(raw[4..8].try_into().unwrap()) as usize;
        let h: Header = serde_json::from_slice(&raw[8..8 + len]).unwrap();
        assert_eq!(h.n, [2, 1, 1]);
        assert_eq!(h.h_mm, 50);
        let body = &raw[8 + len..];
        assert_eq!(body.len(), 2 * 4 * 2);
        assert_eq!(u16::from_le_bytes([body[0], body[1]]), f16_bits(20.0));
        // The solid point is NaN.
        assert_eq!(u16::from_le_bytes([body[2], body[3]]) & 0x7c00, 0x7c00);
    }
}
