/**
 * Each check is a short script in checks/ with one job (GLOSSARY.md, `Flow`;
 * fac-qpv.3.1). These tests run a check on its own against a temporary git repo, so a
 * check's name, pass and failure message are settled without the extension around it.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checks = join(dirname(fileURLToPath(import.meta.url)), "..", "checks");

type Result = { status: number | null; stdout: string; stderr: string };

const runCheck = (name: string, args: string[], cwd: string, env: Record<string, string> = {}): Result => {
	const result = spawnSync(join(checks, name), args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** A git repo with one commit, and the tree it starts on. */
const makeRepo = (): { dir: string; startTree: string } => {
	const dir = mkdtempSync(join(tmpdir(), "pi-flows-check-"));
	execFileSync("git", ["init", "-q", dir]);
	writeFileSync(join(dir, "README.md"), "the starting tree\n");
	execFileSync("git", ["-C", dir, "add", "README.md"]);
	execFileSync("git", ["-C", dir, "commit", "-qm", "start"]);
	return { dir, startTree: execFileSync("git", ["-C", dir, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim() };
};

test("changed-files fails when nothing changed, including an empty commit, and passes when a file changed", () => {
	const repo = makeRepo();
	try {
		const unchanged = runCheck("changed-files", [], repo.dir, { FLOWS_START_TREE: repo.startTree });
		assert.equal(unchanged.status, 1);
		assert.equal(unchanged.stdout, "changed-files: the work changed no files; an empty commit does not count.\n");

		execFileSync("git", ["-C", repo.dir, "commit", "--allow-empty", "-qm", "an empty commit"]);
		const empty = runCheck("changed-files", [], repo.dir, { FLOWS_START_TREE: repo.startTree });
		assert.equal(empty.status, 1);

		writeFileSync(join(repo.dir, "work.txt"), "the work\n");
		assert.equal(runCheck("changed-files", [], repo.dir, { FLOWS_START_TREE: repo.startTree }).status, 0);
	} finally {
		rmSync(repo.dir, { recursive: true, force: true });
	}
});

test("no-changes passes when nothing changed and fails when a file changed", () => {
	const repo = makeRepo();
	try {
		assert.equal(runCheck("no-changes", [], repo.dir, { FLOWS_START_TREE: repo.startTree }).status, 0);
		writeFileSync(join(repo.dir, "found.md"), "findings\n");
		const changed = runCheck("no-changes", [], repo.dir, { FLOWS_START_TREE: repo.startTree });
		assert.equal(changed.status, 1);
		assert.equal(changed.stdout, "no-changes: the work changed files, and this node must not change any.\n");
	} finally {
		rmSync(repo.dir, { recursive: true, force: true });
	}
});

test("file-exists passes when the named file is there and fails naming the path when it is not", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-flows-check-"));
	try {
		const missing = runCheck("file-exists", ["findings.md"], dir);
		assert.equal(missing.status, 1);
		assert.equal(missing.stdout, "file-exists: findings.md does not exist.\n");

		writeFileSync(join(dir, "findings.md"), "the answer\n");
		assert.equal(runCheck("file-exists", ["findings.md"], dir).status, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("check-passes runs the command in FLOWS_CHECK, fails when it is not set, and prints a failing check's output", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-flows-check-"));
	try {
		const unset = runCheck("check-passes", [], dir, { FLOWS_CHECK: "" });
		assert.equal(unset.status, 1);
		assert.equal(unset.stdout, "check-passes: FLOWS_CHECK is not set.\n");

		assert.equal(runCheck("check-passes", [], dir, { FLOWS_CHECK: "printf 'the check passed\\n'" }).status, 0);

		const failed = runCheck("check-passes", [], dir, { FLOWS_CHECK: "printf 'first line\\nthe failing line\\n'; exit 3" });
		assert.equal(failed.status, 1);
		assert.equal(failed.stdout, "check-passes: the project's check failed:\nfirst line\nthe failing line\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Writes a made-up final message where the Flows extension leaves one for a check, and gives its path. */
const writeFinalMessage = (dir: string, text: string): string => {
	const path = join(dir, "final-message");
	writeFileSync(path, text);
	return path;
};

test("closing-account fails when the final message has no account of the acceptance criteria", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-flows-check-"));
	try {
		const finalMessage = writeFinalMessage(
			dir,
			"I added the helper and its test. Some work remains: the commit is not made.\n",
		);
		const result = runCheck("closing-account", [], dir, { FLOWS_FINAL_MESSAGE: finalMessage });
		assert.equal(result.status, 1);
		assert.match(result.stdout, /^closing-account: /);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("closing-account fails when a line of the account is marked unmet, and names that line to send back", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-flows-check-"));
	try {
		const finalMessage = writeFinalMessage(
			dir,
			[
				"Acceptance criteria:",
				"- met: prompts/work.md asks for the account — written in prompts/work.md.",
				"- unmet: the extension sends the agent back — the check has not run in a session yet.",
			].join("\n"),
		);
		const result = runCheck("closing-account", [], dir, { FLOWS_FINAL_MESSAGE: finalMessage });
		assert.equal(result.status, 1);
		assert.equal(
			result.stdout,
			"closing-account: the closing account marks a criterion unmet:\n- unmet: the extension sends the agent back — the check has not run in a session yet.\n",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("closing-account passes when every line of the account is marked met", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-flows-check-"));
	try {
		const finalMessage = writeFinalMessage(
			dir,
			[
				"The check now reads the agent's final message.",
				"",
				"Acceptance criteria:",
				"- met: prompts/work.md asks for the account — prompts/work.md says so.",
				"- met: the check fails on a missing account or an unmet line — tests/flows-checks.test.ts covers both.",
				"- met: a session is sent back with the unmet line — tests/flows.test.ts covers it.",
			].join("\n"),
		);
		const result = runCheck("closing-account", [], dir, { FLOWS_FINAL_MESSAGE: finalMessage });
		assert.equal(result.status, 0, result.stdout);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("file-exists finds a relative path in the Run's artifacts folder, where research and demo nodes write", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-flows-check-"));
	const artifacts = join(dir, "artifacts");
	try {
		execFileSync("mkdir", ["-p", artifacts]);
		writeFileSync(join(artifacts, "findings.md"), "the answer\n");
		assert.equal(runCheck("file-exists", ["findings.md"], dir, { ARTIFACTS_DIR: artifacts }).status, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
