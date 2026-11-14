import * as path from "node:path"

import * as vscode from "vscode"

import { getTrueForgeConfig } from "./config"
import { reviewHunks } from "./review"
import { TrueForgeService } from "./TrueForgeService"

const INLINE_EDIT_INSTRUCTIONS = `You are an inline code editing assistant inside Visual Studio Code.

Given a file, an instruction, and optionally the selected code, produce the replacement code.
Rules:
- Return only the replacement code, without explanation and without Markdown code fences.
- Preserve the surrounding style, indentation, and language conventions.
- If the instruction only makes sense with the selected code, edit that selection.
- Do not include the rest of the file.
- Return exactly the edited selection: do not add imports, comments, or any code that the instruction does not require.
- Never call tools, never output JSON, and never explain your reasoning.`

function stripCodeFences(value: string): string {
	const trimmed = value.trim()
	const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
	return (match ? match[1] : trimmed).replace(/\r\n/g, "\n")
}

async function generateEdit(
	workspaceRoot: string,
	instructions: string,
	prompt: string,
	models: string[],
): Promise<{ text: string; model: string }> {
	let lastError: unknown

	for (const model of models) {
		try {
			const text = await TrueForgeService.instance.runSingleTurn(workspaceRoot, instructions, prompt, model)

			if (text.trim()) {
				return { text, model }
			}

			lastError = new Error(`Model ${model} returned an empty response.`)
		} catch (error) {
			lastError = error
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export async function runTrueForgeInlineEdit(): Promise<void> {
	const editor = vscode.window.activeTextEditor

	if (!editor) {
		vscode.window.showInformationMessage("TrueForge: open a file to use inline edit.")
		return
	}

	const document = editor.document
	const selection = editor.selection
	const selectedText = document.getText(selection)
	const instruction = await vscode.window.showInputBox({
		title: "TrueForge inline edit",
		prompt: selectedText ? "Describe how to change the selected code" : "Describe the code to insert at the cursor",
		placeHolder: "e.g. add error handling and a docstring",
		ignoreFocusOut: true,
	})

	if (!instruction?.trim()) {
		return
	}

	const workspaceRoot =
		vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(document.uri.fsPath)
	const relativePath = vscode.workspace.asRelativePath(document.uri)
	let scope: string
	let closing: string

	if (selectedText) {
		scope = `Selected code:\n\`\`\`${document.languageId}\n${selectedText}\n\`\`\``
		closing = "Return only the replacement code for the selected code."
	} else {
		const cursorLine = selection.active.line
		const startLine = Math.max(0, cursorLine - 40)
		const endLine = Math.min(document.lineCount - 1, cursorLine + 40)
		const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length)
		const windowText = document.getText(range)
		const context =
			windowText.length > 8_000 ? `${windowText.slice(0, 8_000)}\n… (context truncated)` : windowText

		scope = [
			`There is no selection. Produce the code that should be inserted at the cursor.`,
			`The cursor is at line ${cursorLine + 1}, column ${selection.active.character + 1}.`,
			`Code around the cursor (context only; never reproduce or describe it):\n\`\`\`${document.languageId}\n${context}\n\`\`\``,
		].join("\n\n")
		closing = "Return only the code to insert at the cursor."
	}

	const prompt = [
		`File: ${relativePath}`,
		`Language: ${document.languageId}`,
		`Instruction: ${instruction.trim()}`,
		scope,
		closing,
	].join("\n\n")

	const config = getTrueForgeConfig()
	const configured = [config.inlineEditModel ?? config.model, config.model, ...config.fallbackModels]
	const models = [...new Set(configured.map((model) => model.trim()).filter((model) => model.length > 0))]

	let generated: string

	try {
		generated = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "TrueForge: generating inline edit",
				cancellable: false,
			},
			async () => {
				const result = await generateEdit(workspaceRoot, INLINE_EDIT_INSTRUCTIONS, prompt, models)

				if (result.model !== models[0]) {
					vscode.window.showInformationMessage(
						`TrueForge: primary model failed, using fallback model ${result.model}.`,
					)
				}

				return result.text
			},
		)
	} catch (error) {
		vscode.window.showErrorMessage(
			`TrueForge inline edit failed: ${(error as Error).message}. The workspace was not modified.`,
		)
		return
	}

	const proposed = stripCodeFences(generated)

	if (!proposed) {
		vscode.window.showErrorMessage("TrueForge returned an empty edit. The workspace was not modified.")
		return
	}

	const outcome = await reviewHunks(relativePath, selectedText, proposed)

	if (outcome.status === "cancelled") {
		vscode.window.showInformationMessage("TrueForge inline edit cancelled. The workspace was not modified.")
		return
	}

	if (outcome.status === "rejected" || outcome.acceptedHunks === 0) {
		vscode.window.showInformationMessage("TrueForge inline edit rejected. The workspace was not modified.")
		return
	}

	const replacement = outcome.content

	const applied = await editor.edit((builder) => {
		if (selectedText) {
			builder.replace(selection, replacement)
		} else {
			builder.insert(selection.active, replacement)
		}
	})

	if (!applied) {
		vscode.window.showErrorMessage("TrueForge: failed to apply the edit.")
	}
}
