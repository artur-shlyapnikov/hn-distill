import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

// Configure Markdown-It with sane defaults and linkify
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

// Sanitize-HTML configuration: allow common formatting + tables/code
const allowedTags = [
  'p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td'
];

const allowedAttributes = {
  a: ['href', 'name', 'target', 'rel'],
  code: ['class'],
  pre: ['class'],
  th: ['align'],
  td: ['align'],
} as Record<string, Array<string | { name: string; multiple?: boolean; values: string[] }>>;

const transformTags = {
  // Enforce safe link attributes
  a: (tagName: string, attribs: Record<string, string>) => {
    void tagName; // mark parameter as used
    const href = attribs['href'] || '';
    // Disallow dangerous protocols
    const safeHref = /^\s*javascript:/i.test(href) ? '' : href;
    return {
      tagName: 'a',
      attribs: {
        href: safeHref,
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
      },
    };
  },
} as Record<string, string | ((tagName: string, attribs: Record<string, string>) => { tagName: string; attribs: Record<string, string> })>;

export function mdToHtml(src: string): string {
  if (!src) return '';
  const rendered = md.render(src);
  const sanitized = sanitizeHtml(rendered, {
    allowedTags: allowedTags as any,
    allowedAttributes: allowedAttributes as any,
    disallowedTagsMode: 'discard' as any,
    transformTags: transformTags as any,
  } as any);
  return sanitized;
}

export default mdToHtml;
