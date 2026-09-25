import type { ReactNode } from "react";

export { isolateText } from "@/lib/bidi-text";

/**
 * Round 9.10 — isolates dynamic, potentially-mixed-script text (a place
 * name, an activity/meal/hotel name, an already-composed transfer string
 * like "Providence → Bar Harbor" — anything the app itself did not author
 * as part of its own Hebrew copy) from the surrounding RTL layout.
 *
 * Root cause this closes: a persisted, verified-correct string like
 * "Bar Harbor"/"North Conway" was rendered by every screen surface as a
 * bare `{value}` interpolation directly inside RTL-directed Hebrew
 * containers, with zero bidi isolation anywhere — the browser had no signal
 * that this run of text is its own independent bidi paragraph rather than a
 * continuation of the surrounding Hebrew context.
 *
 * `dir="auto"` (never a hardcoded `dir="ltr"`, which would itself
 * mis-render a Hebrew place name the exact same way) — the browser's own
 * Unicode Bidi Algorithm decides the real direction from the content's own
 * first strong character, so this is correct for Hebrew, English, numbers,
 * or any mix, with no name-specific/language-specific branching anywhere
 * in this module.
 *
 * Never a manual string reversal, never a name/brand-specific special case
 * — the underlying string is passed through completely untouched; only how
 * it is isolated for rendering changes. See `@/lib/bidi-text`'s
 * `isolateText` for the plain-text equivalent (an `<option>` label, an
 * `alt`/`title` attribute, a toast message, a maplibre popup's
 * `.textContent`) where no markup — including `<bdi>` — is allowed at all.
 */
export function IsolatedText({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="auto" className={className}>
      {children}
    </bdi>
  );
}
