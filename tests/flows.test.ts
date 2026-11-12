/**
 * Flows are the rules that say when the agent in one AI node may finish (GLOSSARY.md,
 * fac-qpv.3). These tests drive the seams the Flows Spec names: a pi session in print
 * mode with the Flows extension loaded, a temporary git repo and a flows/ folder beside
 * a made-up Workflow, a scripted provider at the edge, and each check script run on its
 * own.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { textOf } from "../extensions/flows.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const flowsExtension = join(root, "extensions", "flows.ts");
const testProvider = join(root, "tests", "fixtures", "flows-test-provider.ts");

type Step = { text: string } | { tool: string; arguments: Record<string, unknown> };
type Request = { step: number; messages: string[] };
type SessionLine = { type: string; customType?: string; content?: string | { type: string; text?: string }[] };

type Workspace = {
	dir: string;
	home: string;
	agentDir: string;
	repo: string;
	flows: string;
	artifacts: string;
	bin: string;
};

/** One temporary Mac, git repo, flows folder and Run artifacts folder. */
const makeWorkspace = (checks: Record<string, string[]>): Workspace => {
	const dir = mkdtempSync(join(tmpdir(), "pi-flows-"));
	const home = join(dir, "home");
	const agentDir = join(dir, "pi-agent");
	const repo = join(dir, "repo");
	const flows = join(dir, "flows");
	const artifacts = join(dir, "artifacts");
	const bin = join(dir, "bin");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(bin, { recursive: true });
	mkdirSync(artifacts, { recursive: true });
	mkdirSync(flows, { recursive: true });
	for (const [node, lines] of Object.entries(checks)) writeFileSync(join(flows, node), `${lines.join("\n")}\n`);
	execFileSync("git", ["init", "-q", repo]);
	writeFileSync(join(repo, "README.md"), "the starting tree\n");
	execFileSync("git", ["-C", repo, "add", "README.md"]);
	execFileSync("git", ["-C", repo, "commit", "-qm", "start"]);
	return { dir, home, agentDir, repo, flows, artifacts, bin };
};

/**
 * A stand-in for the Beads CLI: `bd show` prints the Bead the test made up, whatever id it
 * is asked for. A node's checks come only from its flows file, so the design field here
 * must not change them.
 */
const writeBead = (workspace: Workspace, design: string): void => {
	writeFileSync(join(workspace.bin, "bead.json"), JSON.stringify([{ id: "pi-flows-1", design }]));
	writeFileSync(join(workspace.bin, "bd"), '#!/bin/sh\ncat "$(dirname "$0")/bead.json"\n', { mode: 0o755 });
};

const clearWorkspace = (workspace: Workspace): void => rmSync(workspace.dir, { recursive: true, force: true });

/** What a test may change about the marker's optional fields: the check, and the artifacts folder. */
type MarkerFields = { check?: string; artifacts?: string };

/** The marker line README.md documents: the node, Bead, paths and optional check. */
const markerFor = (workspace: Workspace, node: string, fields: MarkerFields = {}): string =>
	`FLOWS ${JSON.stringify({
		node,
		bead: "pi-flows-1",
		flows: workspace.flows,
		artifacts: fields.artifacts ?? workspace.artifacts,
		...(fields.check === undefined ? {} : { check: fields.check }),
	})}`;

const sessionFiles = (dir: string): string[] =>
	existsSync(dir)
		? readdirSync(dir, { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
				.map((entry) => join(entry.parentPath, entry.name))
		: [];

const readJsonLines = <T>(path: string): T[] =>
	existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as T)
		: [];

type Run = {
	status: number | null;
	stdout: string;
	stderr: string;
	requests: Request[];
	session: SessionLine[];
};

/** The messages the extension sent back into the session, in order. */
const sentBacksOf = (run: Run): SessionLine[] => run.session.filter((entry) => entry.type === "custom_message");

const runPi = (workspace: Workspace, prompt: string, steps: Step[]): Run => {
	const requestLog = join(workspace.dir, "requests.jsonl");
	const script = join(workspace.dir, "script.json");
	const sessionsBefore = new Set(sessionFiles(join(workspace.agentDir, "sessions")));
	writeFileSync(script, JSON.stringify(steps));
	writeFileSync(requestLog, "");
	const result = spawnSync(
		"pi",
		["-ns", "-ne", "-e", testProvider, "-e", flowsExtension, "-p", "--model", "test/agent", prompt],
		{
			cwd: workspace.repo,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PATH: `${workspace.bin}:${process.env.PATH ?? ""}`,
				HOME: workspace.home,
				PI_CODING_AGENT_DIR: workspace.agentDir,
				PI_SKIP_VERSION_CHECK: "1",
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				FLOWS_TEST_LOG: requestLog,
				FLOWS_TEST_SCRIPT: script,
			},
		},
	);
	const created = sessionFiles(join(workspace.agentDir, "sessions")).filter((path) => !sessionsBefore.has(path));
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		requests: readJsonLines<Request>(requestLog),
		session: created[0] ? readJsonLines<SessionLine>(created[0]) : [],
	};
};

