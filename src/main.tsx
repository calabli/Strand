import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthDialog } from "./components/AuthDialog";
import { TooltipLayer } from "./components/Tooltip";
import "./styles/tokens.css";
import "./styles/app.css";
import { useLang } from "./i18n";

/** Root: subscribes to language changes; switching re-draws the whole UI in place (no window reload, no white flash) */
function Root() {
  useLang();
  return (
    <>
      <App />
      <AuthDialog />
      <TooltipLayer />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
