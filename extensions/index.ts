/**
 * pi-telegram — Telegram Bot API tools for the pi coding agent.
 *
 * Souls act on Telegram directly, as their own bot identity:
 *
 *   tg_send     — send a message to the chat (split-safe)
 *   tg_react    — react with an emoji to a message
 *   tg_pin      — pin a message
 *   tg_edit     — edit one of your own messages
 *   tg_history  — search the host's message journal (via team mailbox)
 *
 * Env (injected by the host):
 *   TG_BOT_TOKEN — the agent's own bot token (its identity)
 *   TG_CHAT      — chat id to post into
 *   TG_THREAD    — forum topic id (optional)
 *   PI_TEAM_DIR  — mailbox for tg_history (default ~/.local/state/.../team)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";

const API = "https://api.telegram.org";

const MAX_LEN = 4000;

async function tg(method: string, body: Record<string, unknown>) {
	const token = process.env.TG_BOT_TOKEN;
	if (!token) return { ok: false, error: "TG_BOT_TOKEN not set" };
	const r = await fetch(`${API}/bot${token}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const d = (await r.json()) as {
		ok: boolean;
		description?: string;
		result?: unknown;
	};
	return { ok: d.ok, error: d.description, result: d.result };
}

const chatBody = () => {
	const b: Record<string, unknown> = { chat_id: process.env.TG_CHAT };
	if (process.env.TG_THREAD)
		b.message_thread_id = Number(process.env.TG_THREAD);
	return b;
};

export default function piTelegram(pi: ExtensionAPI) {
	pi.registerTool({
		name: "tg_send",
		label: "Telegram Send",
		description:
			"Send a message to the chat as YOUR bot identity. Use for proactive updates — you don't have to wait to be asked.",
		promptSnippet: "Send a Telegram message",
		parameters: Type.Object({
			text: Type.String(),
			reply_to: Type.Optional(Type.Number({ description: "message_id" })),
		}),
		async execute(_id, params) {
			const chunks: string[] = [];
			for (let i = 0; i < params.text.length; i += MAX_LEN)
				chunks.push(params.text.slice(i, i + MAX_LEN));
			const ids: number[] = [];
			for (const [i, c] of chunks.entries()) {
				const r = await tg("sendMessage", {
					...chatBody(),
					text: c,
					reply_parameters:
						params.reply_to && i === 0
							? { message_id: params.reply_to }
							: undefined,
				});
				if (!r.ok)
					return {
						content: [
							{ type: "text" as const, text: `send failed: ${r.error}` },
						],
					};
				ids.push((r.result as { message_id: number }).message_id);
			}
			return {
				content: [
					{ type: "text" as const, text: `sent (ids: ${ids.join(",")})` },
				],
				details: { message_ids: ids },
			};
		},
	});

	pi.registerTool({
		name: "tg_react",
		label: "Telegram React",
		description: "React with an emoji to a message (👀 while working, ✅ when done).",
		parameters: Type.Object({
			message_id: Type.Number(),
			emoji: Type.String({ description: "single emoji, e.g. 👀 ✅ 🔥" }),
		}),
		async execute(_id, params) {
			const r = await tg("setMessageReaction", {
				chat_id: process.env.TG_CHAT,
				message_id: params.message_id,
				reaction: [{ type: "emoji", emoji: params.emoji }],
			});
			return {
				content: [
					{
						type: "text" as const,
						text: r.ok ? "reacted" : `failed: ${r.error}`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "tg_pin",
		label: "Telegram Pin",
		description: "Pin a message in the chat.",
		parameters: Type.Object({
			message_id: Type.Number(),
			notify: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params) {
			const r = await tg("pinChatMessage", {
				chat_id: process.env.TG_CHAT,
				message_id: params.message_id,
				disable_notification: !params.notify,
			});
			return {
				content: [
					{ type: "text" as const, text: r.ok ? "pinned" : `failed: ${r.error}` },
				],
			};
		},
	});

	pi.registerTool({
		name: "tg_edit",
		label: "Telegram Edit",
		description: "Edit one of your own messages.",
		parameters: Type.Object({
			message_id: Type.Number(),
			text: Type.String(),
		}),
		async execute(_id, params) {
			const r = await tg("editMessageText", {
				chat_id: process.env.TG_CHAT,
				message_id: params.message_id,
				text: params.text.slice(0, MAX_LEN),
			});
			return {
				content: [
					{ type: "text" as const, text: r.ok ? "edited" : `failed: ${r.error}` },
				],
			};
		},
	});

	pi.registerTool({
		name: "tg_history",
		label: "Telegram History",
		description:
			"Search the chat journal — who said what, when. Answers 'کی اینو گفت' / 'آخرین بار کی این باگ اومد' without guessing.",
		promptSnippet: "Search chat history",
		parameters: Type.Object({
			query: Type.String({ description: "substring to search" }),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const dir =
				process.env.PI_TEAM_DIR ??
				join(homedir(), ".local/state/telegram-agent/team");
			const reqDir = join(dir, "requests");
			const repDir = join(dir, "replies");
			mkdirSync(reqDir, { recursive: true });
			mkdirSync(repDir, { recursive: true });
			const id = randomUUID();
			writeFileSync(
				join(reqDir, `${id}.json`),
				JSON.stringify({
					id,
					from: process.env.PI_TEAM_FROM ?? "?",
					to: "host",
					kind: "history",
					text: `${params.query}|||${params.limit ?? 10}`,
					chat: process.env.PI_TEAM_CHAT,
					thread: process.env.PI_TEAM_THREAD,
					at: Date.now(),
				}),
			);
			const file = join(repDir, `${id}.json`);
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				if (existsSync(file)) {
					try {
						const r = JSON.parse(readFileSync(file, "utf-8"));
						return {
							content: [
								{ type: "text" as const, text: String(r.text ?? "") },
							],
						};
					} catch {
						/* retry */
					}
				}
				await new Promise((r) => setTimeout(r, 600));
			}
			return {
				content: [
					{ type: "text" as const, text: "(history lookup timed out)" },
				],
			};
		},
	});
}
