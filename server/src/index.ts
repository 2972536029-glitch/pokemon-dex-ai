// HTTP entry for local / Docker: listen on a real port.
//
// Why a server at all (vs. calling the LLM from the browser):
// 1. The API key must never reach the browser — anything shipped to a
//    client is public, so model credentials live here and only here.
// 2. Tool calling is a multi-round loop; doing it client-side would leak
//    PokeAPI orchestration and make the SSE payload format mandatory to
//    keep stable. The server owns the loop, the browser just renders.
// 3. SSE needs explicit proxy-unfriendly headers + heartbeats; that
//    plumbing belongs to infrastructure, not UI code.
//
// The app itself is assembled in app.ts; the Vercel serverless entry
// (../../api/index.ts) mounts the same app without listening.
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 5178);
const app = createApp();

app.listen(PORT, () => {
  const isMock = process.env.MOCK_LLM === "1" || !process.env.GLM_API_KEY;
  console.log(
    `[ai-chat] listening on http://localhost:${PORT} (model: ${isMock ? "mock" : process.env.GLM_MODEL ?? "glm-4-flash"})`
  );
});
