(function () {
  const extensionName = "ai_notes";
  const bridgeURL = "http://127.0.0.1:48732";

  const extensionRoot = new Extension({
    name: extensionName,
    version: "1.0.0",
    endpoints: [bridgeURL],
    requiredAPIKeys: [],
    author: "rajivpriyadarshi",
    category: "AI & ML",
    dataScope: "full",
    dependencies: []
  });

  function withoutCommand(text) {
    return String(text || "").split(/\r?\n/).filter(function (line) {
      return !/^\s*::ai(?:_structure|_setup)?(?:\([^)]*\))?\s*$/.test(line);
    }).join("\n").replace(/\n{3,}$/g, "\n\n");
  }

  function parseResult(result) {
    if (!result || !result.success) return {ok: false, error: "AI Notes is not running. Run the installer, then try again."};
    try { return JSON.parse(result.data); } catch (error) { return {ok: false, error: "AI Notes returned an invalid response."}; }
  }

  function processNote(payload, instruction, mode, length) {
    const content = withoutCommand(payload.fullText);
    if (!content.trim()) return new ReturnObject({status: "error", message: "There is no note content to process.", payload: content});

    const response = parseResult(callAPI("", bridgeURL + "/process", "POST", JSON.stringify({"Content-Type": "application/json"}), JSON.stringify({
      content: content,
      instruction: instruction,
      mode: mode,
      length: length || "small"
    })));
    if (!response.ok) return new ReturnObject({status: "error", message: response.error || "AI processing failed.", payload: content});
    if (typeof response.output !== "string" || !response.output.trim()) {
      return new ReturnObject({status: "error", message: "The AI provider returned no text. Try again.", payload: content});
    }
    return new ReturnObject({status: "success", message: "Note processed.", payload: mode === "custom" ? "\n// AI generated response\n\n" + response.output.trim() + "\n\n// AI output ends here" : response.output.trim()});
  }

  const ai = new Command({
    name: "ai",
    parameters: [
      new Parameter({type: "string", name: "prompt", helpText: "What should AI do with this entire note?", default: "", required: true}),
      new Parameter({type: "string", name: "length", helpText: "Optional response length: small, medium, or large.", default: "", required: false})
    ],
    type: "insert",
    helpText: "Add an AI result below this command without replacing the note.",
    tutorials: [new TutorialCommand({command: "ai(Convert this into meeting notes)", description: "Turn the note into meeting notes."})],
    extension: extensionRoot
  });
  ai.execute = function (payload) {
    const params = this.getParsedParams(payload);
    const prompt = String(params[0] || "").trim();
    const length = String(params[1] || "").trim().toLowerCase();
    if (!prompt) return new ReturnObject({status: "error", message: "Add an instruction, for example: ai(Convert this into meeting notes).", payload: payload.fullText || ""});
    if (length && ["small", "medium", "large"].indexOf(length) === -1) return new ReturnObject({status: "error", message: "Length must be small, medium, or large.", payload: payload.fullText || ""});
    return processNote(payload, prompt, "custom", length || "default");
  };

  const structure = new Command({
    name: "ai_structure",
    parameters: [],
    type: "replaceAll",
    helpText: "Organize the current note into a clear, concise structure.",
    tutorials: [new TutorialCommand({command: "ai_structure", description: "Structure the current note."})],
    extension: extensionRoot
  });
  structure.execute = function (payload) { return processNote(payload, "", "structure", "default"); };

  const setup = new Command({
    name: "ai_setup",
    parameters: [],
    type: "openURL",
    helpText: "Set your provider, model, and API key.",
    tutorials: [new TutorialCommand({command: "ai_setup", description: "Open AI Notes setup."})],
    extension: extensionRoot
  });
  setup.execute = function () { return new ReturnObject({status: "success", message: "Opening AI Notes settings.", payload: bridgeURL + "/"}); };
})();
