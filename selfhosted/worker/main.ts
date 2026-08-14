const readyPath = "/tmp/heroloop-worker-ready";

async function heartbeat() {
  await Deno.writeTextFile(readyPath, new Date().toISOString());
}

await heartbeat();
setInterval(() => void heartbeat(), 10_000);
