import { createBrowserRouter } from "react-router-dom";
import { Login } from "./pages/Login";
import Dashboard from "./pages/Dashboard";

export const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  { path: "/dashboard", element: <Dashboard /> },
  { path: "/orders/:id", lazy: () => import("./pages/OrderDetail") },
]);
