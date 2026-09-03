"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const {spawn, spawnSync} = require("child_process");

const HOST = "127.0.0.1";
const PORT = Number(process.env.ANTINOTE_AI_NOTES_PORT || 48732);
const APP_HOME = process.env.ANTINOTE_AI_NOTES_HOME || path.join(os.homedir(), "Library", "Application Support", "Antinote AI Notes");
const CONFIG_PATH = path.join(APP_HOME, "config.json");
const KEYCHAIN_SERVICE = "Antinote AI Notes";
const APPLE_INTELLIGENCE_PATH = path.join(APP_HOME, "apple-intelligence");
const LOCAL_HOME = path.join(APP_HOME, "local-ai");
const LOCAL_STATUS_PATH = path.join(LOCAL_HOME, "status.json");
const LOCAL_MODEL_PATH = path.join(LOCAL_HOME, "qwen2.5-1.5b-instruct-q4_k_m.gguf");
const LOCAL_RUNTIME_DIR = path.join(LOCAL_HOME, "runtime");
const LOCAL_RUNTIME_PATH = path.join(LOCAL_RUNTIME_DIR, "llama-server");
const LOCAL_PORT = Number(process.env.ANTINOTE_LOCAL_AI_PORT || 48733);
const LOCAL_MODEL_URL = "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf?download=true";
const LOCAL_MODEL_SHA256 = "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e";
const LOCAL_RUNTIME = {
  arm64: {url: "https://github.com/ggml-org/llama.cpp/releases/download/b10621/llama-b10621-bin-macos-arm64.tar.gz", sha256: "429c8270608600188035e5e92f7d78dffb7900904fe7dd7e6a84f48068cd13cf"},
  x64: {url: "https://github.com/ggml-org/llama.cpp/releases/download/b10621/llama-b10621-bin-macos-x64.tar.gz", sha256: "33c44e036e0e223f71a29fc74a0ab3e130ca9eadeb032ecc1c7af25985b8b91b"}
};

const PROVIDERS = {
  openai: {label: "OpenAI", model: "gpt-5-mini"},
  anthropic: {label: "Claude", model: "claude-sonnet-4-20250514"},
  gemini: {label: "Gemini", model: "gemini-2.5-flash"},
  apple_intelligence: {label: "Apple Intelligence", model: "On-device Apple model", local: true},
  local_llm: {label: "Local AI (Qwen)", model: "Qwen 2.5 1.5B", local: true}
};

function loadConfig() {
  try { return Object.assign({provider: "openai", model: PROVIDERS.openai.model}, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))); }
  catch (error) { return {provider: "openai", model: PROVIDERS.openai.model}; }
}

function saveConfig(config) {
  fs.mkdirSync(APP_HOME, {recursive: true, mode: 0o700});
  const temp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", {mode: 0o600});
  fs.renameSync(temp, CONFIG_PATH);
}

function validProvider(provider) { return Object.prototype.hasOwnProperty.call(PROVIDERS, provider); }

function readKey(provider) {
  const result = spawnSync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", provider, "-w"], {encoding: "utf8"});
  return result.status === 0 ? result.stdout.trim() : "";
}

function saveKey(provider, key) {
  const result = spawnSync("/usr/bin/security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", provider, "-w", key], {encoding: "utf8"});
  if (result.status !== 0) throw new Error("Could not save the API key to macOS Keychain.");
}

let localServer = null;
let localDownload = null;

function localStatus() {
  try { return JSON.parse(fs.readFileSync(LOCAL_STATUS_PATH, "utf8")); }
  catch (error) {
    return fs.existsSync(LOCAL_MODEL_PATH) && fs.existsSync(LOCAL_RUNTIME_PATH)
      ? {state: "ready", message: "Local AI is ready.", percent: 100}
      : {state: "not-installed", message: "Download Local AI to use it without an API key.", percent: 0};
  }
}

