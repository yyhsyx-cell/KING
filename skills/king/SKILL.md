---
name: king
description: Use only when the user explicitly selects KING. KING is a paid text alias whose exact internal expansion is the installed OpenAI Computer Use and Chrome plugin mentions; it adds no capability of its own.
---

# KING

Use KING only as a paid text alias. Keep the user's visible invocation as KING.

## Exact text expansion

Only after the dependency and license checks in **Start** succeed, treat KING
as though the user supplied exactly these two lines, in this order:

```text
[@电脑](plugin://computer-use@openai-bundled)
[@chrome](plugin://chrome@openai-bundled)
```

These two literal lines are KING's entire capability payload. Do not add,
remove, rename, translate, paraphrase, or replace either line. Do not echo the
hidden expansion into the conversation unless the user asks to inspect or
diagnose KING. KING adds no browser, desktop, routing, prompt-enhancement, or
other functional layer of its own.

## Start

Use `sh scripts/king-license` on macOS and `scripts\king-license.cmd` on
Windows for every helper command below. The macOS helper restores the bundled
native helpers' owner-only executable permission after a GitHub download.

1. Run the license helper with `dependencies --json` from this skill directory.
   Continue only when it reports `ready`.
2. Follow the dependency result:
   - If a dependency is missing:
     - Report only the missing item.
     - Ask the user for installation confirmation.
     - After confirmation, install it with the returned official command of
       the form `codex plugin add <plugin-id>`.
     - Ask the user to restart Codex and invoke KING again.
   - If a dependency is disabled, report only the disabled item and ask the
     user to enable it, restart Codex, and invoke KING again.
   - Do not imitate or silently replace a missing or disabled capability.
3. Run the platform-appropriate helper with `status --json` from this skill
   directory.
4. Follow the returned machine-readable status:
   - `active` or `offline_grace`: continue. Mention the offline warning only
     for `offline_grace`.
   - `activation_pending`: run `scripts/king-license poll --json`. If it is
     still pending, ask the user to finish the already-open activation page and
     invoke KING again.
   - `inactive`: immediately run
     `scripts/king-license activate --open --json` without asking for
     confirmation first. Do not merely print or describe the activation URL.
     After the secure activation page has opened, stop and tell the user to
     enter the code there and invoke KING again.
   - Any other state: stop and report only the returned safe message and action.
   Never request, accept, echo, or invent a redemption code in chat.
5. Apply the **Exact text expansion** above, then load and follow both original
   skills completely:
   - `computer-use:computer-use`
   - `chrome:control-chrome`

## Owner-only code issuing

- Never invent or validate redemption codes with model-generated randomness.
- When the owner asks to open or manage the authorization backend, run
  `sh scripts/king-license admin open --json` on macOS, or the equivalent
  `.cmd` command on Windows. Return only the safe completion message; never
  expose the one-time login URL or administrator token.
- Only issue codes through
  `sh scripts/king-license admin issue --plan <month|permanent> --count <N> --json`
  on macOS, or the equivalent `.cmd` command on Windows.
- Require the server-side administrator credential from the operating system's
  protected credential store.
- Save newly issued codes to the owner-only file created by the helper and
  return only its path and code count. Never print complete codes into the
  Codex conversation.

## Boundaries

- Do not copy, patch, wrap, or alter either OpenAI plugin.
- Do not add substitute browser or desktop-control behavior. All such behavior
  must come from the two original capabilities.
- Preserve every permission, confirmation, and safety rule from both plugins.
- Use KING as the user-facing name.
- Mention internal dependencies only for installation or diagnosis.
- Native tool traces may still identify Chrome or Computer Use. Never claim
  those internal traces can be hidden.
