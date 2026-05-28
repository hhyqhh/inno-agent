import "./app.css";
import "./i18n/index.js";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./react/App.js";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

createRoot(rootEl).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

console.log("[inno-web] React initialized");
