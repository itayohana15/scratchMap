/**
 * Round 9.10 — the plain-text bidi-isolation primitive shared by every
 * rendering surface (screen React components via `<bdi>`, and the handful
 * of true plain-text contexts — an `<option>` label, an `alt`/`title`
 * attribute, a toast/log message, a maplibre popup's `.textContent` — where
 * no markup is allowed at all, so `<bdi>` itself cannot be used).
 *
 * Wraps the value with Unicode's own FSI/PDI isolate control characters —
 * the exact text-level mechanism `<bdi>` is built on. Adds no visible
 * character, never reorders or otherwise touches the underlying string;
 * only how it is isolated for rendering changes. See
 * `src/components/ui/isolated-text.tsx` for the React/markup form
 * (`<bdi dir="auto">`) used wherever JSX children are allowed.
 */
const FIRST_STRONG_ISOLATE = "⁦";
const POP_DIRECTIONAL_ISOLATE = "⁩";

export function isolateText(value: string): string {
  return `${FIRST_STRONG_ISOLATE}${value}${POP_DIRECTIONAL_ISOLATE}`;
}
