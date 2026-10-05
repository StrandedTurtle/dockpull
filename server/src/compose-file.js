/**
 * Minimal, conservative compose-file editing: change ONE service's `image:`
 * tag in place, leaving every other byte (comments, quoting, ordering,
 * formatting) untouched. Used by "Switch to <newer tag>".
 *
 * Deliberately not a YAML round-trip (that would reformat the user's file).
 * Instead it finds the service block by indentation and refuses anything it
 * can't change with certainty — the image coming from a variable, an anchor
 * or `extends`, a digest pin, or a value that isn't the image the container
 * actually runs. Pure (string in, string out) so it's fully unit-testable.
 */

import { normalizeRef, parseRef } from './reconcile.js';

export class ComposeEditError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const indentOf = (line) => line.length - line.trimStart().length;
const isBlankOrComment = (line) => /^\s*(#.*)?$/.test(line);
const unquote = (v) => v.replace(/^(['"])(.*)\1$/, '$2');

/**
 * Locate a service's `image:` line.
 *
 * @returns {{ index: number, value: string, quote: string, before: string, after: string }|null}
 */
export function findServiceImage(text, service) {
  const lines = text.split('\n');
  const servicesIdx = lines.findIndex((l) => /^services:\s*(#.*)?$/.test(l));
  if (servicesIdx === -1) return null;

  const escaped = service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyRe = new RegExp(`^(\\s+)(?:${escaped}|"${escaped}"|'${escaped}'):\\s*(#.*)?$`);
  let svcIdx = -1;
  let svcIndent = -1;
  let serviceKeyIndent = -1; // indentation of the service names under services:
  for (let i = servicesIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    const ind = indentOf(line);
    if (ind === 0) break; // left the services: block
    if (serviceKeyIndent === -1) serviceKeyIndent = ind;
    if (ind !== serviceKeyIndent) continue; // a setting inside some service
    const m = keyRe.exec(line);
    if (m) {
      svcIdx = i;
      svcIndent = ind;
      break;
    }
  }
  if (svcIdx === -1) return null;

  let childIndent = -1;
  for (let i = svcIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    const ind = indentOf(line);
    if (ind <= svcIndent) break; // end of this service
    if (childIndent === -1) childIndent = ind;
    if (ind !== childIndent) continue; // nested deeper (environment entries etc.)
    const m = /^(\s*image:\s*)(.*?)(\s*(?:#.*)?)$/.exec(line);
    if (m) {
      const raw = m[2];
      const quote = /^(['"]).*\1$/.test(raw) ? raw[0] : '';
      return { index: i, value: unquote(raw), quote, before: m[1], after: m[3] };
    }
  }
  return null;
}

/**
 * Pure: rewrite `service`'s image to use `newTag`, keeping the user's own
 * spelling of the repository (e.g. `postgres`, not `docker.io/library/postgres`).
 *
 * @param {string} text - compose file contents.
 * @param {string} service
 * @param {string} expectedImage - the image ref the container runs now; the
 *   file must name the same image (normalized), or we refuse.
 * @param {string} newTag
 * @returns {{ text: string, oldValue: string, newValue: string }}
 * @throws {ComposeEditError}
 */
export function rewriteServiceImageTag(text, service, expectedImage, newTag) {
  const found = findServiceImage(text, service);
  if (!found) {
    throw new ComposeEditError(
      'image_not_found',
      `Couldn't find an "image:" line for service "${service}" in the compose file (it may come from an anchor or "extends").`
    );
  }
  const { value } = found;
  if (value.includes('$')) {
    throw new ComposeEditError(
      'image_uses_variable',
      `Service "${service}" sets its image from a variable (${value}); change the variable instead.`
    );
  }
  let parsed;
  try {
    parsed = parseRef(value);
  } catch {
    throw new ComposeEditError('image_unparseable', `Couldn't understand the image "${value}".`);
  }
  if (parsed.digest) {
    throw new ComposeEditError('image_pinned_by_digest', `Service "${service}" pins its image by digest (${value}).`);
  }
  let same = false;
  try {
    same = normalizeRef(value) === normalizeRef(expectedImage);
  } catch {
    same = false;
  }
  if (!same) {
    throw new ComposeEditError(
      'image_mismatch',
      `The compose file says "${value}" but the container runs "${expectedImage}" — not changing it.`
    );
  }

  // Keep the user's spelling of the repo; swap only the tag.
  const lastSlash = value.lastIndexOf('/');
  const colon = value.lastIndexOf(':');
  const repoPart = colon > lastSlash ? value.slice(0, colon) : value;
  const newValue = `${repoPart}:${newTag}`;

  const lines = text.split('\n');
  lines[found.index] = `${found.before}${found.quote}${newValue}${found.quote}${found.after}`;
  return { text: lines.join('\n'), oldValue: value, newValue };
}

/**
 * Pure: put a service's image back to `oldValue` (undo a tag switch), but only
 * if the file still names `newValue` there — never clobber a later hand edit.
 *
 * @returns {string|null} the restored text, or null if the file changed since.
 */
export function restoreServiceImage(text, service, newValue, oldValue) {
  const found = findServiceImage(text, service);
  if (!found || found.value !== newValue) return null;
  const lines = text.split('\n');
  lines[found.index] = `${found.before}${found.quote}${oldValue}${found.quote}${found.after}`;
  return lines.join('\n');
}

export default { findServiceImage, rewriteServiceImageTag, restoreServiceImage, ComposeEditError };
