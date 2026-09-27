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

test("telegram tools fail before API calls when TG_THREAD is invalid", async () => {
	process.env.TG_BOT_TOKEN = "secret-token";
	process.env.TG_CHAT = "123";
	process.env.TG_THREAD = "abc";
	let called = false;
	globalThis.fetch = (async () => {
		called = true;
		throw new Error("unexpected fetch");
	}) as typeof fetch;

	const result = await tools().tg_send.execute("1", { text: "hi" });

	assert.equal(called, false);
	assert.match(result.content[0].text, /TG_THREAD is set but invalid: "abc"/);
});

test("telegram tools fail before API calls when PI_TEAM_THREAD fallback is invalid", async () => {
	process.env.TG_BOT_TOKEN = "secret-token";
	process.env.TG_CHAT = "123";
	delete process.env.TG_THREAD;
	process.env.PI_TEAM_THREAD = "nope";
	let called = false;
	globalThis.fetch = (async () => {
		called = true;
		throw new Error("unexpected fetch");
	}) as typeof fetch;

	const result = await tools().tg_send.execute("1", { text: "hi" });

	assert.equal(called, false);
	assert.match(result.content[0].text, /TG_THREAD is set but invalid: "nope"/);
});

test("telegram tools work when TG_THREAD is empty or unset", async () => {
	process.env.TG_BOT_TOKEN = "secret-token";
	process.env.TG_CHAT = "123";
	process.env.TG_THREAD = "";
	let called = 0;
	globalThis.fetch = (async () => {
		called++;
		return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
	}) as typeof fetch;

	const withEmpty = await tools().tg_send.execute("1", { text: "hi" });
	assert.equal(called, 1);
	assert.match(withEmpty.content[0].text, /sent/);

	delete process.env.TG_THREAD;
	delete process.env.PI_TEAM_THREAD;
	const unset = await tools().tg_send.execute("1", { text: "hi" });
	assert.equal(called, 2);
	assert.match(unset.content[0].text, /sent/);
});

test("telegram tools work when TG_THREAD is a positive integer", async () => {
	process.env.TG_BOT_TOKEN = "secret-token";
	process.env.TG_CHAT = "123";
	process.env.TG_THREAD = "42";
	let called = 0;
	globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
		called++;
		const body = JSON.parse(String(init?.body));
		assert.equal(body.message_thread_id, 42);
		return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
	}) as typeof fetch;

	const result = await tools().tg_send.execute("1", { text: "hi" });

	assert.equal(called, 1);
	assert.match(result.content[0].text, /sent/);
});
