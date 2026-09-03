# Antinote AI Notes

Turn the current [Antinote](https://antinote.io/) page into a clean AI result using Apple Intelligence, Local AI, or your own OpenAI, Claude, or Gemini API key.

## Commands

- `::ai_structure()` reorganizes the whole note into clear, useful sections.
- `::ai(Convert this into meeting notes)` inserts a small result below the command.
- `::ai(Convert this into a detailed plan, large)` supports `small`, `medium`, or `large` output.
- `::ai_setup()` opens Apple Intelligence and API-provider settings.

AI output is instructed to be direct: no “Here is…”, “Based on…”, explanations, or other filler.

## Install

1. Download and extract the release ZIP.
2. Double-click `install.command`.
3. In Antinote, open **Settings > Extensions**, choose `~/Library/Application Support/Antinote/Extensions` as your custom extensions folder, then click **Reload Extensions**.
4. In **Settings > Privacy**, enable **Let extensions call their own APIs**.
5. Run `::ai_setup()` and select one of these options:
   - **Apple Intelligence** for Apple's on-device model when it is available.
   - **Local AI (Qwen)** to download a private model once (about 1.1 GB). It becomes the active provider automatically when the download finishes.
   - A cloud provider and API key.

If Antinote's official `::ai` command is already enabled, disable its **LLM** extension first so this custom command is unambiguous.

## Privacy

- The companion listens only on `127.0.0.1`.
- API keys are stored in macOS Keychain, never in the extension or config file.
- With Apple Intelligence selected, your note stays on the Mac and is sent to Apple's on-device model.
- With Local AI selected, Qwen runs entirely on the Mac. The one-time download comes from Hugging Face and the local runtime comes from llama.cpp.
- With a cloud provider selected, your note is sent only to the provider selected in `::ai_setup()`.
- The extension has no analytics, account, or hosted backend.

## Requirements

- macOS 26+ with Apple Intelligence enabled for the local Apple Intelligence option
- macOS 14+ for OpenAI, Claude, and Gemini
- Antinote 2.0+
- Node.js 18+
- Apple Intelligence enabled, or an API key from OpenAI, Anthropic, or Google AI
- A one-time internet connection for the Local AI download

## Development

Run `npm test` inside `companion/`.
