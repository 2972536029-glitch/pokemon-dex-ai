// Vercel serverless entry: mount the same Express app as a request handler.
// SSE streaming works on the Node runtime; maxDuration is raised to 60s in
// vercel.json because tool rounds + model generation can outlast the 10s
// default.
import { createApp } from "../server/src/app.js";

const app = createApp();

export default app;
