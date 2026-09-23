import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./client.js";
import { logger } from "../logger.js";

async function main() {
  logger.info("Running database migrations");
  await migrate(db, { migrationsFolder: "./drizzle" });
  logger.info("Migrations complete");
  await sql.end();
}

main().catch((error) => {
  logger.error("Migration failed", { error: String(error) });
  process.exit(1);
});
