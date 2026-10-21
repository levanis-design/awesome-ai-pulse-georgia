/** Entry point of the gateway container, bundled to dist/gateway.js (see tsup.config.ts and the Dockerfile). */
import { startGateway } from "./start.js";
import { log } from "./log.js";

try {
  startGateway();
} catch (err) {
  log.error("gateway did not start", { error: (err as Error).message });
  process.exit(1);
}
