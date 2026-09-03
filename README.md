# Antinote AI Notes

Turn the current [Antinote](https://antinote.io/) page into a clean AI result using your own OpenAI, Claude, or Gemini API key.

## Commands

- `::ai_structure()` reorganizes the whole note into clear, useful sections.
- `::ai(Convert this into meeting notes)` inserts a small result below the command.
- `::ai(Convert this into a detailed plan, large)` supports `small`, `medium`, or `large` output.
- `::ai_setup()` opens provider, model, and API-key settings.

AI output is instructed to be direct: no “Here is…”, “Based on…”, explanations, or other filler.

## Install

1. Download and extract the release ZIP.
2. Double-click `install.command`.
3. In Antinote, open **Settings > Extensions**, choose `~/Library/Application Support/Antinote/Extensions` as your custom extensions folder, then click **Reload Extensions**.
4. In **Settings > Privacy**, enable **Let extensions call their own APIs**.
5. Run `::ai_setup()` and save an API key.

If Antinote's official `::ai` command is already enabled, disable its **LLM** extension first so this custom command is unambiguous.

## Privacy

- The companion listens only on `127.0.0.1`.
- API keys are stored in macOS Keychain, never in the extension or config file.
- Your note is sent only to the provider selected in `::ai_setup()`.
- The extension has no analytics, account, or hosted backend.

## Requirements

- macOS 14+
- Antinote 2.0+
- Node.js 18+
- An API key from OpenAI, Anthropic, or Google AI

## Development

Run `npm test` inside `companion/`.
