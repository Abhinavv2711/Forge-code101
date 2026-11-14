# Roo Code + TrueForge

This fork replaces Roo Code's built-in agent loop with the **TrueForge** agent harness.
The extension no longer calls a model provider directly. Instead it:

1. Serves its editor actions as a local **MCP server** (`read_file`, `list_files`, `search_files`, `write_file`, `replace_in_file`, `execute_command`, `get_diagnostics`, `open_file`).
2. Registers that MCP server in TrueForge (`Settings -> Connectors`).
3. Creates a TrueForge session and streams turns (`POST /sessions/{id}/turns`).
4. Renders TrueForge streaming events (`model.message.delta`, `tool.response`, `turn.done`, ...) in the Roo Code webview.
5. Applies file writes/edits only after the user accepts a VS Code diff.

The model is configured **inside TrueForge**, not in the extension.

## Requirements

- Node.js `20.19.2` (newer versions work but print an engine warning) and `pnpm@10.8.1`.
- TrueForge running locally on `http://localhost:8790`.
- An OpenAI-compatible model provider configured in TrueForge.

## Start TrueForge

The extension's MCP server listens on `127.0.0.1`. TrueForge's outbound network policy blocks
loopback/private addresses by default, so allow that host when starting the harness.

PowerShell:

```powershell
$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'
npx @truefoundry/trueforge@latest
```

Bash:

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@latest
```

Alternatively set `NETWORK_POLICY_ENABLED=false` (disables the guard entirely) or allow the host in
TrueForge's `Settings` if your build exposes it. Without this, registering the editor MCP server fails
with `Outbound URL blocked for host "127.0.0.1"`.

> TrueForge binds IPv6 loopback (`::1`). In the extension, use `http://localhost:8790` as the base URL;
> `http://127.0.0.1:8790` is not reachable.

## Configure a model provider

Use the command palette (`Ctrl+Shift+P`) -> **TrueForge: Configure OpenAI-Compatible Provider**.

It asks for a base URL, API key, provider name, and model id, then calls
`POST /api/v1/settings/model-providers` and stores `<provider>/<model>` in
`roo-cline.trueforge.model`.

Example API call:

```bash
curl -X POST http://localhost:8790/api/v1/settings/model-providers \
  -H "content-type: application/json" \
  -d '{
    "manifest": {
      "type": "custom",
      "name": "custom-openai",
      "base_url": "https://api.openai.com/v1",
      "auth": { "api_key": "sk-..." },
      "models": [
        {
          "model_id": "gpt-4.1",
          "name": "gpt-4-1",
          "properties": { "context_length": 1047576, "max_output_tokens": 32768 }
        }
      ]
    }
  }'
```

Each model needs a `name` matching TrueForge's resource-name pattern (`^[a-z][a-z0-9-]{0,62}[a-z0-9]$`);
`model_id` is what gets sent to the provider. The model FQN is `<provider name>/<model name>`
(for example `custom-openai/gpt-4-1`), **not** `<provider>/<model_id>`. The provider setup command
derives a valid resource name automatically.

Verify the model is visible:

```bash
curl http://localhost:8790/api/v1/models
```

## Use it

- **Agent mode**: start a task in the Roo Code panel. The extension registers `roo-code-editor`
  with TrueForge, creates a session with tools preloaded, and streams the turn into the chat view.
  File writes and edits are reviewed **hunk by hunk**: each hunk opens a diff and asks for
  **Accept Hunk** / **Reject Hunk** / **Stop Review**. Accepted hunks are applied with a
  `WorkspaceEdit` and saved, so `Ctrl+Z` undoes the applied change. Commands ask for confirmation
  unless `roo-cline.trueforge.autoApproveCommands` is `true`.
- **Inline edit**: select code (or place the cursor) and press `Ctrl+Alt+I` / `Cmd+Alt+I`, or run
  **TrueForge: Inline Edit** from the command palette. The proposal is reviewed hunk by hunk as a
  diff before anything is applied.
- **Context assembly**: `@file` / `@symbol` mentions are resolved by Roo Code's existing mention
  pipeline and sent as text blocks. In addition, every turn runs keyword-based retrieval over the
  workspace (`src/core/trueforge/context.ts`): paths and contents are scored by query keywords, the
  best files are packed into `roo-cline.trueforge.contextBudgetChars` (default 60k characters,
  max 12 files, 8k per file), and the selection plus match reasons is shown in the chat and prepended
  to the turn as `<retrieved-context>`. The notes instruct the agent to verify the files and use
  `create_sub_agent` for broad exploration.
- **Cancellation**: the panel's cancel button calls `POST /sessions/{id}/cancel`. Streaming stops,
  the session is released, and no edit is applied without an explicit hunk acceptance.
