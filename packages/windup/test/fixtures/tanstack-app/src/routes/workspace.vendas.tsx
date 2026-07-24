import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/workspace/vendas")({
  component: () => <input name="busca-venda" placeholder="Buscar venda" />,
});
