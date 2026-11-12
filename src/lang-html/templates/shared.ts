/**
 * Shared contract for template-language plug-ins. See ./index.ts.
 */
export interface Region {
  lang: 'css' | 'js';
  /** Offsets into the preprocessed text. */
  start: number;
  end: number;
}

export interface Preprocessed {
  /** Same length and line breaks as the source, with template syntax neutralised. */
  text: string;
  /**
   * Like `text`, but output expressions are blanked rather than replaced with `0`: CSS can
   * lose a value or a whole stylesheet (`<style>{{ css }}</style>`) and still parse.
   */
  css: string;
  /** `text` with the regions blanked as well, for the HTML parser. */
  html: string;
  regions: Region[];
}

export interface TemplateLanguage {
  name: string;
  extensions: string[];
  preprocess(source: string): Preprocessed;
}

/** Replaces everything except line breaks with spaces, keeping offsets and line numbers. */
export function blank(s: string): string {
  return s.replace(/[^\n\r]/g, ' ');
}

/** Replaces a template output expression with a `0` placeholder of the same shape. */
export function placeholder(s: string): string {
  const b = blank(s);
  return b.length && b[0] !== '\n' && b[0] !== '\r' ? `0${b.slice(1)}` : b;
}
