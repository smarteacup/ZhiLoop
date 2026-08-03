import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", strictPort: false },
  build: { sourcemap: true, target: "es2022", outDir: "dist", emptyOutDir: true },
});
