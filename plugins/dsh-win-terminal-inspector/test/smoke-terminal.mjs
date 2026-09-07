// Smoke test: the exact DSH persistent-bash path on Windows, end to end.
//
//   LocalSubprocessRuntime.spawnTerminal (installed dsh-subprocess-local)
//     + the dsh-win-terminal-inspector plugin wiring (real apply())
//     + LocalTerminalHandle + node-pty ConPTY + Git Bash
//     + dsh-terminal-bash's LocalPtySession (readiness / prompt contract)
//
// Proves: no "terminal inspection is unsupported on platform win32",
// interactive Git Bash roundtrips, foreground/inspectForeground semantics,
// SIGINT interrupt through the ConPTY input, clean tree teardown.
import { apply } from "../index.js";
import { WindowsProcessInspector } from "../lib/inspector.js";

// Resolve the DSH runtime classes from ONE of three places, in order:
//  1. DSH_NM env: a file:// base URL pointing at an installed DSH node_modules
//     (local development against a real `dsh web` install).
//  2. A local node_modules (CI: `npm install` pulls the published
//     @deepseek-ai/dsh-* packages next to this repo).
// Consumers may import either the older `LocalSubprocessRuntime` or the
// published `LocalSubprocessService` class name; both expose the same
// `spawnTerminal`/`terminalInspector` surface, so pick whichever exists.
async function resolveRuntime() {
  const fromUrl = async (base) => {
    const mod = await import(`${base}@deepseek-ai/dsh-subprocess-local/lib/index.js`);
    return mod.LocalSubprocessRuntime ?? mod.LocalSubprocessService ?? null;
  };
  if (process.env.DSH_NM) {
    const ctor = await fromUrl(process.env.DSH_NM);
    if (ctor) return { ctor, backend: (await import(`${process.env.DSH_NM}@deepseek-ai/dsh-terminal-bash/lib/index.js`)).BashTerminalBackend };
  }
  try {
    const mod = await import("@deepseek-ai/dsh-subprocess-local");
    const ctor = mod.LocalSubprocessRuntime ?? mod.LocalSubprocessService ?? null;
    if (ctor) {
      const backendMod = await import("@deepseek-ai/dsh-terminal-bash");
      return { ctor, backend: backendMod.BashTerminalBackend };
    }
  } catch {}
  // last resort: global DSH install, default user profile
  const base = process.env.DSH_NM ?? "file:///C:/Users/<you>/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/";
  return { ctor: await fromUrl(base), backend: (await import(`${base}@deepseek-ai/dsh-terminal-bash/lib/index.js`)).BashTerminalBackend };
}

const { ctor: SubprocessCtor, backend: BashTerminalBackend } = await resolveRuntime();
if (SubprocessCtor === null) {
  console.error("FAIL  could not resolve LocalSubprocessRuntime/LocalSubprocessService");
  process.exit(1);
}

const BASH = process.env.DSH_BASH ?? "C:\\Program Files\\Git\\bin\\bash.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- fake cordis context: enough for Service(ctx, "subprocess") + ctx.effect
let runtime;
let disposeRuntime = async () => {};
{
  const ctx = {
    reflect: { provide: () => {} },
    effect(fn) {
      let disposer;
      try {
        disposer = fn();
      } catch (error) {
        record("runtime construction", false, String(error));
        throw error;
      }
      disposeRuntime = async () => {
        try {
          if (disposer !== undefined) await disposer();
        } catch {}
      };
      return disposeRuntime;
    },
  };
  runtime = new SubprocessCtor(ctx);
  record(`${SubprocessCtor.name} constructed on win32`, true);
}

// --- plugin wiring (the real apply() from index.js)
const disposePlugin = apply({ subprocess: runtime }) ?? (() => {});
record("plugin wrapped spawnTerminal", runtime.spawnTerminal !== SubprocessCtor.prototype.spawnTerminal);

// --- terminal spec mirroring dsh-terminal-bash (danger-full-access argv)
const shellEnv = {
  TERM: "dumb",
  PAGER: "cat",
  GIT_PAGER: "cat",
  PS1: "dsh> ",
  PROMPT_COMMAND: 'printf "\\033]133;D;%s\\007" "$?"',
  BASH_SILENCE_DEPRECATION_WARNING: "1",
  DSH_SHELL: "1",
};
const spec = {
  argv: [BASH, "--noprofile", "--norc", "-i"],
  cwd: process.cwd(),
  env: shellEnv,
  rows: 40,
  cols: 160,
  graceMs: 3000,
};

async function waitForOutput(handle, predicate, timeoutMs, label) {
  let text = "";
  const t0 = Date.now();
  const onData = (c) => (text += c.toString("utf8"));
  handle.output.on("data", onData);
  try {
    while (Date.now() - t0 < timeoutMs) {
      if (predicate(text)) return text;
      await sleep(60);
    }
    console.log(`  (timeout waiting for ${label})`);
    return null;
  } finally {
    handle.output.off("data", onData);
  }
}