/** The worktree's tree as a check reads it: the script the extension takes a node's start tree with. */
const treeOf = (cwd: string): string =>
	execFileSync(join(root, "checks", "worktree-tree"), [], { cwd, encoding: "utf8" }).trim();

/** changed-files' failure message, from the Bead; a send-back carries it whole. */
const changedFilesFailure =
	"changed-files: the work changed no files from the tree the node started on. Make the change the task asks for and commit it; an empty commit does not count.";

/** Commit a file in the temporary repo, as the work agent's commit does. */
const commitFile = (repo: string, name: string, text: string, message: string): void => {
	writeFileSync(join(repo, name), text);
	execFileSync("git", ["-C", repo, "add", name]);
	execFileSync("git", ["-C", repo, "commit", "-qm", message]);
};

test("a failing check sends the agent back with the check's message, and a later turn that changes a file lets it finish", () => {
	const workspace = makeWorkspace({ work: ["changed-files"] });
	try {
		const run = runPi(workspace, `${markerFor(workspace, "work")}\nDo the work.`, [
			{ text: "done" },
			{ tool: "bash", arguments: { command: "printf 'work\\n' > work.txt" } },
		]);
		assert.equal(run.status, 0, run.stderr || run.stdout);
		assert.equal(run.requests.length, 3);
		const sentBack = sentBacksOf(run);
		assert.equal(sentBack.length, 1);
		assert.match(textOf(sentBack[0]), /changed-files: the work changed no files from the tree the node started on\./);
		assert.match(run.requests[1].messages.join("\n"), /changed-files: the work changed no files/);
	} finally {
		clearWorkspace(workspace);
	}
});

test("after two send-backs the agent may finish, and the failed checks are written to the Run's artifacts folder", () => {
	const workspace = makeWorkspace({ work: ["changed-files"] });
	try {
		const run = runPi(workspace, `${markerFor(workspace, "work")}\nDo the work.`, [{ text: "done" }]);
		assert.equal(run.status, 0, run.stderr || run.stdout);
		assert.equal(run.requests.length, 3);
		const sentBack = sentBacksOf(run);
		assert.equal(sentBack.length, 2);
		assert.equal(
			readFileSync(join(workspace.artifacts, "flows-failed.txt"), "utf8"),
			`work: ${changedFilesFailure}\n`,
		);
	} finally {
		clearWorkspace(workspace);
	}
});

test("each send-back starts by naming which send-back it is of two, before the failures", () => {
	const workspace = makeWorkspace({ work: ["changed-files"] });
	try {
		const run = runPi(workspace, `${markerFor(workspace, "work")}\nDo the work.`, [{ text: "done" }]);
		assert.equal(run.status, 0, run.stderr || run.stdout);
		const sentBack = sentBacksOf(run).map(textOf);
		assert.equal(sentBack.length, 2);
		assert.equal(sentBack[0], `This is send-back 1 of 2; you may not finish until the checks pass.\n\n${changedFilesFailure}`);
		assert.equal(sentBack[1], `This is send-back 2 of 2; you may not finish until the checks pass.\n\n${changedFilesFailure}`);
	} finally {
		clearWorkspace(workspace);
	}
});

test("a marker with no workflow field still runs the node's checks", () => {
	const workspace = makeWorkspace({ work: ["changed-files"] });
	try {
		const marker = `FLOWS ${JSON.stringify({
			node: "work",
			bead: "pi-flows-1",
			flows: workspace.flows,
			artifacts: workspace.artifacts,
		})}`;
		const run = runPi(workspace, `${marker}\nDo the work.`, [{ text: "done" }]);
		assert.equal(run.status, 0, run.stderr || run.stdout);
		assert.equal(sentBacksOf(run).length, 2);
	} finally {
		clearWorkspace(workspace);
	}
});

test("a session whose prompt carries no node marker is left alone", () => {
	const workspace = makeWorkspace({ work: ["changed-files"] });
	try {
		const run = runPi(workspace, "Do the work without a Flows marker.", [{ text: "done" }]);
		assert.equal(run.status, 0, run.stderr || run.stdout);
		assert.equal(run.requests.length, 1);
		assert.deepEqual(sentBacksOf(run), []);
		assert.equal(existsSync(join(workspace.artifacts, "flows-failed.txt")), false);
	} finally {
		clearWorkspace(workspace);
	}
});

test("a flows file naming used-tool sends the agent back saying the package has no such check", () => {
	const workspace = makeWorkspace({ work: ["used-tool bash"] });
	try {
		const run = runPi(workspace, `${markerFor(workspace, "work")}\nDo the work.`, [{ text: "done" }]);
		assert.equal(run.status, 0, run.stderr || run.stdout);
		assert.equal(run.requests.length, 3);
		const sentBack = sentBacksOf(run);
		assert.equal(sentBack.length, 2);
		assert.match(textOf(sentBack[0]), /flows: the check "used-tool" is not in the checks folder\./);
	} finally {
		clearWorkspace(workspace);
	}
});

