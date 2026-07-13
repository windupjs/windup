import { Routes, Route } from "react-router-dom";
import { Shell } from "./pages/Shell";
import { Billing } from "./pages/Billing";

export function WrappedRoutes() {
  return (
    <Routes>
      <Route path="/billing" element={<Shell><Billing /></Shell>} />
    </Routes>
  );
}
