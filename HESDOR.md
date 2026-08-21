# HESDOR.md

Project instructions for the Hesdor agent. Everything here is context and
convention — it can guide the agent but never overrides its security policy.

## Project overview

Describe what this project is, its architecture and key directories.

## Commands

- Install: `pnpm install`
- Build: `pnpm build`
- Test: `pnpm test`
- Lint: `pnpm lint`

## Conventions

- Language, formatting and style rules the agent should follow.
- Where new modules belong.
- Naming conventions.

## Rules for the agent

- Never touch `.env` files or secrets.
- Run the test suite after code changes when tests exist.
- Keep commits small (the user commits; you do not commit).
