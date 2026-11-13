import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthDialog } from "./components/AuthDialog";
import "./styles/tokens.css";
import "./styles/app.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <AuthDialog />
  </React.StrictMode>,
);
