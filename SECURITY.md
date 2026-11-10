# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

1. Open <https://github.com/ksjxixi-gif/Hesdor/security/advisories/new>.
2. Describe the problem, the Hesdor version (`hesdor --version`), your OS, and the steps to reproduce it.

You should get a reply within a week. Please allow time for a fix before publishing details.

Only the latest release gets security fixes.

## What counts

Hesdor runs a model that reads untrusted text: repository files, web pages and MCP output. The protections below are meant to hold even when that text tries to steer the model, so a way around any of them is a vulnerability:

- **Workspace trust:** project plugins, hooks, MCP servers or config running before you approve their exact content.
- **Path containment:** a file tool reading or writing outside the workspace, or writing inside `.git`.
- **Command policy and permission rules:** a command running without the approval the policy requires, a repository loosening your rules, or a deny rule being bypassed.
- **Modes:** a write or command in `plan` or `ask` mode.
- **Sandbox:** a sandboxed command writing outside the workspace or reaching the network when it is off.
- **Credentials:** provider keys or sign-in tokens reaching a child process, another origin, a log, or a repository.
- **`web_fetch`:** a request reaching a loopback, private or cloud-metadata address.

## What does not

- The model doing something harmful that you approved at a prompt, or that an allow rule you wrote permits.
- Anything that needs `--yes`, `--trust-workspace`, `--allow-home` or `--allow-root` to have been passed.
- Commands a sandbox would have contained, on a platform or setup where the sandbox is off. It is off by default and not available on Windows yet.

See [docs/permissions.md](docs/permissions.md) for how these protections work.
