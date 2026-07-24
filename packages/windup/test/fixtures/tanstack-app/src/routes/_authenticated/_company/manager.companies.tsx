import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/_authenticated/_company/manager/companies")({
  component: () => <a href="/workspace" data-testid="enter-company">Acessar</a>,
});
