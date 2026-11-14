import * as vscode from "vscode"

export interface TrueForgeConfig {
	baseUrl: string
	model: string
	inlineEditModel?: string
	fallbackModels: string[]
	agentName?: string
	instructions?: string
	mcpServerName: string
	mcpPort: number
	contextBudgetChars: number
	autoApproveCommands: boolean
}

export const DEFAULT_INSTRUCTIONS = `You are a coding agent operating inside a Visual Studio Code extension.

You have access to editor tools exposed through an MCP server. Use them to inspect the user's workspace and make changes:
- read_file / list_files / search_files to explore the codebase.
- write_file / replace_in_file to modify files. These tools show a diff in the editor and wait for the user to accept or reject the change. If a change is rejected, adapt your plan instead of repeating it.
- execute_command to run tests, builds, or other commands. Prefer non-interactive commands.
- get_diagnostics to check for compiler/linter errors.

Context: the extension may prepend a <retrieved-context> block with automatically selected files
and the keywords that matched. Treat it as a starting point and verify by reading files before editing.

For broad exploration or large search results, delegate to a sub-agent with create_sub_agent and ask
it to return only a concise summary with file references, instead of filling this context window.

When a request implies changes in several files, find every affected file yourself (search for
imports, call sites, docs, and tests). Do not ask the user to name the files.

Work incrementally, verify your changes, and explain what you did when you are finished.`

export function getTrueForgeConfig(): TrueForgeConfig {
	const config = vscode.workspace.getConfiguration("roo-cline.trueforge")

	return {
		baseUrl: (config.get<string>("baseUrl") || "http://localhost:8790").replace(/\/+$/, ""),
		model: config.get<string>("model") || "openai/gpt-4.1",
		inlineEditModel: config.get<string>("inlineEditModel") || undefined,
		fallbackModels: (config.get<string[]>("fallbackModels") ?? [])
			.map((model) => model.trim())
			.filter((model) => model.length > 0),
		agentName: config.get<string>("agentName") || undefined,
		instructions: config.get<string>("instructions") || undefined,
		mcpServerName: config.get<string>("mcpServerName") || "roo-code-editor",
		mcpPort: config.get<number>("mcpPort") || 8791,
		contextBudgetChars: config.get<number>("contextBudgetChars") || 60_000,
		autoApproveCommands: config.get<boolean>("autoApproveCommands") || false,
	}
}

