declare module "sanitize-html" {
  // Minimal typing to allow default import usage in utils/text.ts
  interface IOptions {
    allowedTags?: string[];
    allowedAttributes?: Record<string, string[] | true | undefined>;
  }
  function sanitizeHtml(dirty: string, options?: IOptions): string;
  export default sanitizeHtml;
}

declare module "he" {
  const he: {
    decode: (text: string) => string;
    encode?: (text: string) => string;
  };
  export default he;
}
