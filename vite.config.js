import { defineConfig } from 'vite';

// Relative base so the build works from any sub-path (e.g. GitHub Pages).
// __BUILD_ID__ is the deployed commit (GITHUB_SHA in Actions, 'dev' locally);
// online play only connects two devices running the same build.
export default defineConfig({
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(process.env.GITHUB_SHA || 'dev'),
  },
});
