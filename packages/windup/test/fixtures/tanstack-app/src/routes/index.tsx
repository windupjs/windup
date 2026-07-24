import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/")({
  component: () => <a href="/workspace/vendas" data-testid="go-vendas">Vendas</a>,
});
