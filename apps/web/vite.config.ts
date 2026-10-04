import { fileURLToPath } from "node:url";

import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";
import { z } from "zod";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The product UI talks to the Fastify API over `VITE_API_URL`, both from the
 * browser and from the server-rendered session gate; there is no proxy in front
 * of the backend. The variable comes from the repository-root `.env`.
 */
export default defineConfig(({ mode }) => {
  z.url({ protocol: /^https?$/ }).parse(loadEnv(mode, repositoryRoot, "VITE_").VITE_API_URL);

  return {
    envDir: repositoryRoot,
    resolve: { tsconfigPaths: true },
    server: { port: 3001, strictPort: true },
    preview: { port: 3001, strictPort: true },
    build: {
      rolldownOptions: {
        // Dependencies ship RSC `"use client"` markers; Start has no server components to honour them.
        onLog(level, log, handler) {
          if (log.code === "MODULE_LEVEL_DIRECTIVE") return;

          handler(level, log);
        },
      },
    },
    plugins: [
      tailwindcss(),
      tanstackStart(),
      nitro(),
      react(),
      babel({ presets: [reactCompilerPreset()] }),
    ],
  };
});
