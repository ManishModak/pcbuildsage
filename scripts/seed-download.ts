import { downloadSeed } from "../src/lib/seed-download-helper";

async function main() {
  const args = process.argv.slice(2);
  let country = "";
  let dbPath = "";
  let releaseUrl = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--country" || args[i] === "-c") {
      country = args[++i];
    } else if (args[i] === "--output" || args[i] === "-o") {
      dbPath = args[++i];
    } else if (args[i] === "--url" || args[i] === "-u") {
      releaseUrl = args[++i];
    }
  }

  if (!country) {
    console.error(
      "Usage: tsx scripts/seed-download.ts --country <ISO-2> [--output <db-path>] [--url <release-url-override>]"
    );
    process.exit(1);
  }

  try {
    await downloadSeed(country, {
      dbPath: dbPath || undefined,
      releaseUrl: releaseUrl || undefined,
      onProgress(percent, message) {
        console.log(`[${percent}%] ${message}`);
      }
    });
    console.log("Download completed successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Download failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
