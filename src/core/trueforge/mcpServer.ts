import * as http from "node:http"
import * as fs from "node:fs"
import * as path from "node:path"
import { spawn } from "node:child_process"

import * as vscode from "vscode"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"

import { getTrueForgeConfig } from "./config"
import { applyWorkspaceContent, createWorkspaceFile, reviewHunks } from "./review"

const SKIP_DIRECTORIES = new Set([
	"node_modules",
	".git",
	".hg",
	".svn",
	"dist",
	"build",
	"out",
	".next",
	".turbo",
	".cache",
	"coverage",
	"target",
	"vendor",
	"__pycache__",
	".venv",
	"venv",
	"venv-win",
])

const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".pdf",
	".zip",
	".gz",
	".tar",
	".7z",
	".exe",
	".dll",
	".so",
	".dylib",
	".woff",
	".woff2",
	".ttf",
	".mp3",
	".mp4",
	".mov",
	".wasm",
	".node",
])

const MAX_FILE_BYTES = 256 * 1024
const MAX_LIST_ENTRIES = 500
const MAX_SEARCH_RESULTS = 100

export interface McpServerHandle {
	url: string
	close: () => Promise<void>
}

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }] }
}

function errorText(value: string) {
	return { content: [{ type: "text" as const, text: value }], isError: true }
}

