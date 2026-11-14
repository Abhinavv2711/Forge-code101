import * as vscode from "vscode"
import { TrueForge } from "@truefoundry/trueforge-sdk"

import { getTrueForgeConfig } from "./config"

export async function configureTrueForgeModelProvider(): Promise<void> {
	const config = getTrueForgeConfig()
	const baseUrl = await vscode.window.showInputBox({
		title: "TrueForge: OpenAI-compatible provider",
		prompt: "Base URL of the OpenAI-compatible API",
		value: "https://api.openai.com/v1",
		ignoreFocusOut: true,
	})

	if (!baseUrl) {
		return
	}

	const apiKey = await vscode.window.showInputBox({
		title: "TrueForge: OpenAI-compatible provider",
		prompt: "API key",
		password: true,
		ignoreFocusOut: true,
	})

	if (!apiKey) {
		return
	}

	const providerName = await vscode.window.showInputBox({
		title: "TrueForge: OpenAI-compatible provider",
		prompt: "Provider name",
		value: "custom-openai",
		ignoreFocusOut: true,
	})

	if (!providerName) {
		return
	}

	const modelId = await vscode.window.showInputBox({
		title: "TrueForge: OpenAI-compatible provider",
		prompt: "Model identifier sent to the provider",
		value: "gpt-4.1",
		ignoreFocusOut: true,
	})

	if (!modelId) {
		return
	}

	const resourceName = (value: string, fallback: string) => {
		const sanitized = value
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 63)

		return sanitized || fallback
	}

	const providerResource = resourceName(providerName, "custom-openai")
	const modelResource = resourceName(modelId, "model")
	const client = new TrueForge({ baseUrl: config.baseUrl, maxRetries: 0, timeoutInSeconds: 60 })

	try {
		await client.settings.modelProviders.createOrUpdate({
			manifest: {
				type: "custom",
				name: providerResource,
				baseUrl,
				auth: { apiKey },
				models: [{ name: modelResource, modelId, properties: {} }],
			},
		})

		const modelFqn = `${providerResource}/${modelResource}`
		await vscode.workspace
			.getConfiguration("roo-cline.trueforge")
			.update("model", modelFqn, vscode.ConfigurationTarget.Global)

		vscode.window.showInformationMessage(`TrueForge provider "${providerName}" configured. Using model ${modelFqn}.`)
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to configure the TrueForge model provider: ${(error as Error).message}`)
	}
}
