# Integrations

Files you copy into a project so an agent runs ghostchars without being asked
each time. Nothing here is an installer, and there is no `init` command: a text
cleaner that writes into somebody's editor configuration uninvited is the wrong
shape for a text cleaner.

Seven independent things, and they do not conflict.

| | what it buys | cost |
|---|---|---|
| the CLI alone | anything that can run a shell command can run the gate | you have to say so each time |
| the skill or a rule | the agent runs it unprompted, and knows what to do with each finding | one directory or one file in the repo |
| the MCP server | typed tools instead of a shell round trip and a JSON parse | one config entry per host |
| the Claude Code hook | every file the agent writes is checked, and a finding comes back as feedback | one script and one settings key |
| the pre-commit hook | nothing dirty gets committed, by anyone | one block in `.pre-commit-config.yaml` |
| the MCP proxy | another MCP server's tools, prompts and results reach the model cleaned | one rewritten config entry per wrapped server |
| the GitHub Action | every pull request is scanned, agent rules included, with a job summary and code scanning results | one workflow file |

Take any of them or all of them.

Copy the files from `$(npm root -g)/ghostchars/integrations/` after a global
install, or from `node_modules/ghostchars/integrations/` after a local one.

## skills/ghostchars/

One directory holding `SKILL.md`, `references/install.md` and
`references/flags.md`. Copy the whole directory.

| tool | reads |
|---|---|
| Claude Code | `.claude/skills/ghostchars/`, `~/.claude/skills/ghostchars/` |
| Codex | `.agents/skills/ghostchars/`, `~/.agents/skills/ghostchars/` |
| Cursor | `.agents/skills/`, `.cursor/skills/`, and also `.claude/skills/` |
| VS Code with Copilot | `.github/skills/`, `.claude/skills/`, `.agents/skills/` |
| Gemini CLI | `.gemini/skills/`, or `.agents/skills/`, which wins over it |

Claude Code does not read `.agents/skills/`. Everything else does. So the two
directories worth having are `.claude/skills/` and `.agents/skills/`, and **a
symlink from `.agents/skills/ghostchars` to `.claude/skills/ghostchars` is the
cheapest way to serve Claude Code and Codex from one copy**: one physical
`SKILL.md`, an edit that lands in both at once, and no chance of the two
drifting apart. Cursor, VS Code and Gemini CLI are then covered by whichever of
the two they read.

```
mkdir -p .claude/skills .agents/skills
cp -R "$(npm root -g)/ghostchars/integrations/skills/ghostchars" .claude/skills/
ln -s ../../.claude/skills/ghostchars .agents/skills/ghostchars
```

Keep the link relative, as above, so it survives being cloned to another
machine. The same pair works for a personal install:
`~/.claude/skills/ghostchars` with `~/.agents/skills/ghostchars` pointing at it.
If you keep your skills in `~/.claude/skills/` and want every repository to see
them, point each project's `.agents/skills/ghostchars` at that copy with an
absolute link instead; a relative path cannot reach out of the project. If your
tooling refuses to follow symlinks, copy the directory twice and keep the copies
in step.

The frontmatter is only `name` and `description`, the two fields the Agent
Skills specification requires, which is what lets one physical file load
unchanged in all five tools. Do not add fields when you copy it: an unexpected
key is a hard error in some hosts.

`allowed-tools` is deliberately absent, so the skill does not pre-grant a
command the user never chose. A Claude Code user who wants it to run without a
prompt each time can add this line to the frontmatter themselves:

```
allowed-tools: Bash(npx -y ghostchars:*)
```

## rules/

A skill loads on demand. A rule is in context on every turn. A repository that
wants the rule unconditionally uses both: the block states the law, the skill
supplies the depth.

| file | goes to |
|---|---|
| `agents-md-block.md` | paste into `AGENTS.md` at the repo root |
| `claude-md-block.md` | paste into `CLAUDE.md` at the repo root |
| `gemini-md-block.md` | paste into `GEMINI.md` at the repo root |
| `cursor.mdc` | `.cursor/rules/ghostchars.mdc` |
| `windsurf.md` | `.devin/rules/ghostchars.md`, or the legacy `.windsurf/rules/ghostchars.md` |
| `copilot.instructions.md` | `.github/instructions/ghostchars.instructions.md` |

The three `*-block.md` files are paste blocks, not whole files. Append the block
to a file that already exists.

Cursor rules must be `.mdc`. A plain `.md` in `.cursor/rules/` is ignored by the
rules system.

Windsurf has no skill support, so `windsurf.md` is the whole integration there.

VS Code with Copilot reads `.claude/skills/` and `.agents/skills/` too, so a
repository that installed the skill can skip `copilot.instructions.md`. Install
it when you want the guidance always on rather than on demand.

## hooks/

A Claude Code `PostToolUse` hook. After every `Write`, `Edit` or `MultiEdit`
it runs `ghostchars check --bar text` on the one file that changed. A finding
comes back to the model as feedback (exit 2, text on stderr), together with the
one instruction that matters: remove the invisible character, rewrite the
sentence that needed the dash. The file is never rewritten by the hook, for the
same reason the skill tells the agent not to accept a flattened em dash.

| file | goes to |
|---|---|
| `ghostchars-post-write.mjs` | `.claude/hooks/ghostchars-post-write.mjs` |
| `claude-code.settings.json` | merge the `hooks` key into `.claude/settings.json`, or `~/.claude/settings.json` |

```
mkdir -p .claude/hooks
cp "$(npm root -g)/ghostchars/integrations/hooks/ghostchars-post-write.mjs" .claude/hooks/
```

