import { defineConfig } from 'vite'

// Bundled to CommonJS so the SSH host's CommonJS dependencies (ssh2) load as the app loads them.
export default defineConfig({
  build: {
    ssr: 'scripts/architecture-review-bench.mts',
    target: 'node24',
    outDir: 'out/architecture-review-bench',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'cjs',
        entryFileNames: 'architecture-review-bench.cjs',
      },
    },
  },
})
