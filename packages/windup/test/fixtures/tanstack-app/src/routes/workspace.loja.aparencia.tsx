import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/workspace/loja/aparencia")({
  component: () => <button data-testid="save-aparencia">Salvar aparência</button>,
});
