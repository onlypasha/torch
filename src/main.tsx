import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { setRuntimeConfig } from "./config";
import type { AppConfig } from "./config";
import "./App.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);
const View = React.lazy(() => location.search.includes("settings") ? import("./Settings") : import("./App"));
void invoke<AppConfig>("config_get").then((config) => {
  setRuntimeConfig(config);
  root.render(<React.StrictMode><React.Suspense fallback={null}><View /></React.Suspense></React.StrictMode>);
}).catch(() => root.render(<p style={{color:"white",padding:24}}>Pengaturan tidak dapat dimuat. Jalankan ulang NotchApp.</p>));
