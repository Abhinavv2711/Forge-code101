import type { Task } from "../task/Task"

import { getTrueForgeConfig } from "./config"
import { renderContext, selectContextFiles } from "./context"
import { TrueForgeService } from "./TrueForgeService"

interface FileInput {
	data: string
	name: string
}

interface ExtractedContent {
	text: string
	files: FileInput[]
}

interface ThreadBuffer {
	text: string
	reasoning: string
}

interface TurnResult {
	sawError: boolean
	errorMessage?: string
}

function extractContent(content: readonly unknown[]): ExtractedContent {
	const textParts: string[] = []
	const files: FileInput[] = []

	for (const rawBlock of content) {
		const block = rawBlock as {
			type?: string
			text?: string
			source?: { type?: string; media_type?: string; data?: string }
		}

		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text)
			continue
		}

		if (block.type === "image" && block.source?.type === "base64" && block.source.data) {
			const mime = block.source.media_type ?? "image/png"
			files.push({ data: `data:${mime};base64,${block.source.data}`, name: `image-${files.length + 1}.png` })
		}
	}

	return { text: textParts.join("\n\n").trim(), files }
}

function imageFiles(images: string[]): FileInput[] {
	return images.map((image, index) => ({
		data: image.startsWith("data:") ? image : `data:image/png;base64,${image}`,
		name: `image-${index + 1}.png`,
	}))
}

function finalContent(event: { content?: string | readonly { type?: string; text?: string }[] | null }): string {
	if (typeof event.content === "string") {
		return event.content
	}

	if (Array.isArray(event.content)) {
		return event.content
			.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
			.join("")
	}

	return ""
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message
	}

	return String(error)
}

async function streamOneTurn(task: Task, text: string, files: FileInput[]): Promise<TurnResult> {
	const service = TrueForgeService.instance
	const buffers = new Map<string, ThreadBuffer>()
	const announcedTools = new Set<string>()
	let error: string | undefined

	const bufferFor = (threadId: string): ThreadBuffer => {
		let buffer = buffers.get(threadId)

		if (!buffer) {
			buffer = { text: "", reasoning: "" }
			buffers.set(threadId, buffer)
		}

		return buffer
	}

	try {
		for await (const event of service.streamTurn(task.taskId, text, files)) {
			if (task.abort) {
				break
			}

			switch (event.type) {
				case "model.message.delta": {
					const buffer = bufferFor(event.threadId)

					if (event.reasoningContent) {
						buffer.reasoning += event.reasoningContent
						await task.say("reasoning", buffer.reasoning, undefined, true)
					}

					if (event.content) {
						buffer.text += event.content
						await task.say("text", buffer.text, undefined, true)
					}

					for (const call of event.toolCalls ?? []) {
						const name = call.function?.name
						const key = call.id ?? name

						if (name && key && !announcedTools.has(key)) {
							announcedTools.add(key)
							const label = call.toolInfo?.type === "mcp" ? `${name} (${call.toolInfo.serverName})` : name
							await task.say("text", `${buffer.text ? "\n\n" : ""}Using tool \`${label}\`...`)
						}
					}

					break
				}

				case "tool.response": {
					await task.say("text", "Tool finished.")
					break
				}

				case "model.message": {
					const buffer = bufferFor(event.threadId)
					const content = finalContent(event)

					if (content && content !== buffer.text) {
						buffer.text = content
						await task.say("text", content, undefined, false)
					} else if (content && buffer.text) {
						await task.say("text", buffer.text, undefined, false)
					}

					if (event.reasoningContent) {
						await task.say("reasoning", event.reasoningContent, undefined, false)
					}

					break
				}

				case "tool.approval_required": {
					await task.say(
						"text",
						`Approving ${event.toolCalls.length} TrueForge tool call(s). File edits and commands are approved inside VS Code.`,
					)

					for (const call of event.toolCalls) {
						await service.approveToolCall(task.taskId, event.threadId, call.id)
					}

					break
				}

				case "tool.response_required": {
					error = "The TrueForge agent requested a client-side tool result, but this extension only provides MCP tools."
					break
				}

				case "mcp.auth_required": {
					const servers = event.mcpServers.map((server) => server.name).join(", ")
					error = `The TrueForge agent needs MCP authorization${servers ? ` for ${servers}` : ""}. Configure it in TrueForge and try again.`
					break
				}

				case "thread.context_compaction_started": {
					await task.say("text", "Context compaction started: summarizing earlier conversation history to manage token budget...")
					break
				}

				case "thread.context_compaction_finished": {
					const durationSec = (event.durationMs / 1000).toFixed(1)
					await task.say("text", `Context compaction completed (${durationSec}s). Continued within active context window.`)
					break
				}

				case "thread.created": {
					const agentName = event.agentInfo?.name ?? "Subagent"
					await task.say("text", `TrueForge subagent thread created: "${event.title}" (${agentName})`)
					break
				}

				case "turn.done": {
					if (event.state.status === "error") {
						error = `TrueForge turn failed: ${event.state.message}`
					} else if (event.state.status === "cancelled") {
						await task.say("text", "TrueForge turn was cancelled.")
					}

					break
				}

				default:
					break
			}
		}
	} catch (streamError) {
		if (!task.abort) {
			error = `TrueForge request failed: ${errorMessage(streamError)}`
		}
	}

	return { sawError: error !== undefined, errorMessage: error }
}

