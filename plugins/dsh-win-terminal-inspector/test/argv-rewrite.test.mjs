
import { apply } from "../index.js";
import { existsSync } from "node:fs";
const calls = [];
const fakeRuntime = {
  spawnTerminal: async (spec) => { calls.push(spec); return { terminal: undefined }; }
};
const dispose = apply({ subprocess: fakeRuntime });
await fakeRuntime.spawnTerminal({ argv: ["/bin/bash", "--noprofile", "--norc", "-i"], rows: 40, cols: 160 });
await fakeRuntime.spawnTerminal({ argv: ["C:\\Program Files\\Git\\bin\\bash.exe", "-i"], rows: 40, cols: 160 });
dispose();
console.log("call1 argv[0]:", calls[0].argv[0], "exists:", existsSync(calls[0].argv[0]));
console.log("call2 argv[0]:", calls[1].argv[0], "(should stay unchanged)");
console.log("restored:", fakeRuntime.spawnTerminal !== undefined);
