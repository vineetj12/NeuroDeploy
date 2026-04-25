import http from "node:http";
import { FIX_PROJECT_QUEUE_NAME } from "../queue/fixProjectQueue.ts";
import "./fixProjectWorker.ts";

const port = Number(process.env.WORKER_PORT) || 10000;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "fix-project-worker",
        queue: FIX_PROJECT_QUEUE_NAME,
      })
    );
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("fix-project worker service is running\n");
});

server.listen(port, () => {
  console.log(`[fixProjectWorker] health server listening on port ${port}`);
});


