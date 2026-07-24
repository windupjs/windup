import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/_authenticated/dashboard")({
  component: () => <h1 data-testid="dash-title">Dashboard</h1>,
});
