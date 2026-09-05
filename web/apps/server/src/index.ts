import { loadConfig } from "./config.js";
import { startServer } from "./app.js";
import { initializePrinterErrorReporting, shutdownPrinterErrorReporting } from "./services/printer-error-reporting.js";

const config = loadConfig();
initializePrinterErrorReporting(config);

startServer(config)
  .then(({ app, ports }) => {
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      app.log.info({ signal }, "received shutdown signal, draining connections");
      void (async () => {
        try {
          await app.close();
          await ports.db.close();
          await shutdownPrinterErrorReporting();
          process.exit(0);
        } catch (err) {
          app.log.error(err, "graceful shutdown failed");
          await shutdownPrinterErrorReporting();
          process.exit(1);
        }
      })();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  })
  .catch(async (err) => {
    console.error(err);
    await shutdownPrinterErrorReporting();
    process.exit(1);
  });
