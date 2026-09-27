import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piTelegram from "../extensions/index.ts";

type Tool = {
	execute: (
		_id: string,
		params: Record<string, unknown>,
	) => Promise<{ content: { type: "text"; text: string }[] }>;
};

const originalEnv = { ...process.env };
const tmpdirs: string[] = [];

afterEach(() => {
	process.env = { ...originalEnv };
	while (tmpdirs.length) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

function tools(): Record<string, Tool> {
	const registered: Record<string, Tool> = {};
	piTelegram({
		registerTool(tool: Tool & { name: string }) {
			registered[tool.name] = tool;
		},
	} as never);
	return registered;
}

function tmpTeamDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-team-"));
	tmpdirs.push(dir);
	return dir;
}

/** Watch requests/, answer each request with a reply file, return seen ids. */
function autoReplier(dir: string, replyText: string): { stop: () => void; ids: string[] } {
	const ids: string[] = [];
	const reqDir = join(dir, "requests");
	const repDir = join(dir, "replies");
	const timer = setInterval(() => {
		let names: string[] = [];
		try {
			names = readdirSync(reqDir);
		} catch {
			return;
		}
		for (const name of names) {
			const id = name.replace(/\.json$/, "");
			if (ids.includes(id)) continue;
			try {
				JSON.parse(readFileSync(join(reqDir, name), "utf-8"));
			} catch {
				continue; // partial write
			}
			ids.push(id);
			mkdirSync(repDir, { recursive: true });
			writeFileSync(join(repDir, name), JSON.stringify({ text: replyText }));
		}
	}, 20);
	return { stop: () => clearInterval(timer), ids };
}

const jsonFiles = (dir: string): string[] => {
	try {
		return readdirSync(dir).filter((n) => n.endsWith(".json"));
	} catch {
		return [];
	}
};

test("mailbox leaves replies/ empty after a successful call", async () => {
	const dir = tmpTeamDir();
	process.env.PI_TEAM_DIR = dir;
	const replier = autoReplier(dir, "1 — general");

	const result = await tools().tg_history.execute("1", { query: "bug" });
	replier.stop();

	assert.equal(result.content[0].text, "1 — general");
	assert.equal(replier.ids.length, 1);
	assert.deepEqual(jsonFiles(join(dir, "replies")), []);
});

test("mailbox removes the request file on timeout and sweeps stale files", async () => {
	const dir = tmpTeamDir();
	process.env.PI_TEAM_DIR = dir;
	process.env.PI_TEAM_MAILBOX_TIMEOUT_MS = "300";

	// Seed stale files (>30min old mtime is simulated by sweep cutoff — use old names).
	const repDir = join(dir, "replies");
	mkdirSync(repDir, { recursive: true });
	const stale = join(repDir, "stale.json");
	writeFileSync(stale, "{}");
	const old = new Date(Date.now() - 60 * 60_000);
	const { utimesSync } = await import("node:fs");
	utimesSync(stale, old, old);

	const result = await tools().tg_history.execute("1", { query: "x" });

	assert.match(result.content[0].text, /timed out/);
	assert.deepEqual(jsonFiles(join(dir, "requests")), []);
	assert.deepEqual(jsonFiles(repDir), []); // stale file swept
});

test("mailbox swallows cleanup failures without changing tool output", async () => {
	const dir = tmpTeamDir();
	process.env.PI_TEAM_DIR = dir;
	const replier = autoReplier(dir, "ok");

	// A directory named "*.json" makes unlinkSync fail inside the sweep.
	const repDir = join(dir, "replies");
	mkdirSync(join(repDir, "unremovable.json"), { recursive: true });

	const result = await tools().tg_history.execute("1", { query: "bug" });
	replier.stop();

	assert.equal(result.content[0].text, "ok");
});
