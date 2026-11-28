import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { keepsNativeMenu } from "./chart/drawings/keys";
import "./styles.css";

// The web view's own menu never shows over the app, except in text fields and dev builds
// (see `keepsNativeMenu`). The chart opens its own menu on drawings.
window.addEventListener("contextmenu", (e) => {
  if (!keepsNativeMenu(e.target)) e.preventDefault();
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
