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
const INTERACTIVE_TAGS =
  /<(button|input|a|select|textarea|label|Button|IconButton|Input|TextField|Textarea|Select|Combobox|Checkbox|Switch|Radio|Link|NavLink|Label)\b([^>]*?)(?:\/)?>(?:([^<]{0,60}))?/g;

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
  for (const match of source.matchAll(INTERACTIVE_TAGS)) {
    const [, rawTag, attrs, text] = match;
    const tag = SEMANTIC_TAG[rawTag.toLowerCase()] ?? rawTag.toLowerCase();
    const el: StaticElement = {
      tag,
      id: attr(attrs, "id"),
      name: attr(attrs, "name"),
      dataTest: attr(attrs, "data-test") ?? attr(attrs, "data-testid"),
      type: attr(attrs, "type"),
      ariaLabel: attr(attrs, "aria-label"),
      label: text?.trim().replace(/\s+/g, " ").slice(0, 40) || attr(attrs, "placeholder"),
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
