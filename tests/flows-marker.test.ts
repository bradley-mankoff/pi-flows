/**
 * A Flows marker is a line pi-flows takes for its own instruction when a pi session reads it,
 * in its prompt or in anything else in its context, and the marker fixes the Run's artifacts
 * folder, where the extension keeps the node's start tree and writes a failed check's report.
 * README's example once named absolute `/runs/1` folders, so a session that opened the README
 * outside a Run carried a marker that was not a Run's (pi-flows-ct6, the same bug the Factory
 * fixed in its own docs as fac-3xv). No file this repo ships may carry one.
 *
 * The seam is this repo's shipped files, read the way a session reads them. The Bead and its
 * absent Epic name no seam, and the highest one this package has, a pi session with the
 * extension loaded, cannot see this bug: the example's folders name nothing a test can create,
 * so the marker leaves no trace in a session. The Factory's docs scan took the same seam for
 * the same bug. The marker's rule is restated here rather than exported from the extension for
 * the test: in a text the first line that trims to start with FLOWS decides, and it is a marker
 * only when its JSON names a string node, flows and artifacts and the artifacts folder is
 * absolute; a check that is not a string is dropped, which leaves a marker with no check
 * command. A change to the parser needs this scan changed with it; the second test holds the
 * scan to a known-good marker, so the empty result is a pass and not a rule that matches
 * nothing.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Folders that hold no file this repo ships: git's own, the Beads database, installed modules. */
const skippedFolders = new Set([".git", ".beads", "node_modules"]);

/** Every file under a folder, skipping the folders above, in one order whatever the disk says. */
const files = (folder: string): string[] =>
	readdirSync(folder, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name))
		.flatMap((entry) => {
			if (skippedFolders.has(entry.name)) return [];
			const path = join(folder, entry.name);
			return entry.isDirectory() ? files(path) : [path];
		});

/**
 * The line pi-flows would take for a marker in a text, by its number, or undefined. The package
 * reads the first line that trims to start with FLOWS, and a line it cannot parse leaves the
 * text without a marker, so a later line is not read either.
 */
const markerLine = (text: string): number | undefined => {
	const lines = text.split("\n");
	const index = lines.findIndex((line) => line.trim().startsWith("FLOWS "));
	if (index === -1) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(lines[index].trim().slice("FLOWS ".length));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { node, flows, artifacts } = parsed as Record<string, unknown>;
	if (typeof node !== "string" || typeof flows !== "string" || typeof artifacts !== "string") {
		return undefined;
	}
	return isAbsolute(artifacts) ? index + 1 : undefined;
};

/** Each file the package would read a marker in, as `<file>:<line>` relative to the folder. */
const markerLines = (folder: string): string[] =>
	files(folder).flatMap((path) => {
		const line = markerLine(readFileSync(path, "utf8"));
		return line === undefined ? [] : [`${relative(folder, path)}:${line}`];
	});

test("no file this repo ships carries a line pi-flows would take for a node's marker", () => {
	assert.deepEqual(markerLines(root), [], "only a Run's prompt carries a Flows marker");
});

test("the scan takes a real marker, so the empty scan above is a pass and not a rule that matches nothing", () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-flows-marker-"));
	try {
		// The shape a Run's prompt carries: a node and folders a Run created, the artifacts
		// folder absolute.
		const marker = { node: "work", flows: "/runs/1/flows", artifacts: "/runs/1/artifacts", check: "npm test" };
		writeFileSync(join(folder, "run.md"), `A Run's prompt says:\n\n    FLOWS ${JSON.stringify(marker)}\n`);
		assert.deepEqual(markerLines(folder), ["run.md:3"]);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});
