import { createHash } from "node:crypto";

/**
 * Structural page signature (SPEC-001, component 1).
 *
 * Two visits to the SAME screen must produce the same sig even with
 * different data; a changed screen (new element, swapped id) produces a
 * different sig. Hence only the structural traits of interactive elements
 * go in — never text, placeholder, value or classes (they change with
 * data/language), and never the a11y tree (it varies across environments —
 * RESULT #5).
 *
 * Known limitation to MEASURE in E1 (not solve): ids that encode data
 * (e.g. #add-to-cart-<product>) change the sig when the catalog changes.
 */
export interface RawElement {
  tag: string;
  id?: string;
  name?: string;
  dataTest?: string;
  type?: string;
}

function canonical(el: RawElement): string {
  const parts = [el.tag.toLowerCase()];
  if (el.id) parts.push(`id=${el.id.toLowerCase()}`);
  if (el.name) parts.push(`name=${el.name.toLowerCase()}`);
  if (el.dataTest) parts.push(`data-test=${el.dataTest.toLowerCase()}`);
  if (el.type) parts.push(`type=${el.type.toLowerCase()}`);
  return parts.join("|");
}

export function computeSignature(elements: RawElement[]): string {
  // dedupe + sort: insensitive to reordering and to repeated identical
  // elements (e.g. N cards with the same id-less button).
  const lines = [...new Set(elements.map(canonical))].sort();
  const hash = createHash("sha256").update(lines.join("\n")).digest("hex");
  return `sig:${hash.slice(0, 16)}`;
}
