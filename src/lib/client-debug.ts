// Hygiene pass — a single, explicit opt-in for the small amount of
// genuinely-useful CLIENT-side debug logging in this app (map focus
// calculations, missing illustration assets, etc.). OFF by default so a
// normal `npm run dev` browser console stays clean; a developer who wants
// this output sets NEXT_PUBLIC_CLIENT_DEBUG=1 (a build-time env var, the
// only kind Next.js inlines into the browser bundle — a plain
// server-side env var like QA_DEBUG_GEOGRAPHY is never visible here).
// Server-side QA/debug logging (generation stage markers, planner QA
// trace, fixture capture) is a SEPARATE concern gated by
// isPlannerQaTraceEnabled()/isFixtureCaptureEnabled() — this flag only
// ever controls what prints to the BROWSER console.
export function isClientDebugEnabled(): boolean {
  return process.env.NEXT_PUBLIC_CLIENT_DEBUG === "1";
}
