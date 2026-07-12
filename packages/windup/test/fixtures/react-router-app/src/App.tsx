import { Routes, Route } from "react-router-dom";
import { Settings } from "./pages/Settings";

export function App() {
  return (
    <Routes>
      <Route path="/settings" element={<Settings />} />
      <Route path="/about" element={<div><a id="back-home" data-testid="about-back">Back</a></div>} />
    </Routes>
  );
}
