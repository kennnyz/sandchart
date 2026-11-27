import { backend } from "./backend";
import { dark, light } from "./chart/theme";
import { ChartView } from "./components/ChartView";

// Interim screen: the chart alone. The full screen (top bar, watchlist, theme
// switch) arrives with Task 9.
const theme = window.matchMedia?.("(prefers-color-scheme: light)").matches ? light : dark;

export function App() {
  return (
    <main style={{ position: "fixed", inset: 0, display: "flex", background: theme.bg }}>
      <ChartView
        backend={backend}
        id={{ source: "mock", symbol: "BTCUSDT" }}
        tf="1h"
        theme={theme}
        priceMode="linear"
        sourceLabel="Binance"
      />
    </main>
  );
}
