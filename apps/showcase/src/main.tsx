// The showcase runs the product's real UI against a mock backend, so the
// fetch shim must be installed before any store/component issues a request.
import { installMockFetch } from "./mock/runtime.js";
installMockFetch();

// Full product stylesheet (pi-web-ui css + tailwind + themes + chat styles).
import "@inno-web/app.css";
import "./i18n.js";
// Register <markdown-block> explicitly — QuestionDialog depends on it (same
// reasoning as the product's main.tsx).
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { themeStore } from "@inno-web/stores/theme-store.js";
import "./showcase.css";

// The showcase always wears the innospark theme, regardless of what theme a
// visitor's localStorage carries over from the product on this origin.
themeStore.apply("innospark");

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@inno-web/react/ui/Tooltip.js";
import { App } from "./App.js";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

createRoot(rootEl).render(
	<StrictMode>
		<TooltipProvider delayDuration={450} skipDelayDuration={250}>
			<App />
		</TooltipProvider>
	</StrictMode>,
);
