import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DashboardPage } from "./pages/DashboardPage";
import { EmbedPage } from "./pages/EmbedPage";
import { isEmbedPath, parseEmbedRoute } from "./platform/embedRoute";
import "./reset.css";
const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
createRoot(root).render(<StrictMode>{isEmbedPath(window.location.pathname) ? <EmbedPage route={parseEmbedRoute(window.location.pathname, window.location.search)} /> : <DashboardPage />}</StrictMode>);
