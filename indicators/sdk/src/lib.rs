//! SDK for writing Sandchart indicators as WebAssembly components.
//!
//! Implement [`Indicator`] for a type and export it with [`export!`]. The
//! contract is `wit/indicator.wit`; prices and volumes arrive as `f64` in
//! price units, and a series that has no value at a bar uses `NaN`.

#[allow(clippy::all, missing_docs, unused_extern_crates)]
pub mod bindings {
    wit_bindgen::generate!({
        path: "wit",
        world: "plugin",
        pub_export_macro: true,
        default_bindings_module: "sandchart_indicator::bindings",
    });
}

pub mod ta;

pub use bindings::export;
pub use bindings::exports::sandchart::indicator::indicator::Guest as Indicator;
pub use bindings::sandchart::indicator::types::{
    Candle, Marker, MarkerShape, Meta, Pane, ParamKind, ParamSpec, ParamValue, SeriesData,
    SeriesKind, SeriesOut, SeriesSpec,
};

/// Resolved parameters passed to `compute`, with typed lookup by id.
pub struct Params(Vec<(String, ParamValue)>);

impl Params {
    /// Wraps the parameter list received by `compute`.
    pub fn new(v: Vec<(String, ParamValue)>) -> Self {
        Self(v)
    }

    fn get(&self, id: &str) -> Result<&ParamValue, String> {
        self.0
            .iter()
            .find(|(k, _)| k == id)
            .map(|(_, v)| v)
            .ok_or_else(|| format!("missing param \"{id}\""))
    }

    /// An integer parameter.
    pub fn int(&self, id: &str) -> Result<i64, String> {
        match self.get(id)? {
            ParamValue::Int(v) => Ok(*v),
            _ => Err(format!("param \"{id}\" is not int")),
        }
    }

    /// A floating-point parameter.
    pub fn float(&self, id: &str) -> Result<f64, String> {
        match self.get(id)? {
            ParamValue::Float(v) => Ok(*v),
            _ => Err(format!("param \"{id}\" is not float")),
        }
    }

    /// A boolean parameter.
    pub fn boolean(&self, id: &str) -> Result<bool, String> {
        match self.get(id)? {
            ParamValue::Boolean(v) => Ok(*v),
            _ => Err(format!("param \"{id}\" is not boolean")),
        }
    }

    /// A choice parameter (one of the strings declared in its spec).
    pub fn choice(&self, id: &str) -> Result<&str, String> {
        match self.get(id)? {
            ParamValue::Choice(v) => Ok(v),
            _ => Err(format!("param \"{id}\" is not choice")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_param_is_an_error() {
        let p = Params::new(vec![]);
        assert_eq!(p.int("period"), Err("missing param \"period\"".to_string()));
    }

    #[test]
    fn wrong_kind_is_an_error() {
        let p = Params::new(vec![("period".into(), ParamValue::Choice("x".into()))]);
        assert_eq!(
            p.int("period"),
            Err("param \"period\" is not int".to_string())
        );
    }

    #[test]
    fn typed_lookup() {
        let p = Params::new(vec![
            ("n".into(), ParamValue::Int(5)),
            ("k".into(), ParamValue::Float(2.5)),
            ("b".into(), ParamValue::Boolean(true)),
            ("s".into(), ParamValue::Choice("close".into())),
        ]);
        assert_eq!(p.int("n"), Ok(5));
        assert_eq!(p.float("k"), Ok(2.5));
        assert_eq!(p.boolean("b"), Ok(true));
        assert_eq!(p.choice("s"), Ok("close"));
    }
}
