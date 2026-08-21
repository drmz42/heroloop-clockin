import { Pool } from "@db/postgres";

const readyPath = "/tmp/heroloop-worker-ready";
const pool = new Pool({
  applicationName: "heroloop-worker",
  database: Deno.env.get("PGDATABASE"),
  hostname: Deno.env.get("PGHOST"),
  password: Deno.env.get("PGPASSWORD"),
  port: Number(Deno.env.get("PGPORT") ?? "5432"),
  user: Deno.env.get("PGUSER"),
  connection: { attempts: 2, interval: 500 },
  options: {
    idle_in_transaction_session_timeout: "5000",
    lock_timeout: "3000",
    statement_timeout: "20000",
  },
  tls: { enabled: false, enforce: false },
}, Number(Deno.env.get("PGPOOL_SIZE") ?? "2"), true);

async function heartbeat() {
  await Deno.writeTextFile(readyPath, new Date().toISOString());
}

await heartbeat();

async function runTick() {
  const client = await pool.connect();
  try {
    await client.queryObject(
      "SELECT heroloop_worker.run_distribution_tick($1::timestamptz) AS result",
      [new Date().toISOString()],
    );
    await heartbeat();
  } catch (error) {
    console.error("worker distribution tick failed", {
      error: error instanceof Error ? error.message : "unknown_error",
    });
  } finally {
    client.release();
  }
}

await runTick();
setInterval(() => void runTick(), 30_000);
