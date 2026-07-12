// Config de navegação — path: aqui NÃO é rota do react-router.
import { useNavigate } from "react-router-dom";

export const menuItems = [
  { path: "/reports/sales", label: "Sales report", icon: "chart" },
  { path: "/admin/users", label: "Users", icon: "people" },
];

export const apiEndpoints = [
  { path: "/api/v1/orders", method: "GET" },
];

export function useMenuNav() {
  return useNavigate();
}
