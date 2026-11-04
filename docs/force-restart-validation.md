# Force-restart timeout evidence

Diagnostics identified two independent issues:

1. Product code terminated taskkill after a fixed five seconds. Under load both attempts
   timed out; an empty stderr buffer hid the timeout. Synchronous tasklist calls took as
   long as 10.2 seconds. The driver now awaits taskkill asynchronously within the configured
   exit budget, checks PID liveness natively and refreshes the final result.
2. The live restart check explicitly configures an eight-second kill budget, then requires a
   successful restart. Four concurrent process-heavy runs can exhaust even that budget:
   a later full run returned `retries: 0`, a kill error and the still-running target, correctly.
   Increasing the timeout would only move the machine-load assumption.

For that reason the live case runs after all parallel workers finish, with its original eight-second budget and unique victim process names. Product refusal semantics remain bounded.
