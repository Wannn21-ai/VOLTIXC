import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(rootDir, "web");
const outputDir = path.join(rootDir, "dist");
const localEnvPath = path.join(rootDir, ".env.local");

const firebaseVariables = {
  FIREBASE_API_KEY: "NETLIFY_ENV_FIREBASE_API_KEY",
  FIREBASE_AUTH_DOMAIN: "NETLIFY_ENV_FIREBASE_AUTH_DOMAIN",
  FIREBASE_DATABASE_URL: "NETLIFY_ENV_FIREBASE_DATABASE_URL",
  FIREBASE_PROJECT_ID: "NETLIFY_ENV_FIREBASE_PROJECT_ID",
  FIREBASE_STORAGE_BUCKET: "NETLIFY_ENV_FIREBASE_STORAGE_BUCKET",
  FIREBASE_MESSAGING_SENDER_ID: "NETLIFY_ENV_FIREBASE_MESSAGING_SENDER_ID",
  FIREBASE_APP_ID: "NETLIFY_ENV_FIREBASE_APP_ID",
};

function parseEnvFile(contents) {
  const parsed = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

function escapeHtmlAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function htmlFilesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await htmlFilesUnder(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".html")) files.push(entryPath);
  }
  return files;
}

if (existsSync(localEnvPath)) {
  const localValues = parseEnvFile(await readFile(localEnvPath, "utf8"));
  for (const [name, value] of Object.entries(localValues)) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
  console.log("[build:web] Loaded local environment variable names from .env.local.");
}

const missingVariables = Object.keys(firebaseVariables)
  .filter(name => !process.env[name]?.trim());
const injectFirebaseConfig = missingVariables.length === 0;

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await cp(sourceDir, outputDir, { recursive: true });

const htmlFiles = await htmlFilesUnder(outputDir);

if (!injectFirebaseConfig) {
  console.warn(`[build:web] Firebase config incomplete. Missing: ${missingVariables.join(", ")}`);
  console.warn("[build:web] Preserving all placeholders; dist will run in local visual mode.");
} else {
  const replacementCounts = Object.fromEntries(
    Object.values(firebaseVariables).map(placeholder => [placeholder, 0])
  );

  for (const htmlFile of htmlFiles) {
    let html = await readFile(htmlFile, "utf8");
    const missingInFile = Object.values(firebaseVariables)
      .filter(placeholder => !html.includes(placeholder));
    if (missingInFile.length > 0) {
      throw new Error(
        `${path.relative(outputDir, htmlFile)} is missing Firebase placeholders: ${missingInFile.join(", ")}`
      );
    }

    for (const [name, placeholder] of Object.entries(firebaseVariables)) {
      const occurrences = html.split(placeholder).length - 1;
      replacementCounts[placeholder] += occurrences;
      html = html.replaceAll(placeholder, escapeHtmlAttribute(process.env[name].trim()));
    }
    await writeFile(htmlFile, html, "utf8");
  }

  const unusedPlaceholders = Object.entries(replacementCounts)
    .filter(([, count]) => count === 0)
    .map(([placeholder]) => placeholder);
  if (unusedPlaceholders.length > 0) {
    throw new Error(`Expected Firebase placeholders were not found: ${unusedPlaceholders.join(", ")}`);
  }
  console.log(`[build:web] Injected Firebase config into ${htmlFiles.length} HTML files without printing values.`);
}

console.log(`[build:web] Copied web/ assets to dist/ (${htmlFiles.length} HTML files).`);
