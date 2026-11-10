import crypto from "node:crypto";

const jobs = new Map();

export function startJob(name, runner) {
  const id = crypto.randomBytes(4).toString("hex");
  const job = {
    id,
    name,
    status: "running",
    logs: [],
    result: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    subscribers: new Set(),
  };
  jobs.set(id, job);

  const log = (message, level = "info") => {
    const entry = { at: Date.now(), level, message: String(message) };
    job.logs.push(entry);
    for (const response of job.subscribers) {
      response.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
  };

  (async () => {
    try {
      job.result = await runner(log);
      job.status = "done";
      log("Fertig.");
    } catch (error) {
      job.status = "error";
      job.error = error.message || String(error);
      log(job.error, "error");
    } finally {
      job.finishedAt = Date.now();
      for (const response of job.subscribers) {
        response.write(
          `event: end\ndata: ${JSON.stringify({ status: job.status, result: job.result, error: job.error })}\n\n`,
        );
        response.end();
      }
      job.subscribers.clear();
    }
  })();

  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    logs: job.logs,
    result: job.result,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

export function subscribe(id, response) {
  const job = jobs.get(id);
  if (!job) return false;
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(`retry: 2000\n\n`);
  for (const entry of job.logs) response.write(`data: ${JSON.stringify(entry)}\n\n`);
  if (job.status !== "running") {
    response.write(`event: end\ndata: ${JSON.stringify({ status: job.status, result: job.result, error: job.error })}\n\n`);
    response.end();
    return true;
  }
  job.subscribers.add(response);
  const heartbeat = setInterval(() => response.write(`: ping\n\n`), 15000);
  response.on("close", () => {
    clearInterval(heartbeat);
    job.subscribers.delete(response);
  });
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff && job.subscribers.size === 0) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();
