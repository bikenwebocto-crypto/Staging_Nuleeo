// Local-development bootstrap. In production, the same Express app is served
// by a Firebase Function (see functions/src/index.ts).
import "dotenv/config";
import { createServer } from "http";
import { createApp, log } from "./app";

const app = createApp();
const httpServer = createServer(app);

const port = parseInt(process.env.PORT || "5001", 10);
httpServer.listen({ port, host: "0.0.0.0" }, () => {
  log(`serving on port ${port}`);
});
