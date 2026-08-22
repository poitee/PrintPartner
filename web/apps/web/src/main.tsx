import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ThemeProvider } from "./context/ThemeContext";
import { DateFormatProvider } from "./context/DateFormatContext";
import { queryClient } from "./queries/queryClient";
import "./index.css";
import { registerServiceWorker } from "./lib/registerServiceWorker";

registerServiceWorker();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <DateFormatProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </DateFormatProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
