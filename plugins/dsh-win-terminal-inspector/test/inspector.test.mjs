// Unit test: WindowsProcessInspector against a real, self-contained process
// tree.
//
// The tree root is a `node -e` process that spawns a second `node -e` child, so
// the test needs no Git Bash and runs anywhere Node runs (the previous version
// required C:\Program Files\Git\bin\bash.exe and could only pass on a machine
// that had Git for Windows installed — it failed in sandboxes without bash).
// Set DSH_TEST_TREE_EXE to force a different interpreter (e.g. bash.exe).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { WindowsProcessInspector, buildProcessTree, parseTable, PS_TABLE_SCRIPT, defaultTableExec } from "../lib/inspector.js";

const EXE = process.env.DSH_TEST_TREE_EXE || process.execPath;
// Root: stay alive 60s. Child: same, spawned detached from the root's argv.
const ROOT_SCRIPT =
  "const{spawn}=require('child_process');" +
  "spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
  "setInterval(()=>{},1000);";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

if (!existsSync(EXE)) {
  console.log(`SKIP  process-tree tests — interpreter not found: ${EXE}`);
  process.exitCode = 0;
} else {
  const inspector = new WindowsProcessInspector({ ttlMs: 300 });

  // 0. table backend sanity
  {
    const stdout = defaultTableExec();
    const entries = parseTable(stdout);
    const node = entries.find((e) => e.pid === process.pid);
    record("process table query + parse", entries.length > 50 && node !== undefined, `${entries.length} entries; node entry created=${node?.started}`);
  }

  // 1. real process tree (node root -> node child)
  const root = spawn(EXE, ["-e", ROOT_SCRIPT], { windowsHide: true, stdio: "ignore" });
  let tree = [];
  let rootIdentity = null;
  try {
    await sleep(2000);
    tree = inspector.processTree(root.pid);
    rootIdentity = tree.find((m) => m.pid === root.pid);
    record("processTree: root + descendants", rootIdentity !== undefined && tree.length >= 2, `tree=${tree.length} members, children first=${tree[0].pid !== root.pid}`);
    const childMember = tree.find((m) => m.pid !== root.pid);
    record("processTree: child member has started identity", childMember !== undefined && childMember.started.length > 0);

    // 2. isAlive semantics
    record("isAlive: live root", rootIdentity !== undefined && inspector.isAlive(rootIdentity));
    record("isAlive: wrong started (pid reuse guard)", inspector.isAlive({ pid: root.pid, started: "1970-01-01T00:00:00.000Z" }) === false);
    record("isAlive: unknown pid", inspector.isAlive({ pid: 9999999, started: rootIdentity?.started ?? "" }) === false);

    // 3. foreground / session / stdin
    record("foregroundPgid: shell pid while alive", inspector.foregroundPgid(root.pid) === root.pid);
    record("foregroundPgid: undefined for dead pid", inspector.foregroundPgid(9999999) === undefined);
    record("processSession: empty on Windows", Array.isArray(inspector.processSession(root.pid)) && inspector.processSession(root.pid).length === 0);
    record("isStdinWaiting: false (documented)", inspector.isStdinWaiting(root.pid) === false);

    // 4. buildProcessTree cycle safety + children-first order
    {
      const fake = [
        { pid: 1, parentPid: 1, started: "a" }, // self-cycle
        { pid: 2, parentPid: 1, started: "b" },
        { pid: 3, parentPid: 2, started: "c" },
      ];
      const t = buildProcessTree(fake, 1);
      record("buildProcessTree: cycle-safe children-first", t.length === 3 && t[0].pid === 3 && t[2].pid === 1);
    }

    // 5. signalProcess: kill the child, verify tree shrinks
    const child = tree.find((m) => m.pid !== root.pid);
    if (child !== undefined) {
      inspector.signalProcess(child, "SIGTERM");
      await sleep(1500);
      const after = inspector.processTree(root.pid);
      record("signalProcess: child removed from tree", after.find((m) => m.pid === child.pid) === undefined, `tree now ${after.length}`);
    }

    // 6. signalGroup SIGTERM kills the whole tree
    inspector.signalGroup(root.pid, "SIGKILL");
    await sleep(1500);
    const gone = inspector.processTree(root.pid);
    record("signalGroup: tree terminated", gone.length === 0);
    record("foregroundPgid: undefined after group kill", inspector.foregroundPgid(root.pid) === undefined);
  } finally {
    try {
      spawnSync("taskkill", ["/PID", String(root.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {}
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}
