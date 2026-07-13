/**
 * Extração estática de elementos interativos de componentes JSX/TSX
 * (SPEC-002, camada 2). Parse leve por regex — sem executar o app, sem AST
 * pesado (ts-morph fica para quando um benchmark do P2 justificar).
 *
 * Conformidade zero-hardcode: este módulo conhece SINTAXE (JSX, atributos
 * comuns da web), nunca sites específicos.
 */

export interface StaticElement {
  tag: string;
  id?: string;
  name?: string;
  dataTest?: string;
  type?: string;
  ariaLabel?: string;
  label?: string;
  /** Destino de navegação (to/href de links). */
  to?: string;
  /** htmlFor de labels — liga o texto ao id do campo. */
  htmlFor?: string;
}

// Tags cruas + componentes interativos de design systems (shadcn/MUI/Chakra/
// Ant usam estes NOMES — convenção do ecossistema, não de nenhum site).
const TAG_START =
  /<(button|input|a|select|textarea|label|Button|IconButton|Input|TextField|Textarea|Select|Combobox|Checkbox|Switch|Radio|Link|NavLink|Label)\b/g;

/**
 * Fim real da tag JSX: um ">" só encerra quando fora de chaves e aspas —
 * handlers inline (onChange={(e) => ...}) contêm ">" que não terminam a tag.
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
 * Remove blocos {expressão} balanceados — atributos dinâmicos não interessam
 * ao parser. Literais de string ({"x"}) viram string normal antes do strip.
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

/** Texto-filho só vale se for texto humano, não expressão/código. */
function cleanText(raw: string | undefined): string | undefined {
  const text = raw?.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!text || /[{}<>=]/.test(text)) return undefined;
  return text;
}

/** Componente de design system → tag semântica equivalente. */
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

/** Extrai elementos interativos declarados no fonte de um componente. */
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
    // Sem nenhum traço identificável, a linha não ajuda o planejador.
    // Labels valem pelo par texto↔htmlFor (revelam o id do campo).
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

/** Formata no mesmo vocabulário das linhas do mapa/prompt (browser.interactiveElements). */
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
