/** Languages the policy can check and write fallback replies in. Add a code here to support more. */
export type Language = "en" | "th";

// Thai messages often contain English words (product names, "error 500", URLs),
// so a text counts as Thai when at least this share of its letters are Thai.
const THAI_SHARE_THRESHOLD = 0.3;

/**
 * Deterministic, script-based language detection. It does not rely on the LLM,
 * so the policy can check the model's reply language independently.
 */
export function detectLanguage(text: string): Language {
  const thai = text.match(/\p{Script=Thai}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (thai + latin === 0) return "en";
  return thai / (thai + latin) >= THAI_SHARE_THRESHOLD ? "th" : "en";
}
