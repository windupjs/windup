/**
 * Static extraction of interactive elements from JSX/TSX components
 * (SPEC-002, layer 2). Lightweight regex parsing — no running the app, no
 * heavy AST (ts-morph waits until a P2 benchmark justifies it).
 *
 * Zero-hardcode compliance: this module knows SYNTAX (JSX, common web
 * attributes), never specific sites.
 */

export interface StaticElement {
  tag: string;
  id?: string;
  name?: string;
  dataTest?: string;
  type?: string;
  ariaLabel?: string;
  label?: string;
  /** Navigation destination (to/href of links). */
  to?: string;
  /** htmlFor of labels — ties the text to the field's id. */
  htmlFor?: string;
}

// Raw tags + interactive design-system components (shadcn/MUI/Chakra/Ant
// use these NAMES — an ecosystem convention, not any specific site's).
const TAG_START =
  /<(button|input|a|select|textarea|label|Button|IconButton|Input|TextField|Textarea|Select|Combobox|Checkbox|Switch|Radio|Link|NavLink|Label)\b/g;

/**
 * Real end of the JSX tag: a ">" only closes it when outside braces and
 * quotes — inline handlers (onChange={(e) => ...}) contain ">" characters
 * that do not end the tag.
 */
function tagEnd(source: string, from: number): { end: number; selfClosing: boolean } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < Math.min(source.length, from + 2000); i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth <= 0) {
      return { end: i, selfClosing: source[i - 1] === "/" };
    }
  }
  return null;
}

/**
 * Removes balanced {expression} blocks — dynamic attributes are of no
 * interest to the parser. String literals ({"x"}) become plain strings
 * before the strip.
 */
function stripJsxExpressions(text: string): string {
  const literalized = text.replace(/\{\s*(["'`])([^"'`]*)\1\s*\}/g, '"$2"');
  let out = "";
  let depth = 0;
  for (const ch of literalized) {
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

/** Child text only counts if it is human text, not an expression/code. */
function cleanText(raw: string | undefined): string | undefined {
  const text = raw?.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!text || /[{}<>=]/.test(text)) return undefined;
  return text;
}

/** Design-system component → equivalent semantic tag. */
const SEMANTIC_TAG: Record<string, string> = {
  button: "button", iconbutton: "button",
  input: "input", textfield: "input", checkbox: "input", switch: "input", radio: "input",
  textarea: "textarea", select: "select", combobox: "select",
  a: "a", link: "a", navlink: "a",
  label: "label",
};
const ATTR = (name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*["'\`]([^"'\`]*)["'\`]\\s*\\})`, "i");

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(ATTR(name));
  return (m?.[1] ?? m?.[2] ?? m?.[3])?.trim() || undefined;
}

/** Extracts interactive elements declared in a component's source. */
export function extractElements(source: string): StaticElement[] {
  const elements: StaticElement[] = [];
  for (const match of source.matchAll(TAG_START)) {
    const rawTag = match[1];
    const attrsStart = (match.index ?? 0) + match[0].length;
    const endInfo = tagEnd(source, attrsStart);
    if (!endInfo) continue;
    const attrs = stripJsxExpressions(source.slice(attrsStart, endInfo.end));
    const text = endInfo.selfClosing ? undefined : source.slice(endInfo.end + 1, endInfo.end + 61).split("<")[0];
    const tag = SEMANTIC_TAG[rawTag.toLowerCase()] ?? rawTag.toLowerCase();
    const el: StaticElement = {
      tag,
      id: attr(attrs, "id"),
      name: attr(attrs, "name"),
      dataTest: attr(attrs, "data-test") ?? attr(attrs, "data-testid"),
      type: attr(attrs, "type"),
      ariaLabel: attr(attrs, "aria-label"),
      label: cleanText(text) || attr(attrs, "placeholder"),
      to: attr(attrs, "to") ?? (tag === "a" ? attr(attrs, "href") : undefined),
      htmlFor: attr(attrs, "htmlFor") ?? attr(attrs, "for"),
    };
    // Without any identifiable trait, the line does not help the planner.
    // Labels earn their place via the text↔htmlFor pair (they reveal the field's id).
    if (el.id || el.name || el.dataTest || el.ariaLabel || el.to || (el.htmlFor && el.label) || (el.label && tag !== "label")) {
      elements.push(el);
    }
  }
  return dedupe(elements);
}

function dedupe(elements: StaticElement[]): StaticElement[] {
  const seen = new Set<string>();
  return elements.filter((el) => {
    const key = JSON.stringify(el);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Formats in the same vocabulary as the map/prompt lines (browser.interactiveElements). */
export function formatElement(el: StaticElement): string {
  const parts = [el.tag];
  if (el.id) parts.push(`id=${el.id}`);
  if (el.name) parts.push(`name=${el.name}`);
  if (el.dataTest) parts.push(`data-test=${el.dataTest}`);
  if (el.type) parts.push(`type=${el.type}`);
  if (el.ariaLabel) parts.push(`aria-label=${el.ariaLabel}`);
  if (el.to) parts.push(`href=${el.to}`);
  if (el.htmlFor) parts.push(`for=${el.htmlFor}`);
  if (el.label) parts.push(`text=${el.label}`);
  return parts.join(" ");
}
