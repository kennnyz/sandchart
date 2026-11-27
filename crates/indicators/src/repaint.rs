//! Detects indicators that repaint: a bar's value changes when later bars
//! arrive.

use crate::{Bar, Marker, MarkerShape, Module, Output, ParamValue, RunError, SeriesData};

/// How many bars the repaint check uses.
pub const REPAINT_BARS: usize = 2000;

/// Prefix lengths the repaint check compares against the full run, for
/// `sample_bars(REPAINT_BARS)`.
pub const REPAINT_PREFIXES: [usize; 4] = [500, 1000, 1500, 1999];

/// The first value that differs between a prefix run and the full run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepaintAt {
    /// Id of the series that changed.
    pub series: String,
    /// Bar index of the first changed value (or of the first changed marker).
    pub index: usize,
}

/// Runs `module` on the whole of `bars` and on `bars[..p]` for each `p` in
/// `prefixes`, and compares every value at an index below `p`. NaN equals NaN;
/// anything else must be bit-identical. Markers compare as sets of
/// `(index, shape)`. Returns the first difference, or `None` if the module
/// does not repaint on these bars.
pub fn check_repaint(
    module: &Module,
    params: &[(String, ParamValue)],
    bars: &[Bar],
    prefixes: &[usize],
) -> Result<Option<RepaintAt>, RunError> {
    let full = module.compute(params, bars)?;
    for &p in prefixes {
        let p = p.min(bars.len());
        let part = module.compute(params, &bars[..p])?;
        if let Some(at) = first_difference(&full, &part, p) {
            return Ok(Some(at));
        }
    }
    Ok(None)
}

fn first_difference(full: &Output, part: &Output, p: usize) -> Option<RepaintAt> {
    for (f, q) in full.series.iter().zip(&part.series) {
        let index = match (&f.data, &q.data) {
            (SeriesData::Values(a), SeriesData::Values(b)) => {
                (0..p.min(a.len()).min(b.len())).find(|&i| !same(a[i], b[i]))
            }
            (SeriesData::Markers(a), SeriesData::Markers(b)) => marker_difference(a, b, p),
            _ => Some(0),
        };
        if let Some(index) = index {
            return Some(RepaintAt {
                series: f.id.clone(),
                index,
            });
        }
    }
    None
}

/// NaN equals NaN; everything else must be bit-identical.
fn same(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
}

fn marker_difference(full: &[Marker], part: &[Marker], p: usize) -> Option<usize> {
    let set = |m: &[Marker]| -> Vec<(usize, MarkerShape)> {
        let mut v: Vec<_> = m
            .iter()
            .filter(|m| (m.index as usize) < p)
            .map(|m| (m.index as usize, m.shape))
            .collect();
        v.sort_by_key(|(i, s)| (*i, *s as u8));
        v
    };
    let (a, b) = (set(full), set(part));
    if a == b {
        return None;
    }
    // The first index present in one set but not in the other.
    a.iter()
        .filter(|x| !b.contains(x))
        .chain(b.iter().filter(|x| !a.contains(x)))
        .map(|(i, _)| *i)
        .min()
}