async function withRetrievedContext(task: Task, text: string): Promise<string> {
	const config = getTrueForgeConfig()

	try {
		const retrieval = await selectContextFiles(task.cwd, text, config.contextBudgetChars)

		if (retrieval.files.length === 0) {
			return text
		}

		const summary = retrieval.files
			.map((file) => `- ${file.path} (${file.reason})`)
			.slice(0, 12)
			.join("\n")

		await task.say(
			"text",
			`Context: selected ${retrieval.files.length} file(s), ${retrieval.totalChars}/${retrieval.budgetChars} characters.\n${summary}`,
		)

		return `${text}\n\n${renderContext(retrieval)}`
	} catch {
		return text
	}
}

export async function runTrueForgeTask(task: Task, content: readonly unknown[]): Promise<void> {
	const { text, files } = extractContent(content)
	const service = TrueForgeService.instance
	const config = getTrueForgeConfig()
	const models = [config.model, ...config.fallbackModels.filter((model) => model !== config.model)]

	let modelIndex = 0
	let nextText = text || "Continue."
	let nextFiles = files

	while (!task.abort) {
		const turnText = await withRetrievedContext(task, nextText)
		let result: TurnResult | undefined
		let lastError: string | undefined

		while (modelIndex < models.length && !task.abort) {
			const currentModel = models[modelIndex]
			try {
				await service.getOrCreateTaskSession(task.taskId, task.cwd, currentModel)
			} catch (sessionError) {
				lastError = errorMessage(sessionError)
				await service.releaseTask(task.taskId)
				modelIndex++
				if (modelIndex < models.length) {
					await task.say(
						"text",
						`Model ${currentModel} failed (${lastError ?? "unknown error"}). Retrying with fallback model ${models[modelIndex]}...`,
					)
				}
				continue
			}

			result = await streamOneTurn(task, turnText, nextFiles)

			if (!result.sawError) {
				break
			}

			lastError = result.errorMessage
			await service.releaseTask(task.taskId)
			modelIndex++

			if (modelIndex < models.length) {
				await task.say(
					"text",
					`Model ${currentModel} failed (${lastError ?? "unknown error"}). Retrying with fallback model ${models[modelIndex]}...`,
				)
			}
		}

		if (task.abort) {
			break
		}

		if (!result || result.sawError) {
			await service.releaseTask(task.taskId)
			await task.say(
				"error",
				`TrueForge request failed${lastError ? `: ${lastError}` : ""}. The workspace was not modified. Make sure TrueForge is running and a model provider is configured.`,
			)
			break
		}

		let response: Awaited<ReturnType<Task["ask"]>>

		try {
			response = await task.ask(
				"completion_result",
				"Task complete. Send a follow-up message to continue, or start a new task.",
			)
		} catch {
			break
		}

		if (response.response !== "messageResponse") {
			break
		}

		const followUp = (response.text ?? "").trim()
		const followUpImages = imageFiles(response.images ?? [])

		if (!followUp && followUpImages.length === 0) {
			break
		}

		nextText = followUp || "Continue."
		nextFiles = followUpImages
	}

	await service.releaseTask(task.taskId)
}
