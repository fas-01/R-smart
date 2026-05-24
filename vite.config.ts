import { defineConfig } from "vite";

// Tauri expects a fixed dev server port
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
});
