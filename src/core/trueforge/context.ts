import * as fs from "node:fs"
import * as path from "node:path"

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
	"docs",
	"doc",
	"site-packages",
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
	".lock",
	".map",
])

const STOPWORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "was", "were",
	"have", "has", "had", "not", "but", "add", "new", "use", "make", "should", "must", "can", "will",
	"when", "where", "what", "which", "how", "why", "all", "any", "each", "also", "then", "than",
	"please", "file", "files", "code", "update", "change", "changes", "there", "their", "them",
])

const MAX_CANDIDATES = 4000
const MAX_FILES = 12
const MAX_FILE_CHARS = 8000
const MAX_FILE_BYTES = 256 * 1024

export interface SelectedContextFile {
	path: string
	content: string
	reason: string
	score: number
}

export interface RetrievalResult {
	files: SelectedContextFile[]
	keywords: string[]
	totalChars: number
	budgetChars: number
}

export function queryKeywords(query: string): string[] {
	const keywords = new Set<string>()

	for (const raw of query.toLowerCase().split(/[^a-z0-9_]+/)) {
		if (raw.length < 3 || raw.length > 40 || STOPWORDS.has(raw)) {
			continue
		}

		keywords.add(raw)

		if (keywords.size >= 8) {
			break
		}
	}

	return [...keywords]
}

function isProbablyBinary(filePath: string): boolean {
	return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

async function listCandidates(root: string): Promise<string[]> {
	const files: string[] = []
	const stack = [root]

	while (stack.length > 0 && files.length < MAX_CANDIDATES) {
		const current = stack.pop()!

		let entries: fs.Dirent[]

		try {
			entries = await fs.promises.readdir(current, { withFileTypes: true })
		} catch {
			continue
		}

		for (const entry of entries) {
			if (files.length >= MAX_CANDIDATES) {
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

			if (isProbablyBinary(entryPath)) {
				continue
			}

			files.push(entryPath)
		}
	}

	return files
}

function scoreFile(relativePath: string, content: string, keywords: string[]): { score: number; matched: string[] } {
	const lowerPath = relativePath.toLowerCase()
	const lowerContent = content.toLowerCase()
	let score = 0
	const matched: string[] = []

	for (const keyword of keywords) {
		let keywordScore = 0

		if (lowerPath.includes(keyword)) {
			keywordScore += 12
		}

		const occurrences = lowerContent.split(keyword).length - 1

		if (occurrences > 0) {
			keywordScore += Math.min(occurrences, 5)
		}

		if (keywordScore > 0) {
			matched.push(keyword)
			score += keywordScore
		}
	}

	return { score, matched }
}

export async function selectContextFiles(
	workspaceRoot: string,
	query: string,
	budgetChars: number,
): Promise<RetrievalResult> {
	const keywords = queryKeywords(query)

	if (keywords.length === 0 || budgetChars <= 0) {
		return { files: [], keywords, totalChars: 0, budgetChars }
	}

	const candidates = await listCandidates(workspaceRoot)
	const scored: SelectedContextFile[] = []

	for (const absolutePath of candidates) {
		const relativePath = path.relative(workspaceRoot, absolutePath).split(path.sep).join("/")
		let content: string

		try {
			const stat = await fs.promises.stat(absolutePath)

			if (stat.size === 0 || stat.size > MAX_FILE_BYTES) {
				continue
			}

			content = await fs.promises.readFile(absolutePath, "utf8")
		} catch {
			continue
		}

		const { score, matched } = scoreFile(relativePath, content, keywords)

		if (score === 0) {
			continue
		}

		scored.push({
			path: relativePath,
			content,
			reason: `matched ${matched.slice(0, 4).join(", ")}`,
			score,
		})
	}

	scored.sort((a, b) => b.score - a.score)

	const files: SelectedContextFile[] = []
	let remaining = budgetChars

	for (const file of scored) {
		if (files.length >= MAX_FILES || remaining <= 0) {
			break
		}

		const limit = Math.min(MAX_FILE_CHARS, remaining)
		const content =
			file.content.length > limit ? `${file.content.slice(0, limit)}\n… (truncated to budget)` : file.content

		files.push({ ...file, content })
		remaining -= content.length
	}

	const totalChars = files.reduce((total, file) => total + file.content.length, 0)

	return { files, keywords, totalChars, budgetChars }
}

export function renderContext(result: RetrievalResult): string {
	if (result.files.length === 0) {
		return ""
	}

	const header = [
		`<retrieved-context>`,
		`Auto-selected ${result.files.length} file(s), ${result.totalChars} of ${result.budgetChars} character budget, keywords: ${result.keywords.join(", ")}.`,
	].join("\n")

	const body = result.files
		.map(
			(file) =>
				`<file path="${file.path}" reason="${file.reason}">\n${file.content}\n</file>`,
		)
		.join("\n\n")

	return `${header}\n\n${body}\n</retrieved-context>`
}
