# GitHub Action

A composite GitHub Action that runs `ghostchars check` on a pull request or a
whole repository. It fails the job on hidden messages and on the characters
behind prompt injection and Trojan Source attacks, writes a job summary, and
uploads its findings to code scanning as SARIF. The scan runs offline on the
runner. The only network traffic is installing the CLI from npm, fetching the
base commit of a pull request, and uploading the SARIF log to your repository.

The Action lives in a subdirectory of the repository, so the `uses:` line names
the path:

```
- uses: ghostchars/ghostchars/cli/integrations/github-action@main
```

Replace `main` with a full commit SHA to pin it. `example-workflow.yml` beside
this file is a complete workflow: copy it to `.github/workflows/ghostchars.yml`.

```
name: ghostchars

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ghostchars/ghostchars/cli/integrations/github-action@main
        with:
          fail-on: hidden
```

## Inputs

| input | default | what it does |
|---|---|---|
| `paths` | empty | Files or directories to scan, one per line. When empty, a pull request scans the files it changed and any other run scans the whole repository. |
| `fail-on` | `hidden` | What fails the job: `payload`, `hidden`, `any` or `never`. See the next section. |
| `sarif` | `true` | Upload the findings to code scanning. Needs `security-events: write`. |
| `version` | `1.1.0` | The `ghostchars` npm version to run. Hidden-message decoding needs 1.1.0 or later; see the next section. |

## Release requirement

Decoding hidden messages, and with it the `payload` threshold, needs
`ghostchars` 1.1.0 or later, which is what the `version` input defaults to.
Earlier releases, 1.0.2 included, lack the decoder, so only set `version` to one
of them on purpose. With a CLI that cannot decode, the job still runs: `check`
reports characters, `hidden` fails on bidi controls and tag characters only, and
a message hidden in zero-width or variation-selector characters does not fail
the job. The Action detects this when the report has findings, prints a warning
in the log, and shows a warning at the top of the job summary.

## What fails the job

`check` reports every character that fails the default bar. `fail-on` decides
which of those reports fail the job:

| value | fails on |
|---|---|
| `payload` | A decoded hidden message: characters that decode to text or a bit pattern someone embedded. |
| `hidden` | A decoded hidden message, a bidi control (override, embedding, isolate or mark away from right-to-left text) or a Unicode tag character. These are the prompt-injection and Trojan Source classes. |
| `any` | Anything `check` reports, exactly as `ghostchars check` would exit 1. |
| `never` | Nothing. The summary and the SARIF log still list every finding. |

With `hidden`, a stray zero-width space or no-break space is listed in the
summary and in code scanning, and does not fail the job. Use `any` to fail on
those too.

Hidden messages are decoded only in files that `check` already reports, the
same rule as `ghostchars check --json`. A message carried by visible typography
alone, such as a pattern of double spaces, is reported by `ghostchars inspect`
and not by the Action.

A pinned file in `ghostchars.json` that no longer matches its pin is listed
under Pins in the summary. It fails the job under `any`, and under `payload` or
`hidden` only when a hidden message decodes from it.

The job also fails, whatever `fail-on` says, when the CLI reports an error: a
file it could not read or a `ghostchars.json` it could not parse. The summary
shows the error.

## What gets scanned

On a pull request, the Action compares the checked-out tree with the base
commit and scans the text files that differ. It fetches the base commit itself
when the checkout is shallow, so the default `actions/checkout` settings work.
Binary files and files that are not UTF-8 are left out, the same way a
whole-repository scan leaves them out.

**The files coding agents read are scanned on every run,** whether the pull
request touched them or not. That covers everything tracked under `.agents`,
`.claude`, `.clinerules`, `.codex`, `.continue`, `.cursor`, `.devin`,
`.gemini`, `.github`, `.kiro`, `.roo` and `.windsurf` at any depth, and every
`AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`,
`.cursorrules`, `.windsurfrules` and `.goosehints`. A rule poisoned in an
earlier commit fails the next pull request.

Outside a pull request, or when more than 1000 files are in scope,
the whole repository is scanned with `git ls-files`, which includes the same
directories.

A `ghostchars.json` at the repository root applies as it does on the command
line: its surfaces set the bar for each path, and its pins hold.

## The job summary

The summary lists:

- The scope, the number of files scanned and skipped, and how many fail the job.
- Each hidden message with its file, line, column and scheme, and the decoded
  text in a fenced code block.
- Each character, with each unbroken run on one line folded into one row, its
  Unicode name and kind, and whether it fails the job.

A decoded message is untrusted text written by whoever hid it. The Action
escapes it before it reaches the summary: invisible and control characters are
written as `\u{XXXX}` escapes, line breaks as `\n`, and the code fence is always
longer than any run of backticks inside the message, so the message cannot
render as Markdown or HTML or close its own block.

## Code scanning

With `sarif: true` the Action uploads the same run as a SARIF 2.1.0 log with
`github/codeql-action/upload-sarif`, under the category `ghostchars`. Each
character is a result at its line and column, up to 20 per file, and each hidden
message is a `hidden-message` result. The upload runs after a failing scan too, so the
findings reach the pull request even when the job fails.

A pull request from a fork gets a read-only token, so the upload is skipped
there and the job summary is the report.

## Outputs

| output | value |
|---|---|
| `failed` | `true` when the job failed on findings or on an error |
| `files-scanned` | how many files were scanned |
| `files-failing` | how many files reach the `fail-on` threshold |
| `payloads` | how many hidden messages were decoded |
| `sarif-file` | the path of the SARIF log, empty when none was written |

## Requirements

The CLI needs Node 22 or newer. When the runner has an older Node, the Action
installs Node 24 with `actions/setup-node`. Linux, macOS and Windows runners
all work; the steps run in `bash`.

## How it works

`action.yml` installs the pinned CLI into the runner's temporary directory and
runs `scan.mjs`, a dependency-free Node script that holds all the logic:
choosing the files, running `ghostchars check --json` and `--sarif`, applying
`fail-on`, and writing the summary and the outputs. The package's own test
suite runs `scan.mjs` against fixture repositories, so the logic a runner
executes is the logic that is tested.