function saveLocalStatus(status) {
  fs.mkdirSync(LOCAL_HOME, {recursive: true, mode: 0o700});
  const next = Object.assign({percent: 0}, status);
  fs.writeFileSync(LOCAL_STATUS_PATH, JSON.stringify(next, null, 2) + "\n", {mode: 0o600});
  return next;
}

function sha256(file) {
  return new Promise(function (resolve, reject) {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(file);
    input.on("data", function (chunk) { hash.update(chunk); });
    input.on("end", function () { resolve(hash.digest("hex")); });
    input.on("error", reject);
  });
}

function writeChunk(stream, chunk) {
  return stream.write(chunk) ? Promise.resolve() : new Promise(function (resolve) { stream.once("drain", resolve); });
}

async function downloadFile(url, destination, expectedHash, phase, startPercent, endPercent) {
  const response = await fetch(url, {redirect: "follow", signal: AbortSignal.timeout(20 * 60 * 1000)});
  if (!response.ok || !response.body) throw new Error("Could not download " + phase + ".");
  const total = Number(response.headers.get("content-length")) || 0;
  const temporary = destination + ".download";
  const output = fs.createWriteStream(temporary, {mode: 0o600});
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      await writeChunk(output, next.value);
      const fraction = total ? received / total : 0;
      saveLocalStatus({state: "downloading", phase: phase, percent: Math.min(endPercent - 1, Math.round(startPercent + ((endPercent - startPercent) * fraction))), message: "Downloading " + phase + (total ? "..." : "")});
    }
  } finally {
    await new Promise(function (resolve) { output.end(resolve); });
  }
  const digest = await sha256(temporary);
  if (digest !== expectedHash) {
    fs.unlinkSync(temporary);
    throw new Error("The " + phase + " download failed its integrity check. Try again.");
  }
  fs.renameSync(temporary, destination);
}

async function installLocalAI() {
  if (localDownload) return localDownload;
  const runtime = LOCAL_RUNTIME[process.arch];
  if (!runtime) throw new Error("Local AI currently supports Apple Silicon and Intel Macs only.");
  localDownload = (async function () {
    try {
      fs.mkdirSync(LOCAL_HOME, {recursive: true, mode: 0o700});
      if (!fs.existsSync(LOCAL_RUNTIME_PATH)) {
        const archive = path.join(LOCAL_HOME, "llama-runtime.tar.gz");
        await downloadFile(runtime.url, archive, runtime.sha256, "Local AI engine", 0, 4);
        saveLocalStatus({state: "installing", phase: "Local AI engine", percent: 5, message: "Installing Local AI engine..."});
        const result = spawnSync("/usr/bin/tar", ["-xzf", archive, "-C", LOCAL_HOME], {encoding: "utf8"});
        if (result.status !== 0) throw new Error("Could not install the Local AI engine.");
        const extracted = fs.readdirSync(LOCAL_HOME, {withFileTypes: true}).find(function (entry) { return entry.isDirectory() && entry.name.indexOf("llama-b") === 0; });
        if (!extracted) throw new Error("The Local AI engine is missing its server.");
        fs.renameSync(path.join(LOCAL_HOME, extracted.name), LOCAL_RUNTIME_DIR);
        if (!fs.existsSync(LOCAL_RUNTIME_PATH)) throw new Error("The Local AI engine is missing its server.");
        fs.chmodSync(LOCAL_RUNTIME_PATH, 0o700);
        fs.unlinkSync(archive);
      }
      if (!fs.existsSync(LOCAL_MODEL_PATH)) await downloadFile(LOCAL_MODEL_URL, LOCAL_MODEL_PATH, LOCAL_MODEL_SHA256, "Qwen model (about 1.1 GB)", 5, 99);
      saveLocalStatus({state: "ready", phase: "", percent: 100, message: "Local AI is ready and selected."});
      saveConfig({provider: "local_llm", model: PROVIDERS.local_llm.model});
    } catch (error) {
      saveLocalStatus({state: "error", phase: "", percent: 0, message: error.message || "Local AI download failed."});
    } finally {
      localDownload = null;
    }
  })();
  return localDownload;
}

