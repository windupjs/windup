// Rotas construídas dinamicamente — a camada estática (regex) não alcança.
import { createBrowserRouter } from "react-router-dom";
import { ReportPage } from "./pages/ReportPage";

const reportKinds = ["billing", "audit"];

export const reportRouter = createBrowserRouter(
  reportKinds.map((kind) => ({
    path: `/reports/${kind}`,
    element: <ReportPage kind={kind} />,
  })),
);
