# Sessions, export and privacy

## Sessions

Every interactive and headless run is saved as a session for its workspace, with a per-repository index so the list stays fast. `-c`/`--continue` resumes the latest session and `-r`/`--resume <id>` a specific one (unique prefixes work), in both headless and interactive mode. In the TUI, `/sessions` lists recent conversations, `/resume <n>` continues one and `/new` starts fresh.

`/clear` and `/compact` start a new session linked to the previous one, so the full transcript is never overwritten. Transcripts are stored owner-only (mode `0600`) in your config directory and kept forever by default. To delete old ones, set a retention in your user `config.json`:

```json
{ "sessions": { "retainDays": 90 } }
```

At startup Hesdor then deletes, in the background, the transcripts of every workspace not updated for that many days, with their index entries.

Long tool outputs spilled to `.hesdor/out/` are deleted after 7 days, when a session starts in that workspace.

Checkpoints let you go back within a session: see [permissions.md](permissions.md#checkpoints-and-rewind).

## Export and import

`hesdor export [<id>|--latest] --format md|html|json [-o file] [--redact]` writes a saved session as a transcript, a self-contained HTML page or raw JSON; `--redact` replaces likely secrets with `[REDACTED]`.

`hesdor import claude|codex [<path or id>]` converts a Claude Code or Codex session for this workspace into a Hesdor session you can resume with `hesdor -r <id>`. Source files are only read. Imported calls to tools Hesdor lacks become plain text, so the session can be resumed with any provider.

## Privacy

Hesdor has no telemetry. There is no hosted code execution: tools run on your machine, and prompts go only to the model provider you configure (and to role models you configure, see [roles.md](roles.md)).

Interactive runs check at most once a day for a newer release with a plain GET to `registry.npmjs.org`, send no identifying data, and show a notice on the next start. Turn it off with `HESDOR_NO_UPDATE_CHECK=1` or `"updateCheck": false`; it is always off in CI and headless runs. `hesdor upgrade` prints the upgrade command for your install method.
