import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import piTelegram from "../extensions/index.ts";

type Tool = {
	execute: (
		_id: string,
		params: Record<string, unknown>,
	) => Promise<{ content: { type: "text"; text: string }[] }>;
};

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

afterEach(() => {
	process.env = { ...originalEnv };
	globalThis.fetch = originalFetch;
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

test("telegram tools fail before API calls when TG_CHAT is missing", async () => {
	process.env.TG_BOT_TOKEN = "secret-token";
	delete process.env.TG_CHAT;
	let called = false;
	globalThis.fetch = (async () => {
		called = true;
		throw new Error("unexpected fetch");
	}) as typeof fetch;

	const result = await tools().tg_send.execute("1", { text: "hi" });

	assert.equal(called, false);
	assert.match(result.content[0].text, /TG_CHAT not set/);
});

test("telegram tools fail before API calls when TG_BOT_TOKEN is missing", async () => {
	delete process.env.TG_BOT_TOKEN;
	process.env.TG_CHAT = "123";
	let called = false;
	globalThis.fetch = (async () => {
		called = true;
		throw new Error("unexpected fetch");
	}) as typeof fetch;

	const result = await tools().tg_send.execute("1", { text: "hi" });

	assert.equal(called, false);
	assert.match(result.content[0].text, /TG_BOT_TOKEN not set/);
});
