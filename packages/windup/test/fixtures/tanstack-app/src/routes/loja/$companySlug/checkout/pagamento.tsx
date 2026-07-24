import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/loja/$companySlug/checkout/pagamento")({
  component: () => <button id="pay-now" data-testid="pay">Pagar</button>,
});
