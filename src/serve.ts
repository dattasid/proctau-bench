// Usage: npm run serve -- [--port 8787]

import { parseArgs } from "node:util";
import { createEnvServer } from "./server.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "8787" } } });
const port = Number(values.port);
createEnvServer().listen(port, () => console.log(`procbank executor listening on http://localhost:${port}`));
