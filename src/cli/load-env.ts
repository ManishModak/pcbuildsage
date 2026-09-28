// Side-effect import: must be the first import of the CLI entry so provider
// keys from the project .env are in process.env before any module reads them.
import { loadEnvFileIfPresent } from "./env";

loadEnvFileIfPresent();
