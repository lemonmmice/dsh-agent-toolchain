// Unit test: WindowsProcessInspector against a real Git Bash process tree.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { WindowsProcessInspector, buildProcessTree, parseTable, PS_TABLE_SCRIPT, defaultTableExec } from "../lib/inspector.js";

const BASH = process.env.DSH_BASH_PATH || "C:\\Program Files\\Git\\bin\\bash.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const inspector = new WindowsProcessInspector({ ttlMs: 300 });

// 0. table backend sanity
{
  const stdout = defaultTableExec();
  const entries = parseTable(stdout);
  const node = entries.find((e) => e.pid === process.pid);
  record("process table query + parse", entries.length > 50 && node !== undefined, `${entries.length} entries; node entry created=${node?.started}`);
}

// 1. real Git Bash tree
const bash = spawn(BASH, ["-c", "sleep 60"], { windowsHide: true, stdio: "ignore" });
let tree = [];
let rootIdentity = null;
try {
  await sleep(1500);
  tree = inspector.processTree(bash.pid);
  rootIdentity = tree.find((m) => m.pid === bash.pid);
  record("processTree: root + descendants", rootIdentity !== undefined && tree.length >= 2, `tree=${tree.length} members, children first=${tree[0].pid !== bash.pid}`);
  const sleepMember = tree.find((m) => m.pid !== bash.pid);
  record("processTree: sleep member has started identity", sleepMember !== undefined && sleepMember.started.length > 0);

  // 2. isAlive semantics
  record("isAlive: live root", rootIdentity !== undefined && inspector.isAlive(rootIdentity));
  record("isAlive: wrong started (pid reuse guard)", inspector.isAlive({ pid: bash.pid, started: "1970-01-01T00:00:00.000Z" }) === false);
  record("isAlive: unknown pid", inspector.isAlive({ pid: 9999999, started: rootIdentity?.started ?? "" }) === false);

  // 3. foreground / session / stdin
  record("foregroundPgid: shell pid while alive", inspector.foregroundPgid(bash.pid) === bash.pid);
  record("foregroundPgid: undefined for dead pid", inspector.foregroundPgid(9999999) === undefined);
  record("processSession: empty on Windows", Array.isArray(inspector.processSession(bash.pid)) && inspector.processSession(bash.pid).length === 0);
  record("isStdinWaiting: false (documented)", inspector.isStdinWaiting(bash.pid) === false);

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

  // 5. signalProcess: kill the sleep child, verify tree shrinks
  const child = tree.find((m) => m.pid !== bash.pid);
  if (child !== undefined) {
    inspector.signalProcess(child, "SIGTERM");
    await sleep(1200);
    const after = inspector.processTree(bash.pid);
    record("signalProcess: child removed from tree", after.find((m) => m.pid === child.pid) === undefined, `tree now ${after.length}`);
  }

  // 6. signalGroup SIGTERM kills the whole tree
  inspector.signalGroup(bash.pid, "SIGKILL");
  await sleep(1200);
  const gone = inspector.processTree(bash.pid);
  record("signalGroup: tree terminated", gone.length === 0);
  record("foregroundPgid: undefined after group kill", inspector.foregroundPgid(bash.pid) === undefined);
} finally {
  try {
    spawnSync("taskkill", ["/PID", String(bash.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length > 0 ? 1 : 0;
