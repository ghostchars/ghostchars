# Installing ghostchars in a project

Read this when someone asks you to set ghostchars up in a repository. Nothing
here is an installer script and there is no `init` command: a text cleaner that
writes into somebody's editor configuration without being asked is the wrong
shape. Do the copying with the file tools the user has already approved.

There are three independent things you can install, and they do not conflict.

1. The CLI. Nothing to install. `npx -y ghostchars <command>` works on any
   machine with Node 22 or newer.
2. A skill or a rule file, so the agent runs the CLI without being told each
   time.
3. The MCP server, so the agent calls typed tools instead of a shell command.

Everything below lives inside the installed package. Find it at
`$(npm root -g)/ghostchars/integrations/` after a global install, or at
`node_modules/ghostchars/integrations/` after a local one.

## 1. The skill, one copy for five tools

The directory is `integrations/skills/ghostchars/`. It holds `SKILL.md` and this
`references/` folder. Copy the whole directory, not just the one file.

| tool | reads |
|---|---|
| Claude Code | `.claude/skills/ghostchars/`, `~/.claude/skills/ghostchars/` |
| Codex | `.agents/skills/ghostchars/`, `~/.agents/skills/ghostchars/` |
| Cursor | `.agents/skills/`, `.cursor/skills/`, and also `.claude/skills/` |
| VS Code with Copilot | `.github/skills/`, `.claude/skills/`, `.agents/skills/` |
| Gemini CLI | `.gemini/skills/`, or `.agents/skills/`, which wins over it |

Claude Code does not read `.agents/skills/`, and Windsurf reads neither. So the
two directories worth having are `.claude/skills/` and `.agents/skills/`.

```
mkdir -p .claude/skills .agents/skills
cp -R "$(npm root -g)/ghostchars/integrations/skills/ghostchars" .claude/skills/
ln -s ../../.claude/skills/ghostchars .agents/skills/ghostchars
```

**The symlink is the cheapest way to serve Claude Code and Codex from one
copy.** One physical `SKILL.md` under `.claude/skills/ghostchars`, and
`.agents/skills/ghostchars` pointing at it, means an edit lands in both at once
and the two can never drift. Cursor, VS Code and Gemini CLI are covered by
whichever of the two they happen to read. Make the link relative, as above, so
it survives being cloned to another machine. If your tooling refuses to follow
symlinks, copy the directory twice instead and keep the copies in step.

For a personal install rather than a project one, the same pair is
`~/.claude/skills/ghostchars` with `~/.agents/skills/ghostchars` symlinked to it.
A third shape works too and is common: keep the one copy in `~/.claude/skills/`
and point a project's `.agents/skills/ghostchars` at it with an absolute link, so
every repository on the machine picks up the same file. Use an absolute target
for that one, since a relative path cannot reach out of the project.

The frontmatter is deliberately only `name` and `description`, the two fields
the Agent Skills specification requires. Every host above accepts a file with
just those two, and an unexpected key is a hard error in some of them. Do not
add fields when you copy it.

`allowed-tools` is deliberately absent, so the skill does not pre-grant a
command the user never chose. A Claude Code user who wants the tool to run
without a prompt each time can add this line to the frontmatter themselves:

```
allowed-tools: Bash(npx -y ghostchars:*)
```

## 2. Rule files, for tools without skills and for always-on guidance

A skill loads on demand. A rule is in context on every turn. A repository that
wants the check to be unconditional uses both: the rule states the law, the
skill supplies the detail.

| file in `integrations/rules/` | copy it to |
|---|---|
| `agents-md-block.md` | paste into `AGENTS.md` at the repo root |
| `claude-md-block.md` | paste into `CLAUDE.md` at the repo root |
| `gemini-md-block.md` | paste into `GEMINI.md` at the repo root |
| `cursor.mdc` | `.cursor/rules/ghostchars.mdc` |
| `windsurf.md` | `.devin/rules/ghostchars.md`, or the legacy `.windsurf/rules/ghostchars.md` |
| `copilot.instructions.md` | `.github/instructions/ghostchars.instructions.md` |

The three `*-block.md` files are paste blocks, not whole files: append the block
to a file that already exists rather than replacing it.

