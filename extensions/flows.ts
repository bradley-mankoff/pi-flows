/**
 * flows: runs the checks a node's flows file names when its agent tries to finish.
 *
 * A Workflow assigns checks to its nodes in a flows/ folder beside its YAML: one file per
 * node, named after the node, one check per line. A node's checks come only from that file,
 * so a Bead whose definition of done differs gets a forked Workflow. A checked node's
 * prompt carries the marker line README.md documents, naming the node, Bead, folders and
 * the optional check command:
 *
 *   FLOWS {"node":"work","bead":"pi-flows-lav","flows":"...","artifacts":"...","check":"npm test"}
 *
 * On pi 1.3.0's agent_before_settle, the last point where an extension can keep the agent
 * going, this extension reads the marker from the prompt through the handler's ctx, runs
 * the node's checks in the Run's worktree, and sends the agent back with a failing check's
 * message. Two send-backs are allowed per node; when the agent finishes with a check still
 * failing, the failures go to the Run's artifacts folder as flows-failed.txt, and the next
 * node or the Project Manager can read them.
 *
 * The marker is read from the context, never from process.env: a Run's nodes share this
 * loaded extension, so this process's environment is not one node's. Handlers use their
 * ctx and this file's own state, never pi.*, for the same reason.
 *
 * Checks live in the checks/ folder beside this package's extensions/, one short script
 * each, and exit 0 to pass or print the message to send back and exit 1 to fail. Each gets
 * the worktree as its working directory, the args its flows line names, and this pi
 * process's environment — which carries the project's .archon/.env, the file Archon loads
 * at start-up — plus these values this extension sets:
 *
 *   ARTIFACTS_DIR        the Run's artifacts folder, from the marker
 *   FLOWS_CHECK          the check command, from the marker's check field
 *   FLOWS_START_TREE     the git tree the node started on
 *   FLOWS_FINAL_MESSAGE  a file holding the agent's final message, which closing-account reads
 *
 * The current tree comes from checks/worktree-tree, the same script this extension takes
 * the node's start tree with.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentBeforeSettleEvent,
	AgentBeforeSettleEventResult,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

/** What a checked node's prompt carries: the marker line README.md documents. */
type Marker = {
	node: string;
	bead: string;
	flows: string;
	artifacts: string;
	check?: string;
};

/** One check from a node's flows file: its name and its arguments. */
type Check = { name: string; args: string[] };

/** One session's state, kept apart by session id because a Run's nodes share this module. */
type Session = { marker?: Marker; startTree?: string; checks?: Check[]; sendBacks: number };

const MAX_SEND_BACKS = 2;
const sessions = new Map<string, Session>();

/** The check scripts, in the package's checks/ folder beside extensions/. */
const checksDir = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", "checks");

/** The worktree's git tree at a node's start; undefined when the folder is not a git checkout. */
const startTree = (cwd: string): string | undefined => {
	const result = spawnSync(join(checksDir(), "worktree-tree"), [], { cwd, encoding: "utf8" });
	if (result.status !== 0) return undefined;
	const tree = result.stdout.trim();
	return tree === "" ? undefined : tree;
};

/** The text a message carries: what the marker is looked for in, and what the tests read. */
export const textOf = (message: unknown): string => {
	if (typeof message !== "object" || message === null) return "";
	const { content } = message as { content?: unknown };
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const { type, text } = part as { type?: unknown; text?: unknown };
			return type === "text" && typeof text === "string" ? [text] : [];
		})
		.join("\n");
};

/** The marker in a prompt or system prompt, when one is there. */
const markerIn = (text: string): Marker | undefined => {
	const line = text
		.split("\n")
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate.startsWith("FLOWS "));
	if (!line) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.slice("FLOWS ".length));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { node, bead, flows, artifacts, check } = parsed as Partial<Record<keyof Marker, unknown>>;
	if (
		typeof node !== "string" ||
		typeof bead !== "string" ||
		typeof flows !== "string" ||
		typeof artifacts !== "string"
	) {
		return undefined;
	}
	return { node, bead, flows, artifacts, ...(typeof check === "string" ? { check } : {}) };
};

/** The marker in a session's prompt: the system prompt first, then the conversation. */
const markerOf = (ctx: ExtensionContext, event: AgentBeforeSettleEvent): Marker | undefined => {
	const fromSystem = markerIn(ctx.getSystemPrompt());
	if (fromSystem) return fromSystem;
	for (const message of event.context.contextMessages) {
		const found = markerIn(textOf(message));
		if (found) return found;
	}
	return undefined;
};

/** The checks a node's flows file names, in order; no file means no checks. */
const checksFor = (marker: Marker): Check[] => {
	const path = join(marker.flows, marker.node);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.map((line) => {
			const [name, ...args] = line.split(/\s+/);
			return { name, args };
		});
};

