#!/usr/bin/env node
// In a checkout, run the TypeScript source directly (Node >= 22.18 strips types natively)
// so a stale dist/ never shadows it. Installed under node_modules, where Node will not strip
// types, run the compiled build that `prepare` produces.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = new URL('../src/cli/main.ts', import.meta.url);
const installed = fileURLToPath(import.meta.url).split(/[\\/]/).includes('node_modules');
await import(!installed && existsSync(source) ? source.href : new URL('../dist/cli/main.js', import.meta.url).href);