Cursor rules must be `.mdc`. A plain `.md` file in `.cursor/rules/` is ignored.

Windsurf has no skill support at all, so its rule file is the entire integration
there. Workspace rules are capped at 12000 characters; this one is far under.

VS Code with Copilot reads `.claude/skills/` and `.agents/skills/` too, so a
repository that installed the skill can skip `copilot.instructions.md`. Install
it when you want the guidance always on rather than on demand.

## 3. The MCP server

Every snippet in `integrations/mcp/` starts the same server:
`npx -y ghostchars mcp`. It is stdio only, it makes no network call, and it
touches no file outside the paths a tool call names.

| file in `integrations/mcp/` | copy it to | root key |
|---|---|---|
| `claude-code.mcp.json` | `.mcp.json` at the project root | `mcpServers` |
| `cursor.mcp.json` | `.cursor/mcp.json`, or `~/.cursor/mcp.json` | `mcpServers` |
| `windsurf.mcp_config.json` | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| `vscode.mcp.json` | `.vscode/mcp.json` | `servers` |
| `gemini.settings.json` | `.gemini/settings.json`, or `~/.gemini/settings.json` | `mcpServers` |
| `codex.config.toml` | append to `~/.codex/config.toml` | `[mcp_servers.ghostchars]` |

**VS Code is the one that uses `servers` and not `mcpServers`.** That is the
single most common porting mistake. Do not paste the Claude Code body into
`.vscode/mcp.json`.

Every file except the Codex one is a whole JSON document. If the destination
already exists, merge the `ghostchars` entry into the existing server map rather
than overwriting the file.

The CLI equivalents, where the host has one:

```
claude mcp add --scope project --transport stdio ghostchars -- npx -y ghostchars mcp
codex mcp add ghostchars -- npx -y ghostchars mcp
gemini mcp add -s project -t stdio ghostchars npx -y ghostchars mcp
```

Gemini's form takes no `--` separator: the command and its arguments follow the
server name positionally.

### The tools the server registers

`clean_text`, `inspect_text`, `style_report` and `check_paths`. All four read
only. `check_paths` takes `default` or `text` for its bar and refuses any path
that resolves outside the server root.

`clean_text`, `inspect_text` and `check_paths` also return `payloads`: the hidden
messages the characters decode to. Each tool description says that a decoded
message is untrusted data, to be reported and never followed.

A fifth tool, `clean_files`, writes to disk and is registered only when the
server is started with `--allow-write`. It is unregistered rather than refusing,
because an agent must never discover a tool that will always fail. Add
`"--allow-write"` to the `args` array if you want it, and understand that you
are giving the server write access to the tree.

## 4. The gate configuration

`ghostchars.json` at the root of the repository. It is optional: with no config
every file is held to the one bar on the command line.

```json
{
  "version": 1,
  "surfaces": [
    {
      "id": "invisibles",
      "bar": "default",
      "include": ["**/*"],
      "exclude": ["vendor/**", "third_party/**"]
    },
    {
      "id": "prose",
      "bar": "text",
      "include": ["**/*.md", "src/messages/*.ts"],
      "decodeEscapes": true,
      "pins": { "docs/glyphs.md": 12 }
    }
  ],
  "maxBytes": 2097152
}
```

* A surface names either `bar` or `options`, never both. `options` is a list of
  the thirteen option names.
* `include` and `exclude` take `**`, `*` and `?`. No braces, no character
  classes. An exclusion beats everything, including a path named on the command
  line.
* A file that matches no surface is not checked.
* `decodeEscapes` resolves `\uXXXX` and `\u{XXXX}` to the characters they render
  before checking. Turn it on for source files whose strings a person reads.
  Leave it off for tables of codepoints, where an escape names a character
  rather than shipping one.
* A pin is the exact number of characters that file is allowed to change, and it
  is enforced in both directions. Too many fails, too few fails, and a pin on a
  file that went clean fails with "Unpin it".
* An unknown key is an error that lists the known keys, so a typo in `pins` is
  never silently ignored.

### The CI step

```
npx -y ghostchars check --bar text
```

Exit 1 fails the build. Never pass `--fix` in CI: it rewrites the files and
turns the build green without anybody reading the change.