/** The agent's final message: the last assistant message the run ended on. */
const finalMessageOf = (event: AgentBeforeSettleEvent): string => {
	for (let index = event.context.contextMessages.length - 1; index >= 0; index -= 1) {
		const message = event.context.contextMessages[index];
		if (message.role === "assistant") return textOf(message);
	}
	return "";
};

/** Run one check in the worktree; undefined when it passed, else the message to send back. */
const runCheck = (
	check: Check,
	marker: Marker,
	session: Session,
	cwd: string,
	finalMessageFile: string,
): string | undefined => {
	const script = join(checksDir(), check.name);
	if (!existsSync(script)) {
		return `flows: the check "${check.name}" is not in the checks folder.`;
	}
	const result = spawnSync(script, check.args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			ARTIFACTS_DIR: marker.artifacts,
			FLOWS_CHECK: marker.check ?? "",
			FLOWS_START_TREE: session.startTree ?? "",
			FLOWS_FINAL_MESSAGE: finalMessageFile,
		},
	});
	if (result.error) return `flows: cannot run "${check.name}": ${result.error.message}`;
	if (result.status === 0) return undefined;
	return result.stdout.trim() || result.stderr.trim() || `flows: the check "${check.name}" failed with exit code ${String(result.status)}.`;
};

/** Record the checks still failing when the agent may finish anyway. */
const recordFailures = (marker: Marker, failures: string[]): void => {
	if (failures.length === 0 || marker.artifacts === "") return;
	try {
		mkdirSync(marker.artifacts, { recursive: true });
		const lines = failures.map((failure) => `${marker.node}: ${failure}`).join("\n");
		appendFileSync(join(marker.artifacts, "flows-failed.txt"), `${lines}\n`);
	} catch (error) {
		console.error(`flows: cannot write the failed checks to ${marker.artifacts}: ${(error as Error).message}`);
	}
};

/** A session's state at this moment: the tree it starts on, and no send-backs yet. */
const newSession = (ctx: ExtensionContext): Session => ({ startTree: startTree(ctx.cwd), sendBacks: 0 });

/** A session's state, opened on first use and kept, so its start tree and send-backs stay put. */
const sessionFor = (ctx: ExtensionContext): Session => {
	const id = ctx.sessionManager.getSessionId();
	const session = sessions.get(id) ?? newSession(ctx);
	sessions.set(id, session);
	return session;
};

/** A node's start tree is the tree its session opens on; later turns keep the same one. */
const onSessionStart = (_event: SessionStartEvent, ctx: ExtensionContext): void => {
	sessions.set(ctx.sessionManager.getSessionId(), newSession(ctx));
};

/** Read the marker as the prompt arrives, before a long node's compaction can push it out of context. */
const onBeforeAgentStart = (event: BeforeAgentStartEvent, ctx: ExtensionContext): void => {
	const session = sessionFor(ctx);
	const prompt = event.messageType === "user" ? event.prompt : textOf(event.message);
	session.marker ??= markerIn(event.systemPrompt) ?? markerIn(prompt);
};

/**
 * Run the node's checks when its agent tries to finish. A failing check sends the agent
 * back with its message; after two send-backs the agent may finish, and the failures go
 * to the artifacts folder. A session without a marker is left alone.
 */
const onBeforeSettle = (
	event: AgentBeforeSettleEvent,
	ctx: ExtensionContext,
): AgentBeforeSettleEventResult | undefined => {
	if (event.outcome !== "completed") return undefined;
	const session = sessionFor(ctx);
	const marker = session.marker ?? markerOf(ctx, event);
	if (!marker) return undefined;
	session.marker = marker;
	session.checks ??= checksFor(marker);
	if (session.checks.length === 0) return undefined;
	const checks = session.checks;
	const finalMessageDir = mkdtempSync(join(tmpdir(), "flows-final-"));
	const finalMessageFile = join(finalMessageDir, "final-message");
	const failures: string[] = [];
	try {
		writeFileSync(finalMessageFile, finalMessageOf(event));
		for (const check of checks) {
			const failure = runCheck(check, marker, session, ctx.cwd, finalMessageFile);
			if (failure !== undefined) failures.push(failure);
		}
	} finally {
		rmSync(finalMessageDir, { recursive: true, force: true });
	}
	if (failures.length === 0) return undefined;
	if (session.sendBacks >= MAX_SEND_BACKS) {
		recordFailures(marker, failures);
		return undefined;
	}
	session.sendBacks += 1;
	return {
		entries: [
			{
				type: "custom_message",
				customType: "flows",
				content: failures.join("\n\n"),
				display: true,
			},
		],
		continue: true,
	};
};

export default function flows(pi: ExtensionAPI): void {
	pi.on("session_start", onSessionStart);
	pi.on("before_agent_start", onBeforeAgentStart);
	pi.on("agent_before_settle", onBeforeSettle);
}
