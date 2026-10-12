import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * The project is English-only, and it is a product rather than a competition entry.
 *
 * This walks everything we ship and fails the build if it finds a non-ASCII string that looks
 * like prose in another language, or a reference to the event the code was written for. It runs
 * as part of `npm run lint` so the check cannot be skipped by forgetting it.
 */

const ROOT = resolve(import.meta.dirname, '..');

/** Directories that are generated, vendored, or hold nothing we ship. */
const SKIP_DIRECTORIES = new Set(['node_modules', '.next', '.next-build', 'out', 'standalone', 'dist', 'coverage', 'test-results', 'playwright-report', 'data', 'shots', '.git']);

/** Binary or machine-generated extensions nobody reads by hand. */
const SKIP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.wav', '.ogg', '.mp4', '.webm', '.glb', '.gltf', '.zip', '.pdf', '.map', '.tsbuildinfo', '.lockb', '.snap']);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.json', '.css', '.md', '.html', '.yml', '.yaml']);

/**
 * Phrases that turn a product into a competition entry. Anything matching here belongs in a
 * private note, never in a file that ships.
 */
const FORBIDDEN_PHRASES: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bhackathon\b/i, why: 'names the event' },
  { pattern: /\bdevpost\b/i, why: 'names the event platform' },
  { pattern: /\bsubmission\b/i, why: 'talks about entering a competition' },
  { pattern: /\bjudges?\b/i, why: 'addresses the competition panel' },
  { pattern: /\bprize\b|\bprizes\b/i, why: 'talks about winning' },
  { pattern: /\bdeadline\b/i, why: 'talks about the event calendar' },
  { pattern: /\bwinner/i, why: 'talks about the result of a competition' },
  { pattern: /\bqoder\b/i, why: 'names the tool that wrote the code' },
  { pattern: /\bclaude\b|\bgpt-|\bllm\b/i, why: 'names a model as if it were the author' },
  { pattern: /\bai[- ]generated\b/i, why: 'describes the code rather than the product' },
];

/** Scripts we expect to see. Anything outside this list is a stray language. */
const ALLOWED_NON_ASCII = new Set(['Latin', 'Common']);

function scriptOf(character: string): string {
  // \p{Script} is the smallest honest way to ask "what alphabet is this".
  for (const script of ALLOWED_NON_ASCII) {
    if (new RegExp(`\\p{Script=${script}}`, 'u').test(character)) return script;
  }
  return 'Other';
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly why: string;
}

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    if (entry.startsWith('.') && entry !== '.env.example') continue;
    const full = join(directory, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry)) continue;
      yield* walk(full);
    } else if (SOURCE_EXTENSIONS.has(extensionOf(entry)) && !SKIP_EXTENSIONS.has(extensionOf(entry))) {
      yield full;
    }
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(dot);
}

function scanFile(file: string): Hit[] {
  const hits: Hit[] = [];
  const shown = relative(ROOT, file).split(sep).join('/');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineAt = index + 1;
    for (const { pattern, why } of FORBIDDEN_PHRASES) {
      const found = pattern.exec(line);
      if (found) hits.push({ file: shown, line: lineAt, text: found[0], why });
    }
    for (const character of line) {
      const code = character.codePointAt(0) ?? 0;
      if (code < 128) continue;
      if (code >= 0x2000 && code <= 0x2fff) continue; // dashes, arrows and other punctuation
      if (scriptOf(character) !== 'Other') continue; // é in a name and · in a caption are still English text
      hits.push({ file: shown, line: lineAt, text: character, why: 'non-Latin script' });
      break;
    }
  });
  return hits;
}

function main(): void {
  const hits: Hit[] = [];
  let files = 0;
  for (const file of walk(ROOT)) {
    files += 1;
    hits.push(...scanFile(file));
  }

  if (hits.length === 0) {
    console.log(`language audit: ${files} files, no findings`);
    return;
  }

  const grouped = new Map<string, Hit[]>();
  for (const hit of hits) {
    const list = grouped.get(hit.file) ?? [];
    list.push(hit);
    grouped.set(hit.file, list);
  }
  for (const [file, list] of grouped) {
    console.log(`${file}`);
    for (const hit of list.slice(0, 20)) console.log(`  line ${hit.line}: "${hit.text}" - ${hit.why}`);
    if (list.length > 20) console.log(`  ... and ${list.length - 20} more in this file`);
  }
  console.log(`language audit: ${hits.length} finding(s) across ${grouped.size} file(s)`);
  process.exit(1);
}

main();
