import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { typing } from "./chart/drawings/keys";
import "./styles.css";

// The web view's own menu (Reload, Inspect Element) never shows over the app; text fields
// keep theirs for copy and paste. The chart opens its own menu on drawings.
window.addEventListener("contextmenu", (e) => {
  if (!typing(e.target)) e.preventDefault();
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
