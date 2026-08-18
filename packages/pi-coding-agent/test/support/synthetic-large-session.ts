const SYNTHETIC_SESSION_ID = "00000000-0000-7000-8000-000000000001";
const BASE_TIMESTAMP_MS = Date.parse("2026-01-01T00:00:00.000Z");
const TURN_COUNT = 64;

interface SyntheticSessionEntry {
	type: string;
	[key: string]: unknown;
}

function timestamp(offset: number): string {
	return new Date(BASE_TIMESTAMP_MS + offset * 1000).toISOString();
}

/**
 * Build a deterministic v3 session large enough to exercise compaction.
 *
 * The fixture is generated rather than copied from a real agent session so it
 * contains no user prompts, tool output, provider credentials, signatures, or
 * workstation paths. Cumulative usage is intentional: it gives findCutPoint()
 * a stable 160k-token context with a 20k-token recent window.
 */
export function createSyntheticLargeSessionJsonl(): string {
	const entries: SyntheticSessionEntry[] = [
		{
			type: "session",
			version: 3,
			id: SYNTHETIC_SESSION_ID,
			timestamp: timestamp(0),
			cwd: "/synthetic/project",
		},
	];

	let parentId: string | null = null;
	for (let turn = 0; turn < TURN_COUNT; turn++) {
		const userId = `synthetic-user-${turn.toString().padStart(3, "0")}`;
		entries.push({
			type: "message",
			id: userId,
			parentId,
			timestamp: timestamp(turn * 2 + 1),
			message: {
				role: "user",
				content: `Synthetic compaction input ${turn.toString().padStart(3, "0")}. ` + "neutral test data ".repeat(24),
				timestamp: BASE_TIMESTAMP_MS + (turn * 2 + 1) * 1000,
			},
		});

		const assistantId = `synthetic-assistant-${turn.toString().padStart(3, "0")}`;
		entries.push({
			type: "message",
			id: assistantId,
			parentId: userId,
			timestamp: timestamp(turn * 2 + 2),
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: `Synthetic compaction output ${turn.toString().padStart(3, "0")}. ` + "deterministic response ".repeat(24),
					},
				],
				api: "synthetic-api",
				provider: "synthetic-provider",
				model: "synthetic-model",
				usage: {
					input: 500,
					output: 250,
					cacheRead: (turn + 1) * 2500,
					cacheWrite: 0,
					totalTokens: 750 + (turn + 1) * 2500,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: BASE_TIMESTAMP_MS + (turn * 2 + 2) * 1000,
			},
		});
		parentId = assistantId;
	}

	return entries.map((entry) => JSON.stringify(entry)).join("\n");
}
