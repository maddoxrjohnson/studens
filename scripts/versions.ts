import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const usage = "Usage: npm run version:check | npm run version:bump -- <version>";
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

// Only string values change. Align JSON string tokens to retain the source's
// whitespace, escapes, and inline arrays, including every dependency record.
function editStrings(source: string, before: string, after: string): string {
  const strings = /"(?:\\.|[^"\\])*"/g;
  const oldTokens = before.match(strings)!;
  const newTokens = after.match(strings)!;
  let index = 0;
  const edited = source.replace(strings, (token) => {
    const oldToken = oldTokens[index];
    const newToken = newTokens[index++];
    if (JSON.parse(token) !== JSON.parse(oldToken))
      throw new Error("Cannot align manifest fields with their source. Check JSON property order.");
    return oldToken === newToken ? token : newToken;
  });
  if (index !== oldTokens.length || JSON.stringify(JSON.parse(edited)) !== after)
    throw new Error("Version edit did not match the planned manifest. No files were written.");
  return edited;
}

try {
  const [command, version] = args;
  if (!((command === "check" && args.length === 1) || (command === "bump" && args.length === 2)))
    throw new Error(usage);
  if (command === "bump" && !semver.test(version))
    throw new Error(`Invalid version ${JSON.stringify(version)}. Use an exact SemVer version.`);

  // Read and validate every document before writing any of them. Never run npm install.
  const files = [
    "package.json",
    "package-lock.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
  ];
  const sources = files.map((file) => fs.readFileSync(path.join(root, file), "utf8"));
  const documents = sources.map((source) => JSON.parse(source));
  const [pkg, lock, codex, claude, ...marketplaces] = documents;
  const entries = marketplaces.map((marketplace, index) => {
    const entry = marketplace.plugins?.find((item: { name: string }) => item.name === pkg.name);
    const source = entry?.source;
    if (
      source?.source !== "url" ||
      source.url !== "https://github.com/maddoxrjohnson/studens.git" ||
      typeof source.ref !== "string" ||
      !source.ref.startsWith("v") ||
      !semver.test(source.ref.slice(1)) ||
      source.sha !== undefined
    )
      throw new Error(`${files[index + 4]} must pin ${pkg.name} to a v<version> release tag.`);
    return entry;
  });
  const fields = [
    ["package.json version", pkg.version],
    ["package-lock.json version", lock.version],
    ['package-lock.json packages[""].version', lock.packages?.[""]?.version],
    [".codex-plugin/plugin.json version", codex.version],
    [".claude-plugin/plugin.json version", claude.version],
    ...entries.map((entry, index) => [files[index + 4] + " release", entry.source.ref.slice(1)]),
  ];
  for (const [label, value] of fields) {
    if (typeof value !== "string" || !semver.test(value))
      throw new Error(`${label} must be an exact SemVer version; found ${JSON.stringify(value)}.`);
  }
  const readmeFile = path.join(root, "README.md");
  const readme = fs.readFileSync(readmeFile, "utf8");
  const install = /pi install git:github\.com\/maddoxrjohnson\/studens@v([^\s`]+)/g;
  const commands = [...readme.matchAll(install)];
  if (commands.length !== 1 || !semver.test(commands[0][1]))
    throw new Error("README.md must contain one Pi install command pinned to v<version>.");
  fields.push(["README.md Pi install release", commands[0][1]]);
  if (command === "check") {
    if (fields.some(([, value]) => value !== pkg.version))
      throw new Error(
        `Release versions differ:\n${fields.map(([label, value]) => `  ${label}: ${value}`).join("\n")}\nRun npm run version:bump -- <version> to synchronize them.`,
      );
    console.log(`Release versions agree: ${pkg.version}`);
  } else {
    const before = documents.map((document) => JSON.stringify(document));
    pkg.version =
      lock.version =
      lock.packages[""].version =
      codex.version =
      claude.version =
        version;
    for (const entry of entries) entry.source.ref = `v${version}`;
    const writes = documents.map((document, index) => ({
      file: path.join(root, files[index]),
      content: editStrings(sources[index], before[index], JSON.stringify(document)),
    }));
    writes.push({
      file: readmeFile,
      content: readme.replace(
        install,
        `pi install git:github.com/maddoxrjohnson/studens@v${version}`,
      ),
    });
    for (const { file, content } of writes) fs.writeFileSync(file, content);
    console.log(`Set all release versions to ${version}. No commit or tag created.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
