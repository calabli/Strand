import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthDialog } from "./components/AuthDialog";
import { TooltipLayer } from "./components/Tooltip";
import "./styles/tokens.css";
import "./styles/app.css";
import { useLang } from "./i18n";

/** 最外层：订阅语言变化，切换语言时整个界面就地重画（不重新加载窗口，不会白屏闪一下） */
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
