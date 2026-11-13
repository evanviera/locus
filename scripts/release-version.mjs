import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2]?.trim();

if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: npm run release:version -- <semver>");
  process.exit(1);
}

updateJson("package.json", (json) => {
  json.version = version;
});

updateJson("package-lock.json", (json) => {
  json.version = version;
  if (json.packages?.[""]) {
    json.packages[""].version = version;
  }
});

replaceInFile("src-tauri/Cargo.toml", /^version = ".+"$/m, `version = "${version}"`);
const crate = readFileSync("src-tauri/Cargo.toml", "utf8").match(/^name = "(.+)"$/m)[1];
replaceInFile("src-tauri/Cargo.lock", new RegExp(`(name = "${crate}"\\nversion = )".+"`), `$1"${version}"`);
replaceInFile("src-tauri/tauri.conf.json", /"version": ".+"/, `"version": "${version}"`);

function updateJson(path, apply) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  apply(json);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

function replaceInFile(path, pattern, replacement) {
  const current = readFileSync(path, "utf8");
  if (!pattern.test(current)) {
    console.error(`Could not update ${path}`);
    process.exit(1);
  }
  const next = current.replace(pattern, replacement);
  writeFileSync(path, next);
}
