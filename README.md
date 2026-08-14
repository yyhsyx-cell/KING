# KING

KING is a paid, explicit Codex text-alias skill. After activation, selecting
the single visible **KING** entry internally expands to exactly these two
literal plugin mentions:

```text
[@电脑](plugin://computer-use@openai-bundled)
[@chrome](plugin://chrome@openai-bundled)
```

KING does not copy, replace, route, or add functionality to either original
OpenAI capability. Its complete capability payload is the two lines above.

## Install with Codex

Ask Codex:

```text
Use skill-installer to install skills/king from https://github.com/yyhsyx-cell/KING, then tell me to start a new Codex task.
```

After installation, start a new task and select **KING**. The message shows the
single KING skill entry. KING checks its license and, only when the license is
valid, contributes the exact two-line text expansion shown above. The original
plugins keep all of their own behavior, permissions, and safety rules.

The official `computer-use@openai-bundled` and
`chrome@openai-bundled` plugins must already be installed and enabled. KING
reports a missing dependency and asks before installing it.

## Activation

The first KING invocation opens the secure activation page at
`https://lmaigc.com`. Enter a valid monthly or permanent redemption code
there. Redemption codes never need to be pasted into a Codex conversation.

The owner can open the protected management console with
`sh scripts/king-license admin open --json`. The console generates and
downloads new codes and manages device resets and revocations without putting
the administrator token into Codex or the browser address.

- A monthly license lasts 30 days from its first successful redemption.
- A permanent license has no subscription expiration.
- Both periodically refresh revocation status and allow at most 72 hours of
  signed offline use.
- One code binds to one KING installation unless the administrator resets it.

## Supported systems

- macOS: secrets are stored in macOS Keychain.
- Windows: secrets are stored in Windows Credential Manager.

Availability of browser and desktop control remains governed by the original
OpenAI plugins and their permission rules.

## Important boundary

KING gates the KING shortcut only. A person who controls their computer can
modify a local skill, and the original OpenAI plugins remain directly callable.
KING is therefore not unbreakable DRM and must not be represented as such.

The published skill contains only its license client, public HTTPS origin, and
Ed25519 verification public key. Server signing keys, code pepper,
administrator tokens, database credentials, and redemption codes are not in
this repository.
