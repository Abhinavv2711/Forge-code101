import { TrueForge } from "@truefoundry/trueforge-sdk"
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk"

import { DEFAULT_INSTRUCTIONS, getTrueForgeConfig, type TrueForgeConfig } from "./config"
import { startTrueForgeMcpServer, type McpServerHandle } from "./mcpServer"

export interface TaskSession {
	sessionId: string
	workspaceRoot: string
	turnId?: string
}

type TurnEvent = TrueForgeApi.TurnStreamingEvent

export class TrueForgeService {
	private static _instance: TrueForgeService | undefined

	static get instance(): TrueForgeService {
		return (this._instance ??= new TrueForgeService())
	}

	private client: TrueForge | undefined
	private clientBaseUrl: string | undefined
	private mcpServer: McpServerHandle | undefined
	private mcpWorkspaceRoot: string | undefined
	private sessions = new Map<string, TaskSession>()

	private getClient(config: TrueForgeConfig): TrueForge {
		if (!this.client || this.clientBaseUrl !== config.baseUrl) {
			this.client = new TrueForge({ baseUrl: config.baseUrl, maxRetries: 0, timeoutInSeconds: 120 })
			this.clientBaseUrl = config.baseUrl
		}

		return this.client
	}

	async ensureReady(workspaceRoot: string): Promise<{ client: TrueForge; config: TrueForgeConfig }> {
		const config = getTrueForgeConfig()
		const client = this.getClient(config)

		if (!this.mcpServer || this.mcpWorkspaceRoot !== workspaceRoot) {
			await this.mcpServer?.close().catch(() => undefined)

			this.mcpServer = await startTrueForgeMcpServer({ workspaceRoot, port: config.mcpPort })
			this.mcpWorkspaceRoot = workspaceRoot
		}

		await this.registerMcpServer(client, config, this.mcpServer.url)

		return { client, config }
	}

	private async registerMcpServer(client: TrueForge, config: TrueForgeConfig, url: string): Promise<void> {
		try {
			await client.settings.mcpServers.createOrUpdate({
				manifest: {
					name: config.mcpServerName,
					description: "Editor tools for the VS Code coding agent: read, search, edit files and run commands.",
					type: "remote",
					url,
				},
			})
		} catch (error: any) {
			const message: string = error?.body?.error?.message ?? error?.message ?? String(error)

			if (message.includes("Outbound URL blocked")) {
				const host = new URL(url).hostname
				throw new Error(
					`TrueForge refused to connect to the local editor MCP server at ${url} (${message}). ` +
						`Restart TrueForge with OUTBOUND_URL_ALLOWED_HOSTS='["${host}"]' ` +
						`(or NETWORK_POLICY_ENABLED=false) so it can reach the VS Code tools.`,
				)
			}

			throw error
		}
	}

	async createTaskSession(taskId: string, workspaceRoot: string, model?: string): Promise<TaskSession> {
		const { client, config } = await this.ensureReady(workspaceRoot)

		const response = await client.sessions.create({
			agent: config.agentName
				? { name: config.agentName }
				: {
						spec: {
							model: { name: model ?? config.model },
							instructions: config.instructions ?? DEFAULT_INSTRUCTIONS,
							config: {
								generativeUi: { enabled: false },
								contextManagement: {
									compaction: { enabled: true },
								},
								dynamicSubAgents: { enabled: true },
							},
							mcpServers: [
								{
									name: config.mcpServerName,
									enableTools: ["@all"],
									preload: true,
									requireApprovalForTools: [],
								},
							],
						},
					},
		})

		const session: TaskSession = { sessionId: response.data.id, workspaceRoot }
		this.sessions.set(taskId, session)
		return session
	}

	async getOrCreateTaskSession(taskId: string, workspaceRoot: string, model?: string): Promise<TaskSession> {
		return this.sessions.get(taskId) ?? (await this.createTaskSession(taskId, workspaceRoot, model))
	}

	async *streamTurn(
		taskId: string,
		text: string,
		files: Array<{ data: string; name: string }> = [],
	): AsyncGenerator<TurnEvent, void, unknown> {
		const session = this.sessions.get(taskId)

		if (!session) {
			throw new Error("No TrueForge session exists for this task.")
		}

		const { client } = await this.ensureReady(session.workspaceRoot)
		const content =
			files.length > 0
				? [
						{ type: "text" as const, text },
						...files.map((file) => ({ type: "file" as const, data: file.data, name: file.name })),
					]
				: text

		const stream = await client.sessions.createTurnStream(session.sessionId, {
			input: [{ type: "user.message", content }],
		})

		for await (const event of stream) {
			if (event.type === "turn.created") {
				session.turnId = event.turnId
			}

			yield event
		}
	}

	async releaseTask(taskId: string): Promise<void> {
		this.sessions.delete(taskId)
	}

	async cancelTask(taskId: string): Promise<void> {
		const session = this.sessions.get(taskId)
		this.sessions.delete(taskId)

		if (!session) {
			return
		}

		try {
			const config = getTrueForgeConfig()
			await this.getClient(config).sessions.cancel(session.sessionId)
		} catch {
			// The turn may already be finished or the session may be gone.
		}
	}

	async runSingleTurn(
		_workspaceRoot: string,
		instructions: string,
		text: string,
		model: string = getTrueForgeConfig().model,
	): Promise<string> {
		const config = getTrueForgeConfig()
		const client = this.getClient(config)
		const response = await client.sessions.create({
			agent: {
				spec: {
					model: { name: model },
					instructions,
					mcpServers: [],
					config: {
						generativeUi: { enabled: false },
						askUserQuestions: { enabled: false },
						dynamicSubAgents: { enabled: false },
					},
				},
			},
		})

		const sessionId = response.data.id
		let output = ""

		try {
			const stream = await client.sessions.createTurnStream(sessionId, {
				input: [{ type: "user.message", content: text }],
			})

			for await (const event of stream) {
				if (event.type === "model.message.delta" && event.content) {
					output += event.content
				} else if (event.type === "model.message" && !output && typeof event.content === "string") {
					output = event.content
				}
			}
		} finally {
			await client.sessions.delete(sessionId).catch(() => undefined)
		}

		return output.trim()
	}

	async approveToolCall(taskId: string, threadId: string, toolCallId: string): Promise<void> {
		const session = this.sessions.get(taskId)

		if (!session?.turnId) {
			return
		}

		const config = getTrueForgeConfig()
		await this.getClient(config).sessions.createTurnEvent(session.sessionId, session.turnId, {
			events: [
				{
					type: "user.tool_approval",
					threadId,
					toolCallId,
					approval: { status: "allow" },
				},
			],
		})
	}

	async dispose(): Promise<void> {
		const active = [...this.sessions.keys()]
		await Promise.all(active.map((taskId) => this.cancelTask(taskId)))
		await this.mcpServer?.close().catch(() => undefined)
		this.mcpServer = undefined
		this.mcpWorkspaceRoot = undefined
	}
}
