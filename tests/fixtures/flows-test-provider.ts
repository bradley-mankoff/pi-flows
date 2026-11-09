/**
 * The outside service the Flows tests talk to: a pi provider whose agent is scripted
 * turn by turn.
 *
 * FLOWS_TEST_SCRIPT names a JSON file holding an array of steps. Each model request takes
 * the next step:
 *
 *   { "text": "..." }                         finish with this text
 *   { "tool": "bash", "arguments": {...} }    call the named tool
 *
 * A request past the end of the array finishes with "done". The provider writes one JSON
 * object a line per request to FLOWS_TEST_LOG: the step it answered with, and the text of
 * the conversation it was sent, so a test can see that the check's message came back.
 */
import { appendFileSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { textOf } from "../../extensions/flows.ts";

const api = "flows-test";
const log = process.env.FLOWS_TEST_LOG ?? "/dev/null";

type Step = { text: string } | { tool: string; arguments: Record<string, unknown> };

const script: Step[] = (() => {
	const path = process.env.FLOWS_TEST_SCRIPT;
	if (!path) return [];
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Step[];
	} catch {
		return [];
	}
})();

let request = 0;

const model = (id: string) => ({
	id,
	name: id,
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
});

const message = (requested: Model<Api>, rest: Partial<AssistantMessage>): AssistantMessage => ({
	role: "assistant",
	content: [],
	api: requested.api,
	provider: requested.provider,
	model: requested.id,
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
	...rest,
});

export default function flowsTestProvider(pi: ExtensionAPI): void {
	const streamSimple = (requested: Model<Api>, context: unknown, _options?: SimpleStreamOptions) => {
		const step = script[request] ?? { text: "done" };
		appendFileSync(
			log,
			`${JSON.stringify({
				step: request,
				messages: ((context as { messages?: unknown[] }).messages ?? []).map(textOf),
			})}\n`,
		);
		request += 1;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			if ("text" in step) {
				const answer = message(requested, { content: [{ type: "text", text: step.text }] });
				stream.push({ type: "start", partial: answer });
				stream.push({ type: "text_start", contentIndex: 0, partial: answer });
				stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: answer });
				stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: answer });
				stream.push({ type: "done", reason: "stop", message: answer });
				return;
			}
			const toolCall = {
				type: "toolCall" as const,
				id: `call_${String(request)}`,
				name: step.tool,
				arguments: step.arguments,
			};
			const answer = message(requested, { content: [toolCall], stopReason: "toolUse" });
			stream.push({ type: "start", partial: answer });
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: answer });
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(step.arguments), partial: answer });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: answer });
			stream.push({ type: "done", reason: "toolUse", message: answer });
		});
		return stream;
	};

	pi.registerProvider("test", {
		name: "Flows test provider",
		api,
		apiKey: "test-key",
		baseUrl: "http://localhost:0",
		models: [model("agent")],
		streamSimple,
	});
}
