import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Tauri loads the built files from `dist` and, in dev, the server on a fixed port.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022" },
  test: { environment: "node" },
});
