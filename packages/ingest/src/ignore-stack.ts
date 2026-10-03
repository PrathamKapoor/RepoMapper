/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion --
 * `ignore` is CommonJS and its major versions disagree about the export shape, so the
 * imported value's static type differs depending on which version the resolver picks.
 * The assertion below is the one place that ambiguity is reconciled; suppressing the
 * rule here is deliberate rather than incidental.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ignoreImport, { type Ignore } from 'ignore';

/**
 * Interop shim for the `ignore` package.
 *
 * `ignore` is CommonJS and its two major lines ship incompatible declaration styles:
 * v5 ends in `export default ignore`, v7 in `export = ignore`. Under NodeNext module
 * resolution neither form makes a plain default import reliably callable from ESM — the
 * import yields the module namespace, and calling it is a type error. This was found by
 * building the Linux container image, not by a local test run.
 *
 * Rather than depending on a particular major version's typings, the factory is resolved
 * at runtime from whichever shape the resolver provides, and a missing factory throws a
 * named error instead of failing later with `undefined is not a function`.
 */
type IgnoreFactory = (options?: { ignorecase?: boolean }) => Ignore;

/** Either the factory itself, or a namespace object carrying it on `.default`. */
type IgnoreExport = IgnoreFactory | { default?: IgnoreFactory | { default?: IgnoreFactory } };

function resolveIgnoreFactory(value: IgnoreExport): IgnoreFactory {
  if (typeof value === 'function') return value;

  const fallback = value.default;
  if (typeof fallback === 'function') return fallback;
  if (fallback && typeof fallback.default === 'function') return fallback.default;

  throw new Error(
    "The 'ignore' package did not export a factory function; RepoAtlas cannot evaluate .gitignore rules.",
  );
}

const createIgnore = resolveIgnoreFactory(ignoreImport as unknown as IgnoreExport);
/* eslint-enable @typescript-eslint/no-unnecessary-type-assertion */

/**
 * Layered `.gitignore` evaluation.
 *
 * A repository can have a `.gitignore` at any directory level, and a nested ignore
 * file overrides its parent for paths beneath it. This stack reproduces that
 * precedence: patterns are pushed as the walk descends and popped as it ascends.
 *
 * Repository-provided ignore files are untrusted input. They are fed to `ignore` as
 * plain patterns; nothing in a `.gitignore` can cause a filesystem write or spawn a
 * process.
 */

const IGNORE_FILES = ['.gitignore', '.ignore'] as const;

export class IgnoreStack {
  private readonly layers: { dir: string; ig: Ignore }[] = [];

  /** Loads any ignore files present in `dir` (called on entry to a directory). */
  async push(dir: string): Promise<void> {
    for (const name of IGNORE_FILES) {
      try {
        const contents = await readFile(join(dir, name), 'utf8');
        const ig = createIgnore().add(contents);
        this.layers.push({ dir, ig });
      } catch {
        // Missing or unreadable ignore file is normal and not worth reporting.
      }
    }
  }

  pop(dir: string): void {
    for (let i = this.layers.length - 1; i >= 0; i -= 1) {
      const layer = this.layers[i];
      if (layer && layer.dir === dir) this.layers.splice(i, 1);
    }
  }

  /**
   * True when `relativePath` (repository-relative, POSIX) is ignored.
   * Nested layers win, matching git's own behaviour.
   */
  isIgnored(relativePath: string): boolean {
    for (let i = this.layers.length - 1; i >= 0; i -= 1) {
      const layer = this.layers[i];
      if (!layer) continue;
      // `ignore` matches path segments, so a nested .gitignore sees the full path
      // and correctly anchors its own patterns.
      if (layer.ig.ignores(relativePath)) return true;
    }
    return false;
  }

  /** True when a directory is ignored, so the walk can prune instead of descending. */
  isIgnoredDirectory(relativeDir: string): boolean {
    return this.isIgnored(`${relativeDir}/`);
  }
}
