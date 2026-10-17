# sandbox-probe

Benign probe used by alibi-qa. It only observes its environment (user,
capabilities, mounts, network reachability, environment variable NAMES) and
prints a JSON report. It writes nothing outside its own workspace and /tmp and
never runs destructive or exploit code. It always fails on purpose so that
Alibi reproduces it in the sandbox.

Run by the security suite only.
