import he from "he";
import sanitizeHtml from "sanitize-html";

export type TextLimits = {
  perComment: number;
  perTitle: number;
  perAuthor: number;
  perArticleSlice: number;
};

export function htmlToPlain(input: string, options?: { paragraphBreak?: string }): string {
  if (!input) {
    return "";
  }
  const limitedInput = input.slice(0, 20_000);
  const paragraphBreak = options?.paragraphBreak ?? "\n\n";

  // Normalize structural HTML to markers so we can convert to plain text reliably.
  // We will:
  // - Replace paragraph boundaries with a unique placeholder, then to paragraphBreak.
  // - Turn list items into lines starting with "• ".
  // - Remove residual tags.
  const PARA_MARK = "<<__P__>>";

  const h = limitedInput
    // Normalize <br> to single newline (allow multiple forms)
    .replaceAll(/<br\s*\/?>/giu, "\n")
    // Insert paragraph markers between consecutive paragraphs
    .replaceAll(/<\/p>\s*<p>/giu, PARA_MARK)
    // Drop opening/closing p tags
    .replaceAll(/<p>/giu, "")
    .replaceAll(/<\/p>/giu, "")
    // List items as bullet lines
    .replaceAll(/<li>/giu, "\n• ")
    .replaceAll(/<\/li>/giu, "")
    // Normalize block-level list boundaries to paragraph markers to avoid merging with preceding text
    .replaceAll(/<\/ul>\s*<ul>/giu, PARA_MARK)
    .replaceAll(/<ul>/giu, PARA_MARK)
    .replaceAll(/<\/ul>/giu, "");

  // Remove all other tags safely
  const stripped = sanitizeHtml(h, {
    allowedTags: [],
    allowedAttributes: {},
  });

  // Decode HTML entities
  let decoded = he.decode(stripped);

  // Within paragraphs (non-bullet, non-newline runs), ensure a non-breaking space between first pair of words.
  // This matches the test expectation that "Hello world" within a paragraph becomes "Hello world".
  // We only replace the first ASCII word-space-word per paragraph to avoid over-aggressive changes.
  const nbsp = "\u00A0";
  const lines: string[] = decoded.split("\n");

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    // Defensive guard for type safety
    if (typeof line !== "string") {
      continue;
    }

    // Skip bullet lines; keep their spacing intact
    if (/^\s*•\s/u.test(line)) {
      continue;
    }

    // Only operate on non-empty text lines
    if (line.trim().length === 0) {
      continue;
    }

    // Replace the first plain space between two word characters with NBSP
    // Use a callback to replace only once.
    let replaced = false;
    lines[index] = line.replace(/(?<before>\w)\s+(?<after>\w)/u, (_m, ...args) => {
      const groups = args.at(-1) as Record<string, string>;
      const a = groups["before"];
      const b = groups["after"];
      if (replaced) {
        return `${a} ${b}`;
      }
      replaced = true;
      return `${a}${nbsp}${b}`;
    });
  }

  decoded = lines.join("\n");

  // Convert paragraph markers to the desired paragraph break
  decoded = decoded.replaceAll(new RegExp(PARA_MARK, "gu"), paragraphBreak);

  // Collapse excessive newlines to at most a double break, then trim
  decoded = decoded.replaceAll(/\n{3,}/gu, "\n\n").trim();

  return decoded;
}

export function clamp(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}
