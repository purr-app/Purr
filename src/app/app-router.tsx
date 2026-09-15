import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import type { AppComposition } from "./composition/routes";

export function AppRouter({ composition }: { composition: AppComposition }) {
  return (
    <BrowserRouter>
      <Routes>
        {composition.routes.map((route) => {
          const Component = route.component;
          return <Route key={route.id} path={route.path} element={<Component />} />;
        })}
        <Route path="/" element={<Navigate to={composition.defaultPath} replace />} />
        <Route path="*" element={<Navigate to={composition.defaultPath} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
