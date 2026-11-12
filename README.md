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

## What a send-back says

When the agent tries to finish and a check fails, the extension sends it back with one
message. It begins with a line naming the send-back, then each failing check's message,
which ends with what to do about it in the agent's terms:

```
This is send-back 1 of 2; you may not finish until the checks pass.

check-passes: the project's check failed:
<the last lines of the check's output>
Read the failure above, fix the cause in the code or the test that is wrong, and run the check again before finishing; do not skip, delete or weaken a test to make it pass.
```

Two send-backs are allowed per node. After the second, the agent may finish, and the
failures still standing are written to `flows-failed.txt` in the artifacts folder.

Each check's failure message ends with its instruction:

- `closing-account`, no account: end the final message with the account in the stated form.
  With a line marked unmet: do the work each unmet line names, run the project's check
  again, then end with a fresh account; mark a criterion met only with evidence of it,
  never by rewording the line.
- `check-passes`: read the failure above, fix the cause in the code or the test that is
  wrong, and run the check again before finishing; do not skip, delete or weaken a test to
  make it pass. A marker that names no check command instead says the check command is
  missing, because the Workflow owns that setting rather than the agent.
- `changed-files`: make the change the task asks for and commit it; an empty commit does
  not count.
- `file-exists`: write the named file at that path before finishing.
- `no-changes`: undo the changes to files (this node only reads), and give the answer in
  the final message.

## Settings

`check-passes` runs the command in `FLOWS_CHECK` in the worktree and passes when it exits 0.
The extension sets `FLOWS_CHECK` from the marker's `check` field. Its default is the empty string: a
marker with no `check` field sets `FLOWS_CHECK` to `""`, and `check-passes` then fails, saying
the Workflow names no check command.

The extension also sets, for every check:

- `ARTIFACTS_DIR`: the marker's artifacts folder.
- `FLOWS_START_TREE`: the git tree the node started on.
- `FLOWS_FINAL_MESSAGE`: a file holding the agent's final message.
