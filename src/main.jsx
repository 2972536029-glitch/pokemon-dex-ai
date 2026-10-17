import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { initTelemetry } from "./telemetry/telemetry.js";
import "./styles.css";

// RUM 采集在 render 前安装:首屏 PV/web-vitals 一个都不漏(幂等,StrictMode 安全)
initTelemetry();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
