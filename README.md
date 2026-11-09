# pi-flows

Flows for pi: short checks named in a prompt run when the agent tries to finish, and a failing check sends it back.

Moved out of the Factory (github.com/bradley-mankoff/factory) at its commit 9aaed8d on 2026-11-08, because pi extensions and herdr plugins are tools of the Human's own setup rather than parts of the Factory (Factory Bead fac-qpv.8). The Factory installs it as a dependency.

Install: `pi install git:github.com/bradley-mankoff/pi-flows`

## The marker line

A prompt that wants checks carries one line. The marker is this package's own convention;
the package reads nothing else from the prompt.

```
FLOWS {"node":"work","bead":"pi-flows-lav","flows":"/runs/1/flows","artifacts":"/runs/1/artifacts","check":"npm test"}
```

A node's checks live only in its flows file. Nothing else replaces them: a Bead whose
definition of done differs gets a forked Workflow with that node's flows file.

- `node`: the node's name; it prefixes each line of the failure report in `flows-failed.txt`.
- `bead`: the Bead the node works on; required, but no check reads it.
- `flows`: folder holding one file per node, named after the node, one check per line.
- `artifacts`: folder for the Run's notes; a check still failing at the end is written to `flows-failed.txt` there.
- `check`: optional; the command `check-passes` runs.

## Settings

`check-passes` runs the command in `FLOWS_CHECK` in the worktree and passes when it exits 0.
The extension sets `FLOWS_CHECK` from the marker's `check` field. Its default is the empty string: a
marker with no `check` field sets `FLOWS_CHECK` to `""`, and `check-passes` then fails with
`check-passes: FLOWS_CHECK is not set.`

The extension also sets, for every check:

- `ARTIFACTS_DIR`: the marker's artifacts folder.
- `FLOWS_START_TREE`: the git tree the node started on.
- `FLOWS_FINAL_MESSAGE`: a file holding the agent's final message.
