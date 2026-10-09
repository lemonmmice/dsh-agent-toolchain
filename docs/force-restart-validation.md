# Force-restart timeout evidence

Full-suite diagnostics identified two independent issues:

1. Product code terminated taskkill after a fixed five seconds. Under load both attempts
   timed out; an empty stderr buffer hid the timeout. Synchronous tasklist calls took as
   long as 10.2 seconds. The driver now awaits taskkill asynchronously within the configured
   exit budget, checks PID liveness natively and refreshes the final result.
2. The live regression explicitly configures an eight-second kill budget, then requires a
   successful restart. Four concurrent process-heavy tests can exhaust even that budget:
   a later full run returned `retries: 0`, a kill error and the still-running target, correctly.
   Increasing the test timeout would only move the machine-load assumption.

The runner therefore executes `launch-force.test.mjs` after all parallel workers finish.
It still runs every assertion, with its original eight-second budget and unique victim
process names. A standalone instrumented run completed in 77.4 seconds; concurrent runs
took 166–226 seconds. Test scheduling is isolated; product refusal semantics remain bounded.
