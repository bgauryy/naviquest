/**
 * Where this skill writes: one derivation, imported by the launcher, the runner
 * and the sandbox instead of being spelled out three times.
 *
 * It replaces a vendored 835-line config resolver that these scripts used for
 * exactly two things — this path, and loading `~/.octocode/.env` into the
 * process environment. The second was worse than unused: it pulled a
 * developer's API tokens into a process whose whole job is driving untrusted
 * pages. Chrome needs no tokens, so nothing here reads a secret.
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const ARTIFACT_DIR = '.naviquest';

/**
 * The artifact root: `<cwd>/.naviquest` when the working directory is
 * writable (so runs stay next to the checkout being tested and are covered by
 * its gitignore), otherwise a temp fallback — a read-only cwd must not stop a
 * browser run.
 */
export function outputBase(cwd = process.cwd()) {
  const local = resolve(cwd, ARTIFACT_DIR);
  try {
    mkdirSync(local, { recursive: true, mode: 0o700 });
    return local;
  } catch {
    const fallback = join(tmpdir(), 'naviquest-chrome');
    mkdirSync(fallback, { recursive: true, mode: 0o700 });
    return fallback;
  }
}
