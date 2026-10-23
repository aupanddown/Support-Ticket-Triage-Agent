/**
 * Deterministic writing-system detection, so the policy can check the model's reply
 * language without relying on the model.
 *
 * It tells scripts apart (Thai vs Latin vs anything else), not languages: English and
 * Spanish are both "latin". That is enough to catch the costly mistake (replying in the
 * wrong script) without guessing; a language model or library would be needed for more.
 */
export type Script = "thai" | "latin" | "other";

/** Languages we have pre-approved fallback replies in. */
export type ReplyLanguage = "en" | "th";

// Thai messages often contain English words (product names, "error 500", URLs),
// so a text counts as Thai when at least this share of its letters are Thai.
const THAI_SHARE_THRESHOLD = 0.3;
const LATIN_SHARE_THRESHOLD = 0.5;

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** Returns the main script of a text, or undefined when it has no letters. */
export function detectScript(text: string): Script | undefined {
  const letters = count(text, /\p{L}/gu);
  if (letters === 0) return undefined;
  if (count(text, /\p{Script=Thai}/gu) / letters >= THAI_SHARE_THRESHOLD) return "thai";
  if (count(text, /\p{Script=Latin}/gu) / letters >= LATIN_SHARE_THRESHOLD) return "latin";
  return "other";
}

/** The fallback reply language for a script: Thai for Thai, English for Latin, none otherwise. */
export function fallbackLanguage(script: Script | undefined): ReplyLanguage | undefined {
  if (script === "thai") return "th";
  if (script === "latin") return "en";
  return undefined;
}