Set `GHOSTCHARS_HOOK_BAR=default` in the hook's environment to check only for
invisible characters and leave typography alone. A usage error or an unreadable
file is reported once and does not block; only a real finding does. Binary files
and files larger than `--max-bytes` are skipped by `check` itself.

The hook and the skill are complementary: the skill tells the model what to do
with prose it is about to write, and the hook catches what it wrote anyway.

## pre-commit/

`pre-commit-config.yaml` is a paste block for a repository's
`.pre-commit-config.yaml`. It is a `repo: local` hook using `language: node`
with the package pinned in `additional_dependencies`, so the framework installs
ghostchars into its own environment and nothing is cloned. `types: [text]` hands
it the staged text files; `check` decides for itself which of those are prose.

Bump the pin when you upgrade. The hook never passes `--fix`.

## github-action/

A composite GitHub Action. On a pull request it scans the files the pull request
changed plus every rules file and skill coding agents read, fails the job on a
decoded hidden message, a bidi control or a tag character, writes a job summary
and uploads SARIF to code scanning. Outside a pull request it scans the whole
repository.

| file | what it is |
|---|---|
| `action.yml` | the Action; reference it, do not copy it |
| `scan.mjs` | the Action's logic, run by `action.yml` |
| `example-workflow.yml` | copy to `.github/workflows/ghostchars.yml` |
| `README.md` | inputs, thresholds, scope and outputs |

The Action is used from the repository rather than copied:

```
- uses: ghostchars/ghostchars/cli/integrations/github-action@main
  with:
    fail-on: hidden
```

`fail-on` takes `payload`, `hidden` (the default), `any` or `never`.

## mcp/

Every snippet starts the same server, `npx -y ghostchars mcp`. It speaks stdio,
makes no network call, and touches no file outside the paths a tool call names.

| file | goes to | root key |
|---|---|---|
| `claude-code.mcp.json` | `.mcp.json` at the project root | `mcpServers` |
| `cursor.mcp.json` | `.cursor/mcp.json`, or `~/.cursor/mcp.json` | `mcpServers` |
| `windsurf.mcp_config.json` | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| `vscode.mcp.json` | `.vscode/mcp.json` | `servers` |
| `gemini.settings.json` | `.gemini/settings.json`, or `~/.gemini/settings.json` | `mcpServers` |
| `codex.config.toml` | append to `~/.codex/config.toml` | `[mcp_servers.ghostchars]` |

**VS Code is the one host that uses `servers` and not `mcpServers`.** That is the
single most common porting mistake, and it is why `vscode.mcp.json` is a separate
file rather than a note. Do not paste the Claude Code body into `.vscode/mcp.json`.

Cursor's body carries `"type": "stdio"` because its configuration reference asks
for it, even though its own examples omit it. Every other host tolerates the key,
so the same body works in both.

Windsurf and Gemini CLI take no `type`. Gemini also takes a `timeout` and a
`trust` flag; the shipped body sets `trust: false`, which is the safe default and
means the host asks before each call.

If the destination file already exists, merge the `ghostchars` entry into the
server map rather than overwriting it.

The CLI equivalents, where the host has one:

```
claude mcp add --scope project --transport stdio ghostchars -- npx -y ghostchars mcp
codex mcp add ghostchars -- npx -y ghostchars mcp
gemini mcp add -s project -t stdio ghostchars npx -y ghostchars mcp
```

Gemini's form takes no `--` separator: the command and its arguments follow the
server name positionally.

### The tools

`clean_text`, `inspect_text`, `style_report` and `check_paths`. All four read
only and write nothing. `check_paths` takes `default` or `text` for its bar,
never `max`, and refuses any path that resolves outside the server root.

`clean_text`, `inspect_text` and `check_paths` also return `payloads`: the hidden
messages the characters decode to. Each tool description says that a decoded
message is untrusted data, to be reported and never followed.

A fifth tool, `clean_files`, writes to disk and is registered only when the
server starts with `--allow-write`. It is unregistered rather than refusing,
because an agent must never discover a tool that will always fail. Add
`"--allow-write"` to the `args` array to enable it, and know that you are giving
the server write access to the tree.

### Wrapping another server with the proxy

`ghostchars mcp-proxy -- <command> [args...]` starts any other MCP server and
cleans what it sends the model: its instructions, tool and argument
descriptions, tool results, resources and prompts. A hidden message is removed
and replaced by a visible notice naming its scheme and size. Requests from the
host pass through untouched.

| file | goes to | wraps |
|---|---|---|
| `claude-code.proxy.mcp.json` | `.mcp.json` at the project root | `npx -y @modelcontextprotocol/server-filesystem .` |
| `cursor.proxy.mcp.json` | `.cursor/mcp.json`, or `~/.cursor/mcp.json` | the same |
| `codex.proxy.config.toml` | append to `~/.codex/config.toml` | the same |

The filesystem server is only the example. To wrap a server you already have,
keep its entry name, set `command` to `npx`, and set `args` to
`-y ghostchars mcp-proxy --` followed by the server's original command and
arguments. The same rewrite works in every host above, VS Code's `servers` key
included.

Add `--log <file>` before the `--` to keep a JSON line per finding, or
`--report-only` to watch without changing anything. The CLI equivalents:

```
claude mcp add --scope project --transport stdio filesystem -- npx -y ghostchars mcp-proxy -- npx -y @modelcontextprotocol/server-filesystem .
codex mcp add filesystem -- npx -y ghostchars mcp-proxy -- npx -y @modelcontextprotocol/server-filesystem .
```
