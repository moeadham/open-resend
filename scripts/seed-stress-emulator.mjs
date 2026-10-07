import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");

run(["d1", "migrations", "apply", "cloudflare-resend", "--local"]);
run(["d1", "execute", "cloudflare-resend", "--local", "--file", "scripts/stress-emulator.sql"]);

function run(args) {
  const result = spawnSync(wrangler, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
