import { loadConfig } from "./config.js";
import { startServer } from "./app.js";
import { interruptPrinterUploadsOnShutdown } from "./services/printer-send-queue.js";

const config = loadConfig();

startServer(config)
  .then(({ app, ports }) => {
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      app.log.info({ signal }, "received shutdown signal, draining connections");
      void (async () => {
        try {
          interruptPrinterUploadsOnShutdown(config.dataDir, ports);
          await app.close();
          await ports.db.close();
          process.exit(0);
        } catch (err) {
          app.log.error(err, "graceful shutdown failed");
          process.exit(1);
        }
      })();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
