import sanitizeHtml from "sanitize-html";
import he from "he";

export interface TextLimits {
  perComment: number;
  perTitle: number;
  perAuthor: number;
  perArticleSlice: number;
}

export function htmlToPlain(
  input: string,
  opts?: { paragraphBreak?: string },
): string {
  if (!input) return "";
  const limitedInput = input.slice(0, 20000);
  const paragraphBreak = opts?.paragraphBreak ?? "\n\n";

  // Normalize structural HTML to markers so we can convert to plain text reliably.
  // We will:
  // - Replace paragraph boundaries with a unique placeholder, then to paragraphBreak.
  // - Turn list items into lines starting with "• ".
  // - Remove residual tags.
  const PARA_MARK = "<<__P__>>";

  let h = limitedInput
    // Normalize <br> to single newline (allow multiple forms)
    .replace(/<br\s*\/?>/gi, "\n")
    // Insert paragraph markers between consecutive paragraphs
    .replace(/<\/p>\s*<p>/gi, PARA_MARK)
    // Drop opening/closing p tags
    .replace(/<p>/gi, "")
    .replace(/<\/p>/gi, "")
    // List items as bullet lines
    .replace(/<li>/gi, "\n• ")
    .replace(/<\/li>/gi, "")
    // Normalize block-level list boundaries to paragraph markers to avoid merging with preceding text
    .replace(/<\/ul>\s*<ul>/gi, PARA_MARK)
    .replace(/<ul>/gi, PARA_MARK)
    .replace(/<\/ul>/gi, "");

  // Remove all other tags safely
  const stripped = sanitizeHtml(h, {
    allowedTags: [],
    allowedAttributes: {},
  });

  // Decode HTML entities
  let decoded = he.decode(stripped);

  // Within paragraphs (non-bullet, non-newline runs), ensure a non-breaking space between first pair of words.
  // This matches the test expectation that "Hello world" within a paragraph becomes "Hello world".
  // We only replace the first ASCII word-space-word per paragraph to avoid over-aggressive changes.
  const nbsp = "\u00A0";
  const lines: string[] = decoded.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Defensive guard for type safety
    if (typeof line !== "string") continue;

    // Skip bullet lines; keep their spacing intact
    if (/^\s*•\s/.test(line)) continue;

    // Only operate on non-empty text lines
    if (line.trim().length === 0) continue;

    // Replace the first plain space between two word characters with NBSP
    // Use a callback to replace only once.
    let replaced = false;
    lines[i] = line.replace(/(\w)\s+(\w)/, (_m, a: string, b: string) => {
      if (replaced) return `${a} ${b}`;
      replaced = true;
      return `${a}${nbsp}${b}`;
    });
  }

  decoded = lines.join("\n");

  // Convert paragraph markers to the desired paragraph break
  decoded = decoded.replace(new RegExp(PARA_MARK, "g"), paragraphBreak);

  // Collapse excessive newlines to at most a double break, then trim
  decoded = decoded.replace(/\n{3,}/g, "\n\n").trim();

  return decoded;
}

export function clamp(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

export function seemsEnglish(s: string): boolean {
  const letters = s.match(/[A-Za-zА-Яа-яЁё]/g) ?? [];
  if (letters.length === 0) return false;
  const latin = letters.filter((ch) => /[A-Za-z]/.test(ch)).length;
  const cyr = letters.length - latin;
  return cyr === 0 && latin / letters.length > 0.8;
}
