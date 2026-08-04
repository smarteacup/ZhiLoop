import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { setCsrfToken } from "./api/client.js";
import { exchangeBootstrapToken, resumeBrowserSession, takeBootstrapToken } from "./api/bootstrap.js";
import { App } from "./app/App.js";
import "./styles.css";

async function exchangeBootstrap(): Promise<void> {
  const bootstrap = takeBootstrapToken(window.location.hash);
  if (bootstrap === undefined) {
    setCsrfToken(await resumeBrowserSession());
    return;
  }
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  setCsrfToken(await exchangeBootstrapToken(bootstrap));
}

await exchangeBootstrap();
const root = document.getElementById("root");
if (root === null) throw new Error("Console root is missing");
createRoot(root).render(<StrictMode><App /></StrictMode>);
