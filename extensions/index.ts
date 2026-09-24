/**
 * pi-telegram — Telegram Bot API tools for the pi coding agent.
 *
 * Souls act on Telegram directly, as their own bot identity:
 *
 *   tg_send     — send a message to the chat (split-safe)
 *   tg_react    — react with an emoji to a message
 *   tg_pin      — pin a message
 *   tg_edit     — edit one of your own messages
 *   tg_delete   — delete a message
 *   tg_unpin    — unpin message(s)
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

type TelegramResponse = {
	ok: boolean;
	error?: string;
	result?: unknown;
};

type TelegramPayload = {
	ok: boolean;
	description?: string;
	result?: unknown;
};

async function parseTelegramResponse(response: Response): Promise<TelegramResponse> {
	try {
		const payload = (await response.json()) as TelegramPayload;
		return { ok: payload.ok, error: payload.description, result: payload.result };
	} catch (error) {
		return {
			ok: false,
			error: `Telegram returned ${response.status} ${response.statusText}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

async function tg(method: string, body: Record<string, unknown>): Promise<TelegramResponse> {
	const token = process.env.TG_BOT_TOKEN;
	if (!token) return { ok: false, error: "TG_BOT_TOKEN not set" };
	const r = await fetch(`${API}/bot${token}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return parseTelegramResponse(r);
}

async function tgGet(method: string, params: Record<string, unknown>): Promise<TelegramResponse> {
	const token = process.env.TG_BOT_TOKEN;
	if (!token) return { ok: false, error: "TG_BOT_TOKEN not set" };
	const url = new URL(`${API}/bot${token}/${method}`);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}
	const r = await fetch(url);
	return parseTelegramResponse(r);
}

function configuredReactionHint(chat: unknown): string | null {
	const available = (chat as { available_reactions?: Array<{ type?: string; emoji?: string }> })
		?.available_reactions;
	if (!Array.isArray(available) || available.length === 0) return null;
	const emojis = available
		.filter((reaction) => reaction.type === "emoji" && reaction.emoji)
		.map((reaction) => reaction.emoji);
	if (emojis.length === 0) return "chat only allows custom reactions that bots cannot send";
	return `allowed reactions in this chat: ${emojis.join(" ")}`;
}

function defaultThread(): number | undefined {
	const raw = process.env.TG_THREAD ?? process.env.PI_TEAM_THREAD;
	if (!raw) return undefined;
	const thread = Number(raw);
	return Number.isFinite(thread) && thread > 0 ? thread : undefined;
}

const chatBody = (thread?: number) => {
	const b: Record<string, unknown> = { chat_id: process.env.TG_CHAT };
	const t = thread ?? defaultThread();
	if (t) b.message_thread_id = t;
	return b;
};

function emojiCount(value: string): number {
	if (typeof Intl.Segmenter === "function") {
		const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
		return Array.from(segmenter.segment(value.trim())).length;
	}
	return Array.from(value.trim()).length;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Send a request to the host via the team mailbox; poll for the reply. */