function removeLocalAI() {
  if (localDownload) throw new Error("Local AI is downloading. Wait for it to finish before removing it.");
  if (localServer && localServer.exitCode === null) localServer.kill("SIGTERM");
  localServer = null;
  fs.rmSync(LOCAL_HOME, {recursive: true, force: true});
  const config = loadConfig();
  if (config.provider === "local_llm") saveConfig({provider: "openai", model: PROVIDERS.openai.model});
  return {state: "not-installed", message: "Local AI was removed. Choose a provider to continue.", percent: 0};
}

async function localServerReady() {
  try { return (await fetch("http://" + HOST + ":" + LOCAL_PORT + "/health", {signal: AbortSignal.timeout(1000)})).ok; }
  catch (error) { return false; }
}

async function ensureLocalServer() {
  if (await localServerReady()) return;
  if (!fs.existsSync(LOCAL_MODEL_PATH) || !fs.existsSync(LOCAL_RUNTIME_PATH)) throw new Error("Local AI is not downloaded. Run ::ai_setup() to download it.");
  if (!localServer || localServer.exitCode !== null) {
    localServer = spawn(LOCAL_RUNTIME_PATH, ["-m", LOCAL_MODEL_PATH, "--host", HOST, "--port", String(LOCAL_PORT), "-c", "8192", "-ngl", "99"], {stdio: "ignore"});
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await localServerReady()) return;
    await new Promise(function (resolve) { setTimeout(resolve, 400); });
  }
  throw new Error("Local AI could not start. Try downloading it again from ::ai_setup().");
}

async function localLLMRequest(content, system, length) {
  await ensureLocalServer();
  const response = await fetch("http://" + HOST + ":" + LOCAL_PORT + "/v1/chat/completions", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({model: "local", messages: [{role: "system", content: system}, {role: "user", content: content}], temperature: 0.2, max_tokens: outputLimit(content, length)}),
    signal: AbortSignal.timeout(120000)
  });
  const data = await response.json().catch(function () { return {}; });
  const output = (((data.choices || [])[0] || {}).message || {}).content;
  if (!response.ok) throw new Error("Local AI request failed.");
  if (!output || !String(output).trim()) throw new Error("Local AI returned no text.");
  return String(output).trim();
}

function outputLimit(content, length) {
  return {small: 1200, medium: 2800, large: 6000}[length] || 8000;
}

