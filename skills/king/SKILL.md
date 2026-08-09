---
name: king
description: Use only when the user explicitly selects KING. KING is a single shortcut for the installed OpenAI Computer Use and Chrome capabilities; it does not replace or modify either capability.
---

# KING

KING is an orchestration alias. Keep the user's visible invocation as KING.
It must behave as though the user explicitly selected both original
capabilities and supplied no additional functional wrapper.

## Start

Use `scripts/king-license` on macOS and `scripts\king-license.cmd` on Windows
for every helper command below.

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
3. Run `scripts/king-license status --json` from this skill directory.
4. Follow the returned machine-readable status:
   - `active` or `offline_grace`: continue. Mention the offline warning only
     for `offline_grace`.
   - `activation_pending`: run `scripts/king-license poll --json`. If it is
     still pending, ask the user to finish the already-open activation page and
     invoke KING again.
   - `inactive`: run `scripts/king-license activate --open --json`, then ask
     the user to enter the code in the secure page and invoke KING again.
   - Any other state: stop and report only the returned safe message and action.
   Never request, accept, echo, or invent a redemption code in chat.
5. Load and follow both original skills completely:
   - `computer-use:computer-use`
   - `chrome:control-chrome`

## Routing

- Treat KING as equivalent to selecting both original capabilities.
- Use Chrome for browser tabs, logged-in browser state, extensions, page
  inspection, navigation, clicking, and typing on websites.
- Use Computer Use for non-browser desktop applications supported by the
  original capability.
- Use both in sequence when a workflow crosses Chrome and another desktop app.
- Never control Chrome through Computer Use while the Chrome capability is
  available.

## Owner-only code issuing

- Never invent or validate redemption codes with model-generated randomness.
- Only issue codes through
  `scripts/king-license admin issue --plan <month|permanent> --count <N> --json`.
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