- **Resilience**: when a turn or inline edit fails, the extension retries the next FQN in
  `roo-cline.trueforge.fallbackModels`. If every model fails, the error is shown without a stack
  trace and the workspace is unchanged (generation happens before any write).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `roo-cline.trueforge.baseUrl` | `http://localhost:8790` | TrueForge API base URL. |
| `roo-cline.trueforge.model` | `openai/gpt-4.1` | Model FQN `<provider>/<model name>` configured in TrueForge. |
| `roo-cline.trueforge.inlineEditModel` | _(empty)_ | Optional model FQN used for inline edits instead of `model` (agent model may lack tool calling). Inline-edit sessions disable TrueForge's built-in tools and generative UI so small code models return text, not tool calls. |
| `roo-cline.trueforge.fallbackModels` | `[]` | Model FQNs tried automatically when the primary model fails (inline agent only). |
| `roo-cline.trueforge.contextBudgetChars` | `60000` | Character budget for automatic file retrieval. |
| `roo-cline.trueforge.agentName` | _(empty)_ | Use a saved TrueForge agent instead of an inline spec. |
| `roo-cline.trueforge.instructions` | built-in | System instructions for the inline agent spec. |
| `roo-cline.trueforge.mcpServerName` | `roo-code-editor` | MCP server name registered in TrueForge. |
| `roo-cline.trueforge.mcpPort` | `8791` | Preferred port for the local MCP server (falls back by +20). |
| `roo-cline.trueforge.autoApproveCommands` | `false` | Run `execute_command` without a confirmation dialog. |

## Optional: named agent

Instead of the inline spec, create an agent once in TrueForge and set
`roo-cline.trueforge.agentName`. The extension still registers the MCP server and the agent must
reference it by name (`roo-code-editor`).

```json
{
  "name": "vscode-coder",
  "description": "Coding agent that edits a VS Code workspace through MCP tools.",
  "manifest": {
    "model": { "name": "custom-openai/gpt-4-1" },
    "config": { "generativeUi": { "enabled": false } },
    "instructions": "You are a coding agent inside VS Code. Use the roo-code-editor MCP tools to inspect and edit the workspace. Changes are reviewed by the user as diffs.",
    "mcpServers": [
      {
        "name": "roo-code-editor",
        "enableTools": ["@all"],
        "preload": true,
        "requireApprovalForTools": []
      }
    ]
  }
}
```

```bash
curl -X POST http://localhost:8790/api/v1/agents \
  -H "content-type: application/json" \
  --data-binary @agent.json
```

## Development

```bash
pnpm install
pnpm --filter roo-cline check-types
pnpm --filter roo-cline bundle
```

Run the extension from `.vscode/launch.json` (**Run Extension**) or:

```powershell
code --extensionDevelopmentPath="C:\Users\abhin\Desktop\iitb1\src" "C:\Users\abhin\Desktop\iitb1"
```

Integration code lives in `src/core/trueforge/`:

- `TrueForgeService.ts` - SDK client, MCP registration, session/turn lifecycle, fallback model sessions.
- `mcpServer.ts` - MCP tools, workspace path guard, hunk review, command execution.
- `review.ts` - jsdiff hunks -> per-hunk VS Code diff review -> `WorkspaceEdit` apply (undoable).
- `context.ts` - keyword retrieval with a character budget and visible match reasons.
- `loop.ts` - TrueForge event stream -> Roo Code webview messages, retrieval, model fallback.
- `inlineEdit.ts` - single-turn inline edit with per-hunk review.
- `providerSetup.ts` - OpenAI-compatible provider setup command.

## Fork point and attribution

This repository is a fork of [RooVetGit/Roo-Code](https://github.com/RooVetGit/Roo-Code) starting at
commit `b867ec914` ("Remove roocode.com web app (#12375)"). The upstream `LICENSE` is preserved.
Changed: `src/core/task/Task.ts` (`initiateTaskLoop` now delegates to TrueForge), `src/activate/registerCommands.ts`,
`src/package.json`, and the new `src/core/trueforge/` package. Everything else (webview, diff UI,
mention parsing, keybindings, provider plumbing) is upstream Roo Code.

Model/provider examples: `trueforge/model-provider.example.json` (no keys) and the agent definition
used for runs: `trueforge/agent.json`.

## Troubleshooting

- `Outbound URL blocked for host "127.0.0.1"` - restart TrueForge with
  `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`.
- `Unknown model "..." - provider not configured` - run the provider setup command and make sure
  `roo-cline.trueforge.model` matches `<provider>/<modelId>` from `GET /api/v1/models`.
- `fetch failed` when the extension starts a task - check `roo-cline.trueforge.baseUrl` and use
  `localhost`, not `127.0.0.1`.
- Tools are invisible to the model - keep `preload: true` on the MCP server entry in the agent spec
  (otherwise TrueForge defers discovery to `list_tools` / `get_tool_info`).
