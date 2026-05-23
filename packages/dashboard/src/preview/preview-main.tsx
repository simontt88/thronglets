import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PreviewApp } from "./PreviewApp";

const root = document.getElementById("root")!;
createRoot(root).render(
  <StrictMode>
    <PreviewApp />
  </StrictMode>
);