async function mailbox(kind: string, text: string): Promise<string | null> {
	const dir =
		process.env.PI_TEAM_DIR ??
		join(homedir(), ".local/state/telegram-agent/team");
	const reqDir = join(dir, "requests");
	const repDir = join(dir, "replies");
	const id = randomUUID();

	try {
		mkdirSync(reqDir, { recursive: true });
		mkdirSync(repDir, { recursive: true });
		writeFileSync(
			join(reqDir, `${id}.json`),
			JSON.stringify({
				id,
				from: process.env.PI_TEAM_FROM ?? "?",
				to: "host",
				kind,
				text,
				chat: process.env.PI_TEAM_CHAT,
				thread: process.env.PI_TEAM_THREAD,
				at: Date.now(),
			}),
		);
	} catch (error) {
		return `(mailbox request failed: ${errorMessage(error)})`;
	}

	const file = join(repDir, `${id}.json`);
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (existsSync(file)) {
			try {
				const r = JSON.parse(readFileSync(file, "utf-8"));
				return String(r.text ?? "");
			} catch (error) {
				if (error instanceof SyntaxError) {
					/* partial write — retry */
				} else {
					return `(mailbox reply read failed: ${errorMessage(error)})`;
				}
			}
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	return null;
}

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
			thread: Type.Optional(Type.Number({ description: "topic/message_thread_id — default: current" })),
		}),
		async execute(_id, params) {
			const chunks: string[] = [];
			for (let i = 0; i < params.text.length; i += MAX_LEN)
				chunks.push(params.text.slice(i, i + MAX_LEN));
			const ids: number[] = [];
			for (const [i, c] of chunks.entries()) {
				const r = await tg("sendMessage", {
					...chatBody(params.thread),
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
			const emoji = params.emoji.trim();
			if (emojiCount(emoji) !== 1) {
				return {
					content: [
						{ type: "text" as const, text: "failed: reaction must be exactly one emoji grapheme" },
					],
				};
			}

			const r = await tg("setMessageReaction", {
				chat_id: process.env.TG_CHAT,
				message_id: params.message_id,
				reaction: [{ type: "emoji", emoji }],
			});
			if (r.ok) {
				return {
					content: [{ type: "text" as const, text: "reacted" }],
				};
			}

			let hint = "";
			if (r.error?.includes("REACTION_INVALID")) {
				const chat = await tgGet("getChat", { chat_id: process.env.TG_CHAT });
				const reactionHint = chat.ok ? configuredReactionHint(chat.result) : null;
				hint = reactionHint
					? ` (${reactionHint})`
					: " (Telegram rejected this emoji for the chat; try a default enabled reaction such as 👀 or 👍)";
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `failed: ${r.error}${hint}`,
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
		description: "Search the chat journal — who said what, when. Answers 'کی اینو گفت' / 'آخرین بار کی این باگ اومد' without guessing.",
		parameters: Type.Object({
			query: Type.String({ description: "substring to search" }),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const rep = await mailbox(
				"history",
				`${params.query}|||${params.limit ?? 10}`,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: rep ?? "(history lookup timed out)",
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "tg_topics",
		label: "Telegram Topics",
		description:
			"List the group's forum topics — 'id — name' lines. Use the id as thread= for tg_send to post in a topic.",
		promptSnippet: "List forum topics",
		parameters: Type.Object({}),
		async execute() {
			// Live topics from the host's learned topics table via the
			// mailbox (kind=topics) — env map is only a fallback.
			const rep = await mailbox("topics", "");
			if (rep) {
				return { content: [{ type: "text" as const, text: rep }] };
			}
			const map = process.env.TG_TOPICS ?? "";
			const lines = map
				.split(",")
				.map((p) => p.trim())
				.filter(Boolean)
				.map((p) => {
					const [id, ...rest] = p.split(":");
					return `${id} — ${rest.join(":")}`;
				});
			const text = lines.length
				? "topics:\n" + lines.join("\n") + "\n(general/main chat = no thread)"
				: "(no topics learned yet)";
			return { content: [{ type: "text" as const, text }] };
		},
	});

	pi.registerTool({
		name: "tg_delete",
		label: "Telegram Delete",
		description:
			"Delete a message — your own always; others' only if your bot is an admin with delete rights.",
		parameters: Type.Object({
			message_id: Type.Number(),
		}),
		async execute(_id, params) {
			const r = await tg("deleteMessage", {
				chat_id: process.env.TG_CHAT,
				message_id: params.message_id,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: r.ok ? "deleted" : `failed: ${r.error}`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "tg_unpin",
		label: "Telegram Unpin",
		description: "Unpin a message (or all pinned in the topic).",
		parameters: Type.Object({
			message_id: Type.Optional(Type.Number({ description: "omit = unpin all" })),
		}),
		async execute(_id, params) {
			const method = params.message_id ? "unpinChatMessage" : "unpinAllChatMessages";
			const r = await tg(method, {
				chat_id: process.env.TG_CHAT,
				...(params.message_id ? { message_id: params.message_id } : {}),
			});
			return {
				content: [
					{ type: "text" as const, text: r.ok ? "unpinned" : `failed: ${r.error}` },
				],
			};
		},
	});
}
