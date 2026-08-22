// Minimal, dependency-free "@/*" -> ".test-dist/src/*" resolver for the
// compiled itinerary-generation test build (tsconfig.itinerary-tests.json
// emits CommonJS with `@/` import specifiers left untouched — tsc does not
// rewrite path-alias imports in its output). Loaded via `node --require`
// before running the compiled tests; does not affect the main app, which
// resolves `@/*` through Next.js's own bundler instead.
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS module-loader
   hook, loaded via `node --require` before ESM resolution exists; must use require(). */
const Module = require("node:module");
const path = require("node:path");

const originalResolve = Module._resolveFilename;
const testDistSrc = path.join(__dirname, "..", ".test-dist", "src");

Module._resolveFilename = function patchedResolve(request, ...rest) {
  if (request.startsWith("@/")) {
    const rewritten = path.join(testDistSrc, request.slice(2));
    return originalResolve.call(this, rewritten, ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};
