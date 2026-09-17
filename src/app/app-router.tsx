import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import type { AppComposition } from "./composition/routes";
import { ExtensionNavigation } from "../extension-api/extension-navigation";

export function AppRouter({ composition }: { composition: AppComposition }) {
  return (
    <BrowserRouter>
      <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-purr-base text-content-primary">
        <ExtensionNavigation />
        <div className="min-h-0 flex-1">
          <Routes>
            {composition.routes.map((route) => {
              const Component = route.component;
              return <Route key={route.id} path={route.path} element={<Component />} />;
            })}
            <Route path="/" element={<Navigate to={composition.defaultPath} replace />} />
            <Route path="*" element={<Navigate to={composition.defaultPath} replace />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
}
