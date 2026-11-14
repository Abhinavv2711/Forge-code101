import * as vscode from "vscode"
import { structuredPatch, type Hunk } from "diff"

export interface ReviewOutcome {
	status: "applied" | "rejected" | "cancelled"
	acceptedHunks: number
	totalHunks: number
	content: string
}

function hunkSide(hunk: Hunk, side: "original" | "proposed"): string {
	const lines: string[] = []

	for (const line of hunk.lines) {
		const marker = line[0]
		const value = line.slice(1)

		if (marker === "\\") {
			continue
		}

		if (marker === " " || (side === "original" && marker === "-") || (side === "proposed" && marker === "+")) {
			lines.push(value)
		}
	}

	return lines.join("\n")
}

export function computeHunks(original: string, proposed: string): Hunk[] {
	return structuredPatch("original", "proposed", original, proposed, "", "", { context: 1 }).hunks
}

export function buildAcceptedContent(original: string, hunks: Hunk[], accepted: boolean[]): string {
	const originalLines = original.length === 0 ? [] : original.split("\n")
	const result: string[] = []
	let cursor = 0

	hunks.forEach((hunk, index) => {
		const start = Math.max(0, hunk.oldStart - 1)

		while (cursor < start && cursor < originalLines.length) {
			result.push(originalLines[cursor++])
		}

		const originalSection = originalLines.slice(start, start + hunk.oldLines)

		if (accepted[index]) {
			for (const line of hunk.lines) {
				const marker = line[0]

				if (marker === " " || marker === "+") {
					result.push(line.slice(1))
				}
			}
		} else {
			result.push(...originalSection)
		}

		cursor = start + hunk.oldLines
	})

	while (cursor < originalLines.length) {
		result.push(originalLines[cursor++])
	}

	return result.join("\n")
}

async function openDiff(label: string, title: string, original: string, proposed: string): Promise<void> {
	const left = await vscode.workspace.openTextDocument({ content: original, language: "plaintext" })
	const right = await vscode.workspace.openTextDocument({ content: proposed, language: "plaintext" })
	await vscode.commands.executeCommand("vscode.diff", left.uri, right.uri, title)
}

export async function reviewHunks(label: string, original: string, proposed: string): Promise<ReviewOutcome> {
	const hunks = computeHunks(original, proposed)

	if (hunks.length === 0) {
		return { status: "rejected", acceptedHunks: 0, totalHunks: 0, content: original }
	}

	const accepted: boolean[] = hunks.map(() => false)

	for (let index = 0; index < hunks.length; index++) {
		const hunk = hunks[index]
		const title = `TrueForge: ${label} — hunk ${index + 1}/${hunks.length} (line ${hunk.oldStart})`

		await openDiff(label, title, hunkSide(hunk, "original"), hunkSide(hunk, "proposed"))

		const choice = await vscode.window.showWarningMessage(
			`${label}: accept hunk ${index + 1} of ${hunks.length} (line ${hunk.oldStart}, ${hunk.oldLines} old / ${hunk.newLines} new lines)?`,
			{ modal: true },
			"Accept Hunk",
			"Reject Hunk",
			"Stop Review",
		)

		if (choice === "Stop Review" || choice === undefined) {
			return {
				status: "cancelled",
				acceptedHunks: accepted.filter(Boolean).length,
				totalHunks: hunks.length,
				content: original,
			}
		}

		accepted[index] = choice === "Accept Hunk"
	}

	const acceptedHunks = accepted.filter(Boolean).length

	let content: string

	if (acceptedHunks === hunks.length) {
		content = proposed
	} else if (acceptedHunks === 0) {
		content = original
	} else {
		content = buildAcceptedContent(original, hunks, accepted)
	}

	return {
		status: acceptedHunks > 0 ? "applied" : "rejected",
		acceptedHunks,
		totalHunks: hunks.length,
		content,
	}
}

export async function applyWorkspaceContent(uri: vscode.Uri, content: string): Promise<boolean> {
	const document = await vscode.workspace.openTextDocument(uri)
	const edit = new vscode.WorkspaceEdit()
	const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length))
	edit.replace(uri, fullRange, content)

	if (!(await vscode.workspace.applyEdit(edit))) {
		return false
	}

	await document.save()
	return true
}

export async function createWorkspaceFile(uri: vscode.Uri, content: string): Promise<boolean> {
	const edit = new vscode.WorkspaceEdit()
	edit.createFile(uri, { ignoreIfExists: true })
	edit.insert(uri, new vscode.Position(0, 0), content)

	if (!(await vscode.workspace.applyEdit(edit))) {
		return false
	}

	const document = await vscode.workspace.openTextDocument(uri)
	await document.save()
	return true
}