function formatForAntinote(value, mode) {
  if (mode !== "structure") return String(value || "").trim();
  return String(value || "")
    .replace(/^```(?:markdown|md|text)?\s*$/gim, "")
    .replace(/^\s*[•●◦]\s+/gm, "- ")
    .replace(/^\s*[☐□]\s+/gm, "- [ ] ")
    .replace(/^\s*[☑■]\s+/gm, "- [x] ")
    .replace(/^(\s*)\[\s*\]\s+/gm, "$1- [ ] ")
    .replace(/^(\s*)\[\s*[xX✓]\s*\]\s+/gm, "$1- [x] ")
    .replace(/^\s*[-*]\s*\[\s*\]\s+/gm, "- [ ] ")
    .replace(/^\s*[-*]\s*\[\s*[xX✓]\s*\]\s+/gm, "- [x] ")
    .trim();
}

function openAIOutput(data) {
  if (data.output_text && data.output_text.trim()) return data.output_text;
  return (data.output || []).flatMap(function (item) {
    return (item.content || []).map(function (part) { return part.text || ""; });
  }).join("");
}

function instructions(mode, instruction, length) {
  if (mode === "custom") {
    const size = {small: " Keep the result under 80 words.", medium: " Keep the result under 250 words.", large: " Keep the result under 700 words."}[length] || "";
    return "You edit Antinote notes. Follow the user's instruction exactly, including its requested format. If the user asks for prose or a single improved sentence, return prose or a single sentence; do not add headings, bullets, numbering, checklists, or extra sections. Preserve the original meaning and tone unless asked otherwise." + size + " Return only the finished output. Never add a preamble, explanation, disclaimer, or meta-commentary. Do not say 'Here is', 'Based on', 'Sure', or similar.\n\nUser instruction:\n" + instruction;
  }
  const request = "Organize the note into a logical structure without summarizing or shortening it. Preserve all important details, improve titles and groupings, and remove only genuine repetition. Preserve every existing checklist item and checked state as - [ ] or - [x]. Never replace checklist markers with a bare 'list' keyword.";
  const size = {small: "Keep the result under 80 words.", medium: "Keep the result under 250 words.", large: "Keep the result under 700 words."}[length] || "Preserve the useful detail; do not shorten the note.";
  return "You edit Antinote notes. " + request + " " + size + " Return only the finished output. Never add a preamble, explanation, disclaimer, or meta-commentary. Do not say 'Here is', 'Based on', 'Sure', or similar. Format specifically for Antinote: use #, ##, or ### for concise headings; use - for bullets; use 1. for ordered steps; use - [ ] only for real actionable tasks. For nested lists, indent child lines with exactly two spaces and keep the same marker style. Never use tables, unicode bullets, checkbox symbols, HTML, or code fences unless explicitly requested. Be direct, crisp, and structured.";
}

async function providerRequest(provider, key, model, content, system, length) {
  const maxTokens = outputLimit(content, length);
  let url;
  let options;
  if (provider === "openai") {
    url = "https://api.openai.com/v1/responses";
    options = {headers: {"Authorization": "Bearer " + key, "Content-Type": "application/json"}, body: {model: model, instructions: system, input: content, max_output_tokens: maxTokens, reasoning: {effort: "minimal"}}};
  } else if (provider === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    options = {headers: {"x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"}, body: {model: model, max_tokens: maxTokens, system: system, messages: [{role: "user", content: content}]}};
  } else {
    url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
    options = {headers: {"x-goog-api-key": key, "Content-Type": "application/json"}, body: {system_instruction: {parts: [{text: system}]}, contents: [{role: "user", parts: [{text: content}]}], generationConfig: {maxOutputTokens: maxTokens, temperature: 0.3}}};
  }
  const response = await fetch(url, {method: "POST", headers: options.headers, body: JSON.stringify(options.body), signal: AbortSignal.timeout(120000)});
  const data = await response.json().catch(function () { return {}; });
  if (!response.ok) throw new Error(providerError(provider, data, response.status));
  const output = provider === "openai" ? openAIOutput(data)
    : provider === "anthropic" ? (data.content || []).map(function (item) { return item.text || ""; }).join("")
    : (((data.candidates || [])[0] || {}).content || {}).parts?.map(function (item) { return item.text || ""; }).join("");
  if (!output || !output.trim()) throw new Error("The provider returned no text.");
  return output.trim();
}

function appleIntelligenceRequest(content, system) {
  return new Promise(function (resolve, reject) {
    if (!fs.existsSync(APPLE_INTELLIGENCE_PATH)) {
      reject(new Error("Apple Intelligence support is not installed. Run the AI Notes installer again."));
      return;
    }
    const child = spawn(APPLE_INTELLIGENCE_PATH, [], {stdio: ["pipe", "pipe", "pipe"]});
    let output = "";
    let errors = "";
    const timer = setTimeout(function () { child.kill("SIGTERM"); reject(new Error("Apple Intelligence took too long. Try again.")); }, 120000);
    child.stdout.on("data", function (chunk) { output += chunk; });
    child.stderr.on("data", function (chunk) { errors += chunk; });
    child.on("error", function () { clearTimeout(timer); reject(new Error("Could not start Apple Intelligence.")); });
    child.on("close", function () {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (!result.ok) throw new Error(result.error || "Apple Intelligence could not process this note.");
        if (!result.output || !String(result.output).trim()) throw new Error("Apple Intelligence returned no text.");
        resolve(String(result.output).trim());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(errors || "Apple Intelligence returned an invalid response."));
      }
    });
    child.stdin.end(JSON.stringify({content: content, instructions: system}));
  });
}

function providerError(provider, data, status) {
  const message = data && data.error && (data.error.message || data.error.status) || data && data.message;
  return PROVIDERS[provider].label + " request failed" + (message ? ": " + String(message).slice(0, 300) : " (HTTP " + status + ").");
}

function escapeHTML(value) { return String(value || "").replace(/[&<>\"]/g, function (c) { return {"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"}[c]; }); }

function page() {
  const config = loadConfig();
  const provider = validProvider(config.provider) ? config.provider : "openai";
  const keySaved = PROVIDERS[provider].local || Boolean(readKey(provider));
  const options = Object.keys(PROVIDERS).map(function (name) { return "<option value='" + name + "'" + (name === provider ? " selected" : "") + ">" + PROVIDERS[name].label + "</option>"; }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Antinote AI Notes</title><style>
  :root{--paper:#f5f3ee;--ink:#171717;--note:#1a1a1a;--edge:#343434;--mint:#39eba6;--orange:#d93900;--grid:rgba(23,23,23,.055)}*{box-sizing:border-box}body{min-height:100vh;margin:0;color:var(--ink);font-family:"Avenir Next","Helvetica Neue",sans-serif;background-color:var(--paper);background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:28px 28px}main{width:min(920px,calc(100% - 40px));margin:auto;padding:clamp(40px,8vh,88px) 0}.masthead{display:flex;align-items:center;justify-content:space-between;margin-bottom:30px}.brand{display:flex;gap:12px;align-items:center;font-size:13px;font-weight:800;letter-spacing:.16em}.mark{width:38px;height:38px;border-radius:10px;background:var(--mint);position:relative;overflow:hidden}.mark:before{content:"";position:absolute;width:19px;height:19px;top:8px;left:8px;border:2px solid #dfffee;border-radius:50%}.mark:after{content:"";position:absolute;width:25px;height:25px;right:-2px;bottom:-4px;border:3px solid #dfffee;border-radius:7px;transform:rotate(45deg)}.pill{border:1px solid #bbb;border-radius:999px;padding:7px 10px 6px;font:700 11px/1 ui-monospace,monospace;letter-spacing:.08em}.intro{max-width:720px;margin-bottom:34px}h1{margin:0;font-size:clamp(43px,7vw,72px);line-height:.96;letter-spacing:-.065em}.lead{margin:18px 0 0;color:#5e5e59;font-size:clamp(18px,2.5vw,23px);letter-spacing:-.025em}code,.field input,.field select{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}code{color:var(--orange);font-weight:700}.note{position:relative;padding:30px clamp(25px,5vw,54px) 38px;overflow:hidden;color:#f7f7f4;background:var(--note);border:1px solid var(--edge);border-radius:22px;box-shadow:0 24px 70px rgba(23,23,23,.18)}.note:after{content:"";position:absolute;top:22px;right:7px;width:4px;height:76px;border-radius:99px;background:var(--orange)}.bar{display:flex;justify-content:space-between;padding-bottom:24px;border-bottom:1px solid #303030;color:#777;font:700 11px/1 ui-monospace,monospace;letter-spacing:.09em}.dots{color:var(--orange);letter-spacing:4px}.status{margin:28px 0 22px;color:var(--mint);font:650 20px/1.2 ui-monospace,monospace}.status i{display:inline-block;width:10px;height:10px;margin-right:10px;border-radius:50%;background:var(--mint);box-shadow:0 0 0 5px rgba(57,235,166,.11)}.field{margin-top:18px}.field label{display:block;margin-bottom:8px;color:#aaa;font:700 11px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}.field input,.field select{width:100%;height:48px;border:1px solid #3d3d3d;border-radius:9px;padding:0 13px;color:#eee;background:#222;font-size:14px}.field input:focus,.field select:focus{outline:2px solid var(--mint);outline-offset:1px}.field select{appearance:auto}.key-row{display:flex;gap:10px}.key-row input{flex:1}.button{margin-top:26px;min-height:46px;padding:0 19px;border:0;border-radius:9px;cursor:pointer;color:#10241d;background:var(--mint);font-size:15px;font-weight:800;box-shadow:inset 0 -2px rgba(0,0,0,.13)}.button:after{content:" ↗";font-size:17px}.hint{margin:18px 0 0;color:#888;font:600 12px/1.5 ui-monospace,monospace}.toast{display:none;margin-top:18px;padding:12px 14px;border-radius:9px;font:600 13px/1.45 ui-monospace,monospace}.toast.ok{display:block;color:var(--mint);background:rgba(57,235,166,.08);border:1px solid rgba(57,235,166,.28)}.toast.error{display:block;color:#ff8d70;background:rgba(217,57,0,.1);border:1px solid rgba(217,57,0,.3)}@media(max-width:620px){main{width:calc(100% - 24px);padding-top:24px}.pill{display:none}.note{padding:22px 20px 28px;border-radius:18px}.key-row{display:block}.button{width:100%}}</style></head><body><main><header class="masthead"><div class="brand"><span class="mark"></span><span>ANTINOTE / AI</span></div><span class="pill">LOCAL COMPANION</span></header><section class="intro"><h1>Think in notes.<br>Keep the good bits.</h1><p class="lead">Use <code>::ai_structure()</code> or <code>::ai(your instruction)</code> on the entire page.</p></section><section class="note"><div class="bar"><span>AI PROVIDER</span><span class="dots">●●●</span></div><div class="status"><i></i>${keySaved ? "Key saved. Ready to process." : "Add an API key to begin."}</div><form id="settings"><div class="field"><label for="provider">Provider</label><select id="provider" name="provider">${options}</select></div><div class="field"><label for="model">Model</label><input id="model" name="model" value="${escapeHTML(config.model || PROVIDERS[provider].model)}" required></div><div class="field"><label for="apiKey">API key ${keySaved ? "(leave blank to keep current key)" : ""}</label><div class="key-row"><input id="apiKey" name="apiKey" type="password" autocomplete="off" placeholder="Paste your API key"></div></div><button class="button" type="submit">Save settings</button><div id="toast" class="toast"></div><p class="hint">Your key is stored in macOS Keychain. Notes go only to the provider selected above. API usage is billed by that provider.</p></form></section></main><script>const form=document.getElementById('settings'),toast=document.getElementById('toast'),defaults=${JSON.stringify(Object.fromEntries(Object.entries(PROVIDERS).map(([k,v])=>[k,v.model])))};document.getElementById('provider').addEventListener('change',e=>{document.getElementById('model').value=defaults[e.target.value]});form.addEventListener('submit',async e=>{e.preventDefault();toast.className='toast';try{const r=await fetch('/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});const d=await r.json();if(!r.ok)throw new Error(d.error);toast.textContent=d.message;toast.className='toast ok';document.getElementById('apiKey').value=''}catch(err){toast.textContent=err.message||'Could not save settings.';toast.className='toast error'}})</script></body></html>`;
}

function pageWithProviderControls() {
  const script = `<style>.local-ai{margin-top:18px;padding:16px;border:1px solid #3d3d3d;border-radius:9px;background:#202020}.local-ai[hidden]{display:none}.local-ai h2{margin:0;color:#f7f7f4;font:800 16px/1.2 "Avenir Next",sans-serif}.local-ai p{margin:7px 0 0;color:#aaa;font:600 12px/1.5 ui-monospace,monospace}.local-progress{height:6px;margin-top:14px;overflow:hidden;border-radius:99px;background:#383838}.local-progress span{display:block;width:0;height:100%;border-radius:inherit;background:var(--mint);transition:width .25s ease}.local-action,.local-remove{margin-top:15px;min-height:38px;padding:0 14px;border:0;border-radius:8px;cursor:pointer;font:800 13px/1 "Avenir Next",sans-serif}.local-action{color:#10241d;background:var(--mint)}.local-remove{margin-left:8px;color:#ff9d88;background:transparent;border:1px solid #72392f}.local-action[disabled],.local-remove[disabled]{cursor:default;opacity:.65}.local-meta{margin-top:10px;color:#aaa;font:700 11px/1.4 ui-monospace,monospace}</style><script>(function(){const provider=document.getElementById('provider'),model=document.getElementById('model'),key=document.getElementById('apiKey'),status=document.querySelector('.status'),hint=document.querySelector('.hint'),local=document.createElement('section');let poller=null;local.className='local-ai';local.hidden=true;local.innerHTML='<h2>Local AI</h2><p>Qwen 2.5 1.5B runs entirely on this Mac. One-time download: about 1.1 GB.</p><div class="local-progress"><span></span></div><div class="local-meta">Checking local model...</div><button class="local-action" type="button">Download Local AI</button><button class="local-remove" type="button" hidden>Remove Local AI</button>';model.closest('.field').after(local);const bar=local.querySelector('.local-progress span'),meta=local.querySelector('.local-meta'),action=local.querySelector('.local-action'),remove=local.querySelector('.local-remove');function cloud(){status.innerHTML='<i></i>Save an API key to process notes.';hint.textContent='Your key is stored in macOS Keychain. Notes go only to the provider selected above. API usage is billed by that provider.'}function showLocalState(data){const state=data.state||'not-installed',percent=Number(data.percent)||0;bar.style.width=percent+'%';meta.textContent=data.message||'Local AI status unavailable.';remove.hidden=state!=='ready';if(state==='ready'){action.textContent='Local AI selected';action.disabled=true;status.innerHTML='<i></i>Local AI is ready. No API key is needed.';hint.textContent='Your notes stay on this Mac. Local AI starts automatically when you run a command.'}else if(state==='downloading'||state==='installing'){action.textContent='Downloading... '+percent+'%';action.disabled=true;status.innerHTML='<i></i>Preparing Local AI...'}else if(state==='error'){action.textContent='Try download again';action.disabled=false;status.innerHTML='<i></i>Local AI needs attention.'}else{action.textContent='Download Local AI';action.disabled=false;status.innerHTML='<i></i>Download a private, key-free model.'}}async function refresh(){try{const response=await fetch('/local/status');const data=await response.json();showLocalState(data.local||{})}catch(error){meta.textContent='Could not check Local AI status.'}}function poll(){clearInterval(poller);refresh();poller=setInterval(refresh,900)}function update(){const selected=provider.value,localProvider=selected==='apple_intelligence'||selected==='local_llm';model.closest('.field').hidden=localProvider;key.closest('.field').hidden=localProvider;local.hidden=selected!=='local_llm';if(selected==='local_llm'){poll()}else{clearInterval(poller);if(selected==='apple_intelligence'){status.innerHTML='<i></i>Apple Intelligence is selected. No API key is needed.';hint.textContent='Your note stays on this Mac and is processed by the Apple Intelligence model.'}else{cloud()}}}action.addEventListener('click',async()=>{action.disabled=true;try{await fetch('/local/download',{method:'POST'});poll()}catch(error){action.disabled=false;meta.textContent='Could not start download.'}});remove.addEventListener('click',async()=>{if(!confirm('Remove Local AI? This deletes the downloaded model and local runtime.'))return;remove.disabled=true;try{const response=await fetch('/local/delete',{method:'POST'});const data=await response.json();if(!data.ok)throw new Error();provider.value='openai';update()}catch(error){remove.disabled=false;meta.textContent='Could not remove Local AI.'}});provider.addEventListener('change',update);update()})()</script>`;
  return page().replace("</body>", script + "</body>");
}

function readBody(request, limit) { return new Promise(function (resolve, reject) { let body = ""; request.on("data", function (chunk) { body += chunk; if (body.length > limit) { reject(new Error("Request is too large.")); request.destroy(); } }); request.on("end", function () { resolve(body); }); request.on("error", reject); }); }
function send(response, status, type, body) { response.writeHead(status, {"Content-Type": type, "Cache-Control": "no-store"}); response.end(body); }

async function handle(request, response) {
  const url = new URL(request.url, "http://" + HOST + ":" + PORT);
  try {
    if (request.method === "GET" && url.pathname === "/") return send(response, 200, "text/html; charset=utf-8", pageWithProviderControls());
    if (request.method === "GET" && url.pathname === "/local/status") return send(response, 200, "application/json", JSON.stringify({ok: true, local: localStatus()}));
    if (request.method === "POST" && url.pathname === "/local/download") {
      const status = localStatus();
      if (status.state === "ready") return send(response, 200, "application/json", JSON.stringify({ok: true, local: status}));
      installLocalAI().catch(function () {});
      return send(response, 200, "application/json", JSON.stringify({ok: true, local: localStatus()}));
    }
    if (request.method === "POST" && url.pathname === "/local/delete") return send(response, 200, "application/json", JSON.stringify({ok: true, local: removeLocalAI()}));
    if (request.method === "POST" && url.pathname === "/settings") {
      const input = JSON.parse(await readBody(request, 64 * 1024));
      const provider = String(input.provider || "");
      const model = String(input.model || "").trim();
      if (!validProvider(provider)) throw new Error("Choose a valid provider.");
      if (!model || model.length > 120) throw new Error("Enter a valid model name.");
      const key = String(input.apiKey || "").trim();
      if (provider === "local_llm" && localStatus().state !== "ready") throw new Error("Download Local AI first.");
      if (!PROVIDERS[provider].local && key) saveKey(provider, key);
      if (!PROVIDERS[provider].local && !key && !readKey(provider)) throw new Error("Paste an API key to continue.");
      saveConfig({provider: provider, model: model});
      return send(response, 200, "application/json", JSON.stringify({ok: true, message: "Saved. " + PROVIDERS[provider].label + " is ready."}));
    }
    if (request.method === "POST" && url.pathname === "/process") {
      const input = JSON.parse(await readBody(request, 600000));
      const content = String(input.content || "").trim();
      const mode = input.mode === "structure" ? "structure" : "custom";
      const instruction = String(input.instruction || "").trim();
      if (!content) throw new Error("There is no note content to process.");
      if (mode === "custom" && !instruction) throw new Error("Add an instruction.");
      const config = loadConfig();
      const provider = validProvider(config.provider) ? config.provider : "openai";
      const length = ["small", "medium", "large"].indexOf(input.length) >= 0 ? input.length : "default";
      const system = instructions(mode, instruction, length);
      let output;
      if (provider === "apple_intelligence") {
        output = await appleIntelligenceRequest(content, system);
      } else if (provider === "local_llm") {
        output = await localLLMRequest(content, system, length);
      } else {
        const key = readKey(provider);
        if (!key) throw new Error("No " + PROVIDERS[provider].label + " API key is saved. Run ::ai_setup().");
        output = await providerRequest(provider, key, config.model || PROVIDERS[provider].model, content, system, length);
      }
      return send(response, 200, "application/json", JSON.stringify({ok: true, output: formatForAntinote(output, mode)}));
    }
    send(response, 404, "application/json", JSON.stringify({ok: false, error: "Not found."}));
  } catch (error) { send(response, 200, "application/json", JSON.stringify({ok: false, error: error.message || "Request failed."})); }
}

function start() { const server = http.createServer(handle); server.listen(PORT, HOST, function () { console.log("Antinote AI Notes running at http://" + HOST + ":" + PORT); }); return server; }
if (require.main === module) start();
module.exports = {PROVIDERS, loadConfig, saveConfig, validProvider, outputLimit, instructions, providerError, openAIOutput, providerRequest, appleIntelligenceRequest, localStatus, removeLocalAI, localLLMRequest, handle, start};
