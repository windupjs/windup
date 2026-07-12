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
}

const INTERACTIVE_TAGS = /<(button|input|a|select|textarea|label)\b([^>]*)>(?:([^<]{0,60}))?/gi;
const ATTR = (name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*["'\`]([^"'\`]*)["'\`]\\s*\\})`, "i");

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(ATTR(name));
  return (m?.[1] ?? m?.[2] ?? m?.[3])?.trim() || undefined;
}

/** Extrai elementos interativos declarados no fonte de um componente. */
export function extractElements(source: string): StaticElement[] {
  const elements: StaticElement[] = [];
  for (const match of source.matchAll(INTERACTIVE_TAGS)) {
    const [, tag, attrs, text] = match;
    const el: StaticElement = {
      tag: tag.toLowerCase(),
      id: attr(attrs, "id"),
      name: attr(attrs, "name"),
      dataTest: attr(attrs, "data-test") ?? attr(attrs, "data-testid"),
      type: attr(attrs, "type"),
      ariaLabel: attr(attrs, "aria-label"),
      label: text?.trim().replace(/\s+/g, " ").slice(0, 40) || attr(attrs, "placeholder"),
    };
    // Sem nenhum traço identificável, a linha não ajuda o planejador.
    if (el.id || el.name || el.dataTest || el.ariaLabel || (el.label && tag.toLowerCase() !== "label")) {
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
  if (el.label) parts.push(`text=${el.label}`);
  return parts.join(" ");
}