// --- Phase 1: raw terminal through spawnTerminal
let phase1Handle;
try {
  const handle = await runtime.spawnTerminal(spec);
  phase1Handle = handle;
  const shellPid = handle.pid;
  record("spawnTerminal succeeded (no unsupported-platform error)", true, `shell pid=${shellPid}`);

  const prompt = await waitForOutput(handle, (t) => t.includes("dsh> "), 20000, "first prompt");
  record("interactive Git Bash reached prompt", prompt !== null);

  await handle.write(`echo SMOKE_HELLO_${shellPid}\n`);
  const out1 = await waitForOutput(handle, (t) => t.includes("SMOKE_HELLO"), 10000, "hello roundtrip");
  record("command roundtrip", out1 !== null && out1.includes(`SMOKE_HELLO_${shellPid}`));

  // foreground + inspectForeground while a command runs
  await handle.write("sleep 60\n");
  await waitForOutput(handle, (t) => t.includes("sleep 60"), 8000, "sleep started");
  await sleep(800);
  const foreground = await handle.inspectForeground();
  record(
    "inspectForeground during command",
    foreground !== undefined && foreground.processGroupId === shellPid && foreground.inputWaiting === false,
    JSON.stringify(foreground)
  );

  // interrupt: SIGINT through the ConPTY input (ETX)
  const pgid = await handle.signalForeground("SIGINT");
  record("signalForeground(SIGINT) delivered", pgid === shellPid, `pgid=${pgid}`);
  const promptBack = await waitForOutput(handle, (t) => t.includes("dsh> "), 8000, "prompt after interrupt");
  record("prompt returned after interrupt", promptBack !== null);

  // shell still usable
  await handle.write("echo AFTER_INTERRUPT_OK\n");
  const out2 = await waitForOutput(handle, (t) => t.includes("AFTER_INTERRUPT_OK"), 10000, "post-interrupt roundtrip");
  record("shell usable after interrupt", out2 !== null);

  record(
    "inspector captured root identity",
    handle.rootIdentity !== undefined && handle.rootIdentity.started.length > 0,
    JSON.stringify(handle.rootIdentity)
  );

  await handle.terminate();
  record("terminal terminate() clean", true);

  const probeInspector = new WindowsProcessInspector({ ttlMs: 0 });
  record(
    "shell gone after terminate",
    handle.rootIdentity !== undefined && probeInspector.isAlive({ pid: shellPid, started: handle.rootIdentity.started }) === false
  );
} catch (error) {
  record("phase 1", false, `${error.message}`);
  console.error(error);
} finally {
  if (phase1Handle !== undefined) {
    try {
      await phase1Handle.terminate();
    } catch {}
  }
}

// --- Phase 2: BashTerminalBackend — the persistent-bash backend spawn path
const liveHandles = [];
try {
  const config = {
    backendType: "shell",
    shellPath: BASH,
    shellArgs: ["--noprofile", "--norc", "-i"],
    rows: 40,
    cols: 160,
    scrollbackLines: 10000,
    scrollbackMaxBytes: 4 * 1024 * 1024,
    maxReadBytes: 256 * 1024,
    pollIntervalMs: 50,
    exactProbeAfterMs: 150,
    idleSilenceMs: 3000,
    handoffGraceMs: 500,
    timeoutMs: 30000,
    disposeGraceMs: 3000,
  };
  const fakeCtx = {
    subprocess: runtime,
    sandboxPolicy: { resolve: () => ({ mode: "danger-full-access", workspaceRoot: process.cwd() }) },
    terminals: { hasOwnerActivity: () => false, registerBackend: () => {} },
    on() {
      return () => {};
    },
  };
  const owner = { id: "smoke", session: { events: [] }, ctx: { on: () => () => {} } };
  const backend = new BashTerminalBackend(fakeCtx, config);
  const session = await backend.spawn({ owner, cwd: process.cwd() });
  liveHandles.push(session);

  record("BashTerminalBackend.spawn + initialize (readiness contract)", true);

  const op1 = session.startSend({ text: "echo PERSIST_ROUNDTRIP_OK", submit: true });
  const result1 = await op1.done;
  record(
    "persistent-bash command settles at stdin_read",
    result1.waitReason === "stdin_read" && result1.viewport.includes("PERSIST_ROUNDTRIP_OK"),
    `waitReason=${result1.waitReason}`
  );

  // interrupt a long-running command through the session layer
  // (&& : after a real Ctrl-C bash does NOT run the next command; the echo
  //  of the typed command is excluded by matching the runtime-expanded form)
  const op2 = session.startSend({ text: "sleep 60 && echo NOT_REACHED_$(date +%s)", submit: true });
  await sleep(1000);
  await session.signal("SIGINT");
  const result2 = await op2.done;
  record(
    "session interrupt settles at stdin_read without running the rest",
    result2.waitReason === "stdin_read" && !/NOT_REACHED_\d+/.test(result2.viewport),
    `waitReason=${result2.waitReason}`
  );

  // state persists across calls (same session)
  const op3 = session.startSend({ text: "X=persisted_value; echo STATE_$X", submit: true });
  const result3 = await op3.done;
  record("state persists across command calls", result3.viewport.includes("STATE_persisted_value"));

  await session.close("smoke test done");
  liveHandles.length = 0;
  record("session.close clean", true);
} catch (error) {
  record("phase 2", false, `${error.message}`);
  console.error(error);
} finally {
  for (const session of liveHandles) {
    try {
      await session.close("smoke cleanup");
    } catch {}
  }
}

// --- cleanup
try {
  disposePlugin();
  record("plugin dispose restores spawnTerminal", runtime.spawnTerminal === SubprocessCtor.prototype.spawnTerminal);
} catch (error) {
  record("plugin dispose", false, String(error));
}
try {
  await disposeRuntime();
} catch {}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
// node-pty's ConPTY threads can keep the loop alive after shells exit;
// exit explicitly once all assertions are recorded.
process.exit(failed.length > 0 ? 1 : 0);
