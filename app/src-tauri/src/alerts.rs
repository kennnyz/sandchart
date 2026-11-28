//! Alert events to the UI (`alert-fired`, `alerts-changed`) and fired alerts to the OS as
//! notifications. Nothing leaves the machine.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use sandchart_core::alert::{Alert, AlertKind, Direction};
use sandchart_core::format_scaled;
use sandchart_engine::AlertEvent;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::broadcast;

use crate::dto::AlertDto;

/// Forwards alert events until the engine goes away.
pub async fn forward(
    mut events: broadcast::Receiver<AlertEvent>,
    app: AppHandle,
    russian: Arc<AtomicBool>,
) {
    loop {
        let event = match events.recv().await {
            Ok(e) => e,
            // Missed events: the UI reloads the list, which has every state.
            Err(broadcast::error::RecvError::Lagged(_)) => AlertEvent::Changed,
            Err(broadcast::error::RecvError::Closed) => return,
        };
        let sent = match event {
            AlertEvent::Changed => app.emit("alerts-changed", ()),
            AlertEvent::Fired(a) => {
                let (title, body) = notification_text(&a, russian.load(Ordering::Acquire));
                if let Err(e) = app.notification().builder().title(title).body(body).show() {
                    eprintln!("cannot show the notification of alert {}: {e}", a.id);
                }
                app.emit("alert-fired", AlertDto::from(a))
            }
        };
        if let Err(e) = sent {
            eprintln!("cannot emit an alert event: {e}");
        }
    }
}

/// Title and body of the OS notification of a fired alert.
fn notification_text(a: &Alert, russian: bool) -> (String, String) {
    let price = |p: i64| format_scaled(p, a.price_scale);
    let verb = match (a.direction, russian) {
        (Direction::Above, false) => "Crossed above",
        (Direction::Below, false) => "Crossed below",
        (Direction::Cross, false) => "Crossed",
        (Direction::Above, true) => "Пересёк вверх",
        (Direction::Below, true) => "Пересёк вниз",
        (Direction::Cross, true) => "Пересёк",
    };
    let level = match (&a.kind, russian) {
        (AlertKind::Price { price: p }, _) => price(*p),
        (AlertKind::Drawing { .. }, false) => "the line".to_owned(),
        (AlertKind::Drawing { .. }, true) => "линию".to_owned(),
    };
    let now = a.triggered_price.map(price).unwrap_or_default();
    let now = if russian {
        format!("сейчас {now}")
    } else {
        format!("now {now}")
    };
    (
        a.instrument.symbol.clone(),
        format!("{verb} {level} · {now}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use sandchart_core::InstrumentId;

    fn fired(kind: AlertKind, direction: Direction) -> Alert {
        Alert {
            id: "a".into(),
            instrument: InstrumentId {
                source: "binance".into(),
                symbol: "BTCUSDT".into(),
            },
            price_scale: 2,
            kind,
            direction,
            active: false,
            created_at: 0,
            triggered_at: Some(1),
            triggered_price: Some(6_400_210),
        }
    }

    #[test]
    fn notification_text_names_the_pair_the_level_and_the_price() {
        let a = fired(AlertKind::Price { price: 6_400_000 }, Direction::Above);
        assert_eq!(
            notification_text(&a, false),
            (
                "BTCUSDT".to_owned(),
                "Crossed above 64000.00 · now 64002.10".to_owned()
            )
        );
        let a = fired(
            AlertKind::Drawing {
                drawing_id: "d".into(),
            },
            Direction::Cross,
        );
        assert_eq!(
            notification_text(&a, true).1,
            "Пересёк линию · сейчас 64002.10"
        );
    }
}
