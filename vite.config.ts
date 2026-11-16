import { defineConfig, type Plugin } from 'vitest/config';

// Content Security Policy for the built site only. The dev server injects
// inline styles for HMR, so the policy would break `npm run dev`.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://open.neis.go.kr",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'datebook-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  // Relative asset paths work both at the GitHub Pages subpath (/dev-calendar/)
  // and at a local preview root.
  base: './',
  plugins: [cspPlugin()],
  build: {
    target: 'es2022',
    // Small font subsets would otherwise be inlined as data: URLs, which the
    // CSP above (font-src 'self') blocks.
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The host is small and shared: one worker.
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
  },
});
