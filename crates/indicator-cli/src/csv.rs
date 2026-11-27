//! Candles from CSV: the header `time,open,high,low,close,volume`, then one
//! bar per line, oldest first, time in Unix milliseconds.

use sandchart_indicators::Bar;

const HEADER: &str = "time,open,high,low,close,volume";

pub fn parse(text: &str) -> Result<Vec<Bar>, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines().enumerate();
    let Some((_, first)) = lines.next() else {
        return Err(format!(
            "line 1: the file is empty; expected the header {HEADER}"
        ));
    };
    let header: Vec<&str> = first.split(',').map(str::trim).collect();
    if header.join(",") != HEADER {
        return Err(format!(
            "line 1: expected the header {HEADER}, found \"{}\"",
            first.trim()
        ));
    }
    let mut bars: Vec<Bar> = Vec::new();
    for (i, line) in lines {
        let n = i + 1;
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split(',').map(str::trim).collect();
        if f.len() != 6 {
            return Err(format!("line {n}: expected 6 fields, found {}", f.len()));
        }
        let time: i64 = f[0].parse().map_err(|_| {
            format!(
                "line {n}: time \"{}\" is not an integer (Unix milliseconds)",
                f[0]
            )
        })?;
        let num = |k: usize, what: &str| -> Result<f64, String> {
            match f[k].parse::<f64>() {
                Ok(v) if v.is_finite() => Ok(v),
                _ => Err(format!("line {n}: {what} \"{}\" is not a number", f[k])),
            }
        };
        let bar = Bar {
            time,
            open: num(1, "open")?,
            high: num(2, "high")?,
            low: num(3, "low")?,
            close: num(4, "close")?,
            volume: num(5, "volume")?,
        };
        if let Some(prev) = bars.last()
            && time <= prev.time
        {
            return Err(format!(
                "line {n}: time {time} is not after the previous row; bars must be oldest first"
            ));
        }
        bars.push(bar);
    }
    if bars.is_empty() {
        return Err("the file has a header but no bars".into());
    }
    Ok(bars)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rows_and_skips_blank_lines() {
        let bars = parse(
            "time,open,high,low,close,volume\r\n1,1,2,0.5,1.5,10\r\n\r\n2,1,2,0.5,1.5,10\r\n",
        )
        .unwrap();
        assert_eq!(bars.len(), 2);
        assert_eq!(bars[0].high, 2.0);
    }

    #[test]
    fn errors_name_the_line() {
        let head = "time,open,high,low,close,volume\n";
        let e = parse(&format!("{head}1,1,2,0.5,1.5\n")).unwrap_err();
        assert!(e.starts_with("line 2:"), "{e}");
        let e = parse(&format!("{head}1,1,2,0.5,NaN,1\n")).unwrap_err();
        assert!(e.contains("line 2") && e.contains("close"), "{e}");
        let e = parse(&format!("{head}5,1,2,0.5,1,1\n4,1,2,0.5,1,1\n")).unwrap_err();
        assert!(e.starts_with("line 3:"), "{e}");
        assert!(parse("open,high\n").unwrap_err().starts_with("line 1:"));
        assert!(parse("").unwrap_err().starts_with("line 1:"));
        assert!(parse(head).unwrap_err().contains("no bars"));
    }
}
