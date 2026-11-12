/**
 * Template languages are plug-ins on top of the generic HTML analyser. A plug-in turns
 * template source into analysable text without moving anything: the output has the same
 * length and the same line breaks as the input, so every finding's line and column point
 * at the original file. Template syntax is neutralised (output tags become a `0`
 * placeholder, logic tags become spaces). Blocks the template language itself treats as
 * CSS or JS are returned as regions.
 */
import path from 'node:path';
import { liquid } from './liquid.ts';
import type { TemplateLanguage } from './shared.ts';

export { blank, placeholder, type Preprocessed, type Region, type TemplateLanguage } from './shared.ts';

const plain: TemplateLanguage = {
  name: 'html',
  extensions: ['.html', '.htm'],
  preprocess: (source) => ({ text: source, css: source, html: source, regions: [] }),
};

const languages: TemplateLanguage[] = [plain, liquid];

export function templateFor(file: string): TemplateLanguage | undefined {
  const ext = path.extname(file).toLowerCase();
  return languages.find((l) => l.extensions.includes(ext));
}

export const MARKUP_EXTENSIONS = new Set(languages.flatMap((l) => l.extensions));
