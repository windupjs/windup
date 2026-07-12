import { createHash } from "node:crypto";

/**
 * Assinatura estrutural de página (SPEC-001, componente 1).
 *
 * Duas visitas à MESMA tela devem produzir a mesma sig mesmo com dados
 * diferentes; uma tela alterada (elemento novo, id trocado) produz sig
 * diferente. Por isso entram só os traços estruturais dos elementos
 * interativos — nunca texto, placeholder, value ou classes (mudam com
 * dado/idioma), e nunca a árvore a11y (varia entre ambientes — RESULTADO #5).
 *
 * Limitação conhecida a MEDIR no E1 (não resolver): ids que codificam dado
 * (ex.: #add-to-cart-<produto>) mudam a sig quando o catálogo muda.
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
  // dedupe + sort: insensível a reordenação e a repetição de elementos
  // idênticos (ex.: N cards com o mesmo botão sem id).
  const lines = [...new Set(elements.map(canonical))].sort();
  const hash = createHash("sha256").update(lines.join("\n")).digest("hex");
  return `sig:${hash.slice(0, 16)}`;
}
