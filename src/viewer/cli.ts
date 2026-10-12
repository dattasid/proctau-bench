// Usage: npm run view -- [--dir out/runs] [--port 8788]
// Serves a browser view of harness runs. Local only: binds to 127.0.0.1.

import { parseArgs } from "node:util";
import { createViewerServer } from "./server.ts";

const { values } = parseArgs({
  options: {
    dir: { type: "string", default: "out/runs" },
    port: { type: "string", default: "8788" },
  },
});

const port = Number(values.port);
createViewerServer(values.dir).listen(port, "127.0.0.1", () => {
  console.log(`Viewing runs in ${values.dir} at http://127.0.0.1:${port}/`);
});
