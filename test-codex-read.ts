import { CodexRuntime } from "./src/runtimes/codex.js";

const rt = new CodexRuntime({ model: "o3" });
const start = Date.now();
const sess = await rt.createSession({ cwd: process.cwd(), model: "o3", context: "", name: "test" });
const reply = await sess.send("Read package.json and tell me the project name and version. Be concise.");
console.log(`(${((Date.now() - start) / 1000).toFixed(1)}s):`);
console.log(reply);
sess.close();
