import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * The project ships as itself: one language, and no reference to anything it was written for or to
 * whatever helped write it.
 *
 * This walks everything we ship and fails the build on a non-ASCII string that looks like prose in
 * another script. It runs as part of `npm run lint` so the check cannot be skipped by forgetting it.
 */

const ROOT = resolve(import.meta.dirname, '..');

/** Directories that are generated, vendored, or hold nothing we ship. */
const SKIP_DIRECTORIES = new Set(['node_modules', '.next', '.next-build', 'out', 'standalone', 'dist', 'coverage', 'test-results', 'playwright-report', 'data', 'shots', '.git']);

/** Binary or machine-generated extensions nobody reads by hand. */
const SKIP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.wav', '.ogg', '.mp4', '.webm', '.glb', '.gltf', '.zip', '.pdf', '.map', '.tsbuildinfo', '.lockb', '.snap']);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.json', '.css', '.md', '.html', '.yml', '.yaml']);

/**
 * Words that turn a product into something else, each with the reason it may not appear.
 *
 * They are read from a file beside this one which is deliberately not tracked, because a list of the
 * phrases that must not be in a repository cannot itself be in that repository - and because spelling
 * them out in source defeats the patterns meant to catch them: `/\bhackathon\b/` never matches the
 * literal text of its own definition, since the `b` of the escape and the `h` of the word are both word
 * characters, so there is no boundary to find. Absent the file, the language rule still holds.
 */
const PHRASE_FILE = join(ROOT, 'tools', 'phrase-blocklist.json');

interface Phrase {
  readonly pattern: RegExp;
  readonly why: string;
}

function phrases(): Phrase[] {
  let raw: { pattern: string; why: string }[];
  try {
    raw = JSON.parse(readFileSync(PHRASE_FILE, 'utf8'));
  } catch {
    return [];
  }
  return raw.map((entry) => ({ pattern: new RegExp(`\\b${entry.pattern}\\b`, 'i'), why: entry.why }));
}

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
    if (full === PHRASE_FILE) continue; // the list is not shipped, so it is not audited
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

function scanFile(file: string, list: readonly Phrase[]): Hit[] {
  const hits: Hit[] = [];
  const shown = relative(ROOT, file).split(sep).join('/');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineAt = index + 1;
    for (const { pattern, why } of list) {
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
  const list = phrases();
  let files = 0;
  for (const file of walk(ROOT)) {
    files += 1;
    hits.push(...scanFile(file, list));
  }

  if (hits.length === 0) {
    console.log(`language audit: ${files} files, no findings (${list.length} phrase rule(s) loaded)`);
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
