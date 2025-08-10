import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

export function htmlToMd(html: string): string {
  if (!html) return '';
  return turndown.turndown(html);
}

export default htmlToMd;
