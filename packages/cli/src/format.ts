import { formatCredits } from "./credits.js";

export { formatCredits };

export type Outcome = "success" | "denied" | "error";

const GLYPHS: Record<Outcome, string> = {
  success: "✓",
  denied: "✗",
  error: "!",
};

const LABELS: Record<Outcome, string> = {
  success: "Work Receipt",
  denied: "Denied",
  error: "Upstream Error",
};

export function glyphFor(outcome: string): string {
  return outcome in GLYPHS ? GLYPHS[outcome as Outcome] : "?";
}

export function labelFor(outcome: string): string {
  return outcome in LABELS ? LABELS[outcome as Outcome] : outcome;
}

export function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function truncateIso(iso: string): string {
  // 2026-05-09T16:42:11.123Z → 2026-05-09T16:42:11Z
  return iso.replace(/\.\d+Z$/, "Z");
}
