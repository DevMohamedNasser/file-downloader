import { spawnSync } from "node:child_process";
import path from "node:path";

const venvPython = path.join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const create = spawnSync("python3", ["-m", "venv", ".venv"], { stdio: "inherit" });
if (create.status !== 0) process.exit(create.status ?? 1);
const install = spawnSync(venvPython, ["-m", "pip", "install", "--upgrade", "yt-dlp", "certifi"], { stdio: "inherit" });
process.exit(install.status ?? 1);
