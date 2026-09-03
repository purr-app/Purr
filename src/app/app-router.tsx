import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { RequestWorkbench } from "../features/request-workbench/request-workbench";

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/workbench" element={<RequestWorkbench />} />
        <Route path="/" element={<Navigate to="/workbench" replace />} />
        <Route path="*" element={<Navigate to="/workbench" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
