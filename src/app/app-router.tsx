import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { WorkspaceWorkbench } from "../features/workspaces/workspace-workbench";

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/workbench" element={<WorkspaceWorkbench />} />
        <Route path="/" element={<Navigate to="/workbench" replace />} />
        <Route path="*" element={<Navigate to="/workbench" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