test("a final message whose account marks a criterion unmet is sent back with that line", () => {
	const workspace = makeWorkspace({ work: ["closing-account"] });
	try {
		const unmet = "- unmet: the commit is made — nothing is committed yet.";
		const run = runPi(workspace, `${markerFor(workspace, "work")}\nDo the work.`, [
			{ text: `Acceptance criteria:\n- met: the tests pass — scripts/check passed.\n${unmet}` },
			{ text: "Acceptance criteria:\n- met: the tests pass — scripts/check passed.\n- met: the commit is made — 1234abc." },
		]);
		assert.equal(run.status, 0, run.stderr || run.stdout);
		assert.equal(run.requests.length, 2);
		const sentBack = sentBacksOf(run);
		assert.equal(sentBack.length, 1);
		assert.match(textOf(sentBack[0]), /closing-account: the closing account marks a criterion unmet:/);
		assert.ok(textOf(sentBack[0]).includes(unmet), textOf(sentBack[0]));
		assert.ok(run.requests[1].messages.join("\n").includes(unmet), run.requests[1].messages.join("\n"));
	} finally {
		clearWorkspace(workspace);
	}
});

test("a file changed in the agent's first turn counts, because the start tree is taken when the node starts", () => {
	const workspace = makeWorkspace({ work: ["changed-files"] });
	try {
		const run = runPi(workspace, `${markerFor(workspace, "work")}\nDo the work.`, [
			{ tool: "bash", arguments: { command: "printf 'work\\n' > work.txt" } },
		]);
		assert.equal(run.status, 0, run.stderr || run.stdout);
		assert.equal(run.requests.length, 2);
		assert.deepEqual(sentBacksOf(run), []);
	} finally {
		clearWorkspace(workspace);
	}
});

test("a node's start tree is kept in its Run's artifacts folder, so an attempt after the work's commit still passes changed-files", () => {
	const workspace = makeWorkspace({ work: ["changed-files"] });
	try {
		const startTreeFile = join(workspace.artifacts, "flows-start-tree");
		const baseTree = treeOf(workspace.repo);
		const firstAttempt = runPi(workspace, `${markerFor(workspace, "work")}\nDo the work.`, [{ text: "done" }]);
		assert.equal(firstAttempt.status, 0, firstAttempt.stderr || firstAttempt.stdout);
		assert.equal(readFileSync(startTreeFile, "utf8").trim(), baseTree);

		commitFile(workspace.repo, "work.txt", "the work\n", "the work");

		const retry = runPi(workspace, `${markerFor(workspace, "work")}\nDo the work, again.`, [{ text: "done" }]);
		assert.equal(retry.status, 0, retry.stderr || retry.stdout);
		assert.equal(retry.requests.length, 1);
		assert.deepEqual(sentBacksOf(retry), []);
		assert.equal(readFileSync(startTreeFile, "utf8").trim(), baseTree);

		const otherArtifacts = join(workspace.dir, "other-artifacts");
		const control = runPi(workspace, `${markerFor(workspace, "work", { artifacts: otherArtifacts })}\nDo the work, again.`, [
			{ text: "done" },
		]);
		assert.equal(control.status, 0, control.stderr || control.stdout);
		assert.equal(control.requests.length, 3);
		const sentBack = sentBacksOf(control);
		assert.equal(sentBack.length, 2);
		assert.match(textOf(sentBack[0]), /changed-files: the work changed no files from the tree the node started on\./);
	} finally {
		clearWorkspace(workspace);
	}
});

test("the marker's check field is the command check-passes runs", () => {
	const workspace = makeWorkspace({ work: ["check-passes", "changed-files"] });
	try {
		const run = runPi(workspace, `${markerFor(workspace, "work", { check: "printf 'work\\n' > work.txt" })}\nDo the work.`, [
			{ text: "done" },
		]);
		assert.equal(run.status, 0, run.stderr || run.stdout);
		assert.equal(run.requests.length, 1);
		assert.deepEqual(sentBacksOf(run), []);
		assert.equal(readFileSync(join(workspace.repo, "work.txt"), "utf8"), "work\n");
	} finally {
		clearWorkspace(workspace);
	}
});

test("a Bead's design field does not change a node's checks: they come only from its flows file", () => {
	const workspace = makeWorkspace({ work: ["changed-files"] });
	try {
		writeBead(workspace, "### Checks for work\nno-changes\n");
		const run = runPi(workspace, `${markerFor(workspace, "work")}\nDo the work.`, [{ text: "done" }]);
		assert.equal(run.status, 0, run.stderr || run.stdout);
		assert.equal(run.requests.length, 3);
		const sentBack = sentBacksOf(run);
		assert.equal(sentBack.length, 2);
		assert.match(textOf(sentBack[0]), /changed-files: the work changed no files from the tree the node started on\./);
	} finally {
		clearWorkspace(workspace);
	}
});