export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): string {
	const absolute = path.isAbsolute(requestedPath)
		? path.normalize(requestedPath)
		: path.resolve(workspaceRoot, requestedPath)
	const relative = path.relative(workspaceRoot, absolute)

	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Path "${requestedPath}" is outside of the workspace.`)
	}

	return absolute
}

function toRelative(workspaceRoot: string, absolutePath: string): string {
	return path.relative(workspaceRoot, absolutePath).split(path.sep).join("/")
}

function isProbablyBinary(filePath: string): boolean {
	return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath)
		return true
	} catch {
		return false
	}
}

async function walk(
	root: string,
	start: string,
	visitor: (filePath: string) => Promise<boolean | void> | boolean | void,
	limit: number,
): Promise<void> {
	let visited = 0
	const stack: string[] = [start]

	while (stack.length > 0 && visited < limit) {
		const current = stack.pop()!
		let entries: fs.Dirent[]

		try {
			entries = await fs.promises.readdir(current, { withFileTypes: true })
		} catch {
			continue
		}

		for (const entry of entries) {
			if (visited >= limit) {
				break
			}

			const entryPath = path.join(current, entry.name)

			if (entry.isDirectory()) {
				if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) {
					continue
				}

				stack.push(entryPath)
				continue
			}

			visited++
			const shouldStop = await visitor(entryPath)

			if (shouldStop) {
				return
			}
		}
	}
}

async function reviewAndWrite(
	workspaceRoot: string,
	absolutePath: string,
	proposedContent: string,
	label: string,
): Promise<string> {
	const exists = await pathExists(absolutePath)
	const original = exists ? await fs.promises.readFile(absolutePath, "utf8") : ""
	const relativePath = toRelative(workspaceRoot, absolutePath)
	const outcome = await reviewHunks(relativePath, original, proposedContent)

	if (outcome.status === "cancelled") {
		return `Review cancelled; "${relativePath}" was not changed.`
	}

	if (outcome.status === "rejected" || outcome.acceptedHunks === 0) {
		return `The user rejected all ${outcome.totalHunks} hunk(s) for "${relativePath}".`
	}

	await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true })

	const uri = vscode.Uri.file(absolutePath)
	const applied = exists
		? await applyWorkspaceContent(uri, outcome.content)
		: await createWorkspaceFile(uri, outcome.content)

	if (!applied) {
		return `Failed to apply the changes to "${relativePath}".`
	}

	return `${label} ${relativePath}: accepted ${outcome.acceptedHunks}/${outcome.totalHunks} hunk(s).`
}

async function runCommand(command: string, cwd: string, timeoutMs: number) {
	const config = getTrueForgeConfig()

	if (!config.autoApproveCommands) {
		const choice = await vscode.window.showWarningMessage(
			`TrueForge wants to run a command in ${path.basename(cwd)}:\n\n${command}`,
			{ modal: true },
			"Run",
			"Cancel",
		)

		if (choice !== "Run") {
			return { rejected: true as const }
		}
	}

	return new Promise<{ rejected: false; code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
		(resolve) => {
			const child = spawn(command, {
				cwd,
				shell: true,
				windowsHide: true,
				env: process.env,
			})

			let stdout = ""
			let stderr = ""
			let timedOut = false

			const timeout = setTimeout(() => {
				timedOut = true
				child.kill()
			}, timeoutMs)

			child.stdout?.on("data", (chunk) => {
				stdout += chunk.toString()
			})

			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString()
			})

			child.on("error", (error) => {
				clearTimeout(timeout)
				resolve({ rejected: false, code: null, stdout, stderr: `${stderr}${error.message}`, timedOut })
			})

			child.on("close", (code) => {
				clearTimeout(timeout)
				resolve({ rejected: false, code, stdout, stderr, timedOut })
			})
		},
	)
}

function registerTools(server: McpServer, workspaceRoot: string) {
	server.tool(
		"read_file",
		"Read a text file from the workspace. Returns the file content with optional line slicing.",
		{
			path: z.string().describe("Workspace-relative or absolute path to the file."),
			start_line: z.number().int().positive().optional().describe("1-based first line to return."),
			end_line: z.number().int().positive().optional().describe("1-based last line to return (inclusive)."),
		},
		async ({ path: requestedPath, start_line, end_line }) => {
			try {
				const absolutePath = resolveWorkspacePath(workspaceRoot, requestedPath)
				const stat = await fs.promises.stat(absolutePath)

				if (!stat.isFile()) {
					return errorText(`"${requestedPath}" is not a file.`)
				}

				if (stat.size > MAX_FILE_BYTES) {
					return errorText(
						`"${requestedPath}" is ${stat.size} bytes, which exceeds the ${MAX_FILE_BYTES} byte limit.`,
					)
				}

				const content = await fs.promises.readFile(absolutePath, "utf8")
				const lines = content.split(/\r?\n/)
				const from = Math.max(1, start_line ?? 1)
				const to = Math.min(lines.length, end_line ?? lines.length)

				if (from > to) {
					return errorText(`Invalid line range ${from}-${to} for a file with ${lines.length} lines.`)
				}

				const slice = lines.slice(from - 1, to)
				const numbered = slice.map((line, index) => `${from + index}: ${line}`).join("\n")

				return text(numbered)
			} catch (error) {
				return errorText(`Failed to read file: ${(error as Error).message}`)
			}
		},
	)

	server.tool(
		"list_files",
		"List files and directories in the workspace, skipping common build and dependency directories.",
		{
			path: z.string().optional().describe("Directory to list. Defaults to the workspace root."),
			recursive: z.boolean().optional().describe("Recurse into subdirectories. Defaults to false."),
		},
		async ({ path: requestedPath, recursive }) => {
			try {
				const absolutePath = resolveWorkspacePath(workspaceRoot, requestedPath ?? ".")
				const entries: string[] = []

				if (recursive) {
					await walk(
						workspaceRoot,
						absolutePath,
						(filePath) => {
							entries.push(toRelative(workspaceRoot, filePath))
							return entries.length >= MAX_LIST_ENTRIES
						},
						MAX_LIST_ENTRIES,
					)
				} else {
					const dirents = await fs.promises.readdir(absolutePath, { withFileTypes: true })
					for (const dirent of dirents.slice(0, MAX_LIST_ENTRIES)) {
						const suffix = dirent.isDirectory() ? "/" : ""
						entries.push(toRelative(workspaceRoot, path.join(absolutePath, dirent.name)) + suffix)
					}
				}

				return text(entries.length > 0 ? entries.join("\n") : "(no files)")
			} catch (error) {
				return errorText(`Failed to list files: ${(error as Error).message}`)
			}
		},
	)

	server.tool(
		"search_files",
		"Search workspace text files with a regular expression. Returns matching path:line: text entries.",
		{
			regex: z.string().describe("JavaScript regular expression to search for."),
			path: z.string().optional().describe("Directory to search. Defaults to the workspace root."),
			file_pattern: z.string().optional().describe("Optional substring that file paths must contain, e.g. .ts."),
			max_results: z.number().int().positive().optional().describe("Maximum number of matches (default 100)."),
		},
		async ({ regex, path: requestedPath, file_pattern, max_results }) => {
			try {
				const absolutePath = resolveWorkspacePath(workspaceRoot, requestedPath ?? ".")
				const pattern = new RegExp(regex)
				const results: string[] = []
				const limit = Math.min(max_results ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS)

				await walk(
					workspaceRoot,
					absolutePath,
					async (filePath) => {
						if (isProbablyBinary(filePath)) {
							return false
						}

						const relativePath = toRelative(workspaceRoot, filePath)

						if (file_pattern && !relativePath.includes(file_pattern)) {
							return false
						}

						let content: string

						try {
							const stat = await fs.promises.stat(filePath)

							if (stat.size > MAX_FILE_BYTES) {
								return false
							}

							content = await fs.promises.readFile(filePath, "utf8")
						} catch {
							return false
						}

						const lines = content.split(/\r?\n/)

						for (let index = 0; index < lines.length; index++) {
							if (pattern.test(lines[index])) {
								results.push(`${relativePath}:${index + 1}: ${lines[index].trim().slice(0, 300)}`)

								if (results.length >= limit) {
									return true
								}
							}
						}

						return false
					},
					Number.MAX_SAFE_INTEGER,
				)

				return text(results.length > 0 ? results.join("\n") : "(no matches)")
			} catch (error) {
				return errorText(`Failed to search files: ${(error as Error).message}`)
			}
		},
	)

	server.tool(
		"write_file",
		"Create or overwrite a file. The user is shown a diff and must accept the change before it is written.",
		{
			path: z.string().describe("Workspace-relative or absolute path to the file."),
			content: z.string().describe("Full new file content."),
		},
		async ({ path: requestedPath, content }) => {
			try {
				const absolutePath = resolveWorkspacePath(workspaceRoot, requestedPath)
				const label = (await pathExists(absolutePath)) ? "Updated" : "Created"
				return text(await reviewAndWrite(workspaceRoot, absolutePath, content, label))
			} catch (error) {
				return errorText(`Failed to write file: ${(error as Error).message}`)
			}
		},
	)

	server.tool(
		"replace_in_file",
		"Replace an exact string in a file. The user is shown a diff and must accept the change before it is written.",
		{
			path: z.string().describe("Workspace-relative or absolute path to the file."),
			old_text: z.string().describe("Exact text to replace."),
			new_text: z.string().describe("Replacement text."),
			replace_all: z.boolean().optional().describe("Replace every occurrence. Defaults to false."),
		},
		async ({ path: requestedPath, old_text, new_text, replace_all }) => {
			try {
				const absolutePath = resolveWorkspacePath(workspaceRoot, requestedPath)

				if (!(await pathExists(absolutePath))) {
					return errorText(`"${requestedPath}" does not exist. Use write_file to create it.`)
				}

				const original = await fs.promises.readFile(absolutePath, "utf8")
				const occurrences = original.split(old_text).length - 1

				if (occurrences === 0) {
					return errorText(`The text to replace was not found in "${requestedPath}".`)
				}

				if (occurrences > 1 && !replace_all) {
					return errorText(
						`The text occurs ${occurrences} times in "${requestedPath}". Provide more context or set replace_all.`,
					)
				}

				const updated = replace_all
					? original.split(old_text).join(new_text)
					: original.replace(old_text, new_text)

				return text(await reviewAndWrite(workspaceRoot, absolutePath, updated, "Edited"))
			} catch (error) {
				return errorText(`Failed to edit file: ${(error as Error).message}`)
			}
		},
	)

	server.tool(
		"execute_command",
		"Run a shell command in the workspace and return its exit code, stdout, and stderr. The user may be asked to approve.",
		{
			command: z.string().describe("Command line to run."),
			cwd: z.string().optional().describe("Working directory relative to the workspace root."),
			timeout_ms: z.number().int().positive().optional().describe("Timeout in milliseconds (default 60000)."),
		},
		async ({ command, cwd, timeout_ms }) => {
			try {
				const workingDirectory = resolveWorkspacePath(workspaceRoot, cwd ?? ".")
				const result = await runCommand(command, workingDirectory, timeout_ms ?? 60_000)

				if (result.rejected) {
					return text("The user rejected running this command.")
				}

				const sections = [
					`exit code: ${result.code ?? "unknown"}${result.timedOut ? " (timed out)" : ""}`,
					result.stdout ? `stdout:\n${result.stdout}` : "stdout: (empty)",
					result.stderr ? `stderr:\n${result.stderr}` : "stderr: (empty)",
				]

				return text(sections.join("\n\n"))
			} catch (error) {
				return errorText(`Failed to run command: ${(error as Error).message}`)
			}
		},
	)

	server.tool(
		"get_diagnostics",
		"Get compiler and linter diagnostics for the workspace or a single file.",
		{
			path: z.string().optional().describe("Limit diagnostics to this file."),
		},
		async ({ path: requestedPath }) => {
			try {
				const entries = requestedPath
					? [vscode.Uri.file(resolveWorkspacePath(workspaceRoot, requestedPath))]
					: vscode.workspace.textDocuments.map((document) => document.uri)

				const lines: string[] = []

				for (const uri of entries) {
					for (const diagnostic of vscode.languages.getDiagnostics(uri)) {
						const severity = vscode.DiagnosticSeverity[diagnostic.severity]
						lines.push(
							`${toRelative(workspaceRoot, uri.fsPath)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} [${severity}] ${diagnostic.message}`,
						)
					}
				}

				return text(lines.length > 0 ? lines.join("\n") : "(no diagnostics)")
			} catch (error) {
				return errorText(`Failed to get diagnostics: ${(error as Error).message}`)
			}
		},
	)

	server.tool(
		"open_file",
		"Open a file in the editor and optionally reveal a line.",
		{
			path: z.string().describe("Workspace-relative or absolute path to the file."),
			line: z.number().int().positive().optional().describe("1-based line to reveal."),
		},
		async ({ path: requestedPath, line }) => {
			try {
				const absolutePath = resolveWorkspacePath(workspaceRoot, requestedPath)
				const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath))
				const editor = await vscode.window.showTextDocument(document)

				if (line) {
					const position = new vscode.Position(Math.max(0, line - 1), 0)
					editor.selection = new vscode.Selection(position, position)
					editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter)
				}

				return text(`Opened ${toRelative(workspaceRoot, absolutePath)}.`)
			} catch (error) {
				return errorText(`Failed to open file: ${(error as Error).message}`)
			}
		},
	)
}

function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		let size = 0

		request.on("data", (chunk: Buffer) => {
			size += chunk.length

			if (size > 10 * 1024 * 1024) {
				reject(new Error("Request body too large"))
				request.destroy()
				return
			}

			chunks.push(chunk)
		})

		request.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
			} catch (error) {
				reject(error)
			}
		})

		request.on("error", reject)
	})
}

async function listen(server: http.Server, preferredPort: number): Promise<number> {
	for (let offset = 0; offset < 20; offset++) {
		const port = preferredPort + offset

		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: NodeJS.ErrnoException) => {
					server.off("listening", onListening)

					if (error.code === "EADDRINUSE") {
						resolve()
					} else {
						reject(error)
					}
				}

				const onListening = () => {
					server.off("error", onError)
					resolve()
				}

				server.once("error", onError)
				server.once("listening", onListening)
				server.listen(port, "127.0.0.1")
			})

			if (server.listening) {
				return port
			}
		} catch {
			// try the next port
		}
	}

	throw new Error("Unable to find a free port for the TrueForge MCP server.")
}

export async function startTrueForgeMcpServer(options: {
	workspaceRoot: string
	port: number
}): Promise<McpServerHandle> {
	const server = new McpServer({ name: "roo-code-editor", version: "1.0.0" })
	registerTools(server, options.workspaceRoot)

	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})

	await server.connect(transport)

	const httpServer = http.createServer(async (request, response) => {
		try {
			if (!request.url || !request.url.startsWith("/mcp")) {
				response.writeHead(404).end("Not found")
				return
			}

			if (request.method === "POST") {
				const body = await readJsonBody(request)
				await transport.handleRequest(request, response, body)
			} else {
				await transport.handleRequest(request, response)
			}
		} catch (error) {
			if (!response.headersSent) {
				response.writeHead(500, { "Content-Type": "application/json" })
			}

			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: { code: -32603, message: (error as Error).message },
					id: null,
				}),
			)
		}
	})

	const port = await listen(httpServer, options.port)

	return {
		url: `http://127.0.0.1:${port}/mcp`,
		close: async () => {
			await transport.close().catch(() => undefined)
			await server.close().catch(() => undefined)
			await new Promise<void>((resolve) => httpServer.close(() => resolve()))
		},
	}
}
