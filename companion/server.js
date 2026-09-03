"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {spawnSync} = require("child_process");

const HOST = "127.0.0.1";
const PORT = Number(process.env.ANTINOTE_AI_NOTES_PORT || 48732);
const APP_HOME = process.env.ANTINOTE_AI_NOTES_HOME || path.join(os.homedir(), "Library", "Application Support", "Antinote AI Notes");
const CONFIG_PATH = path.join(APP_HOME, "config.json");
const KEYCHAIN_SERVICE = "Antinote AI Notes";

const PROVIDERS = {
  openai: {label: "OpenAI", model: "gpt-5-mini"},
  anthropic: {label: "Claude", model: "claude-sonnet-4-20250514"},
  gemini: {label: "Gemini", model: "gemini-2.5-flash"}
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

function outputLimit(content, length) {
  return {small: 1200, medium: 2800, large: 6000}[length] || 1200;
}

function formatForAntinote(value) {
  return String(value || "")
    .replace(/^```(?:markdown|md|text)?\s*$/gim, "")
    .replace(/^\s*[•●◦]\s+/gm, "- ")
    .replace(/^\s*[☐□]\s+/gm, "- [ ] ")
    .replace(/^\s*[☑■]\s+/gm, "- [x] ")
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
  const request = mode === "structure"
    ? "Organize the note into a logical structure. Preserve important facts, use concise headings and bullets only when useful, and remove repetition."
    : instruction;
  const size = {small: "Keep the result under 80 words.", medium: "Keep the result under 250 words.", large: "Keep the result under 700 words."}[length] || "Keep the result under 80 words.";
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

function providerError(provider, data, status) {
  const message = data && data.error && (data.error.message || data.error.status) || data && data.message;
  return PROVIDERS[provider].label + " request failed" + (message ? ": " + String(message).slice(0, 300) : " (HTTP " + status + ").");
}

function escapeHTML(value) { return String(value || "").replace(/[&<>\"]/g, function (c) { return {"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"}[c]; }); }

function page() {
  const config = loadConfig();
  const provider = validProvider(config.provider) ? config.provider : "openai";
  const keySaved = Boolean(readKey(provider));
  const options = Object.keys(PROVIDERS).map(function (name) { return "<option value='" + name + "'" + (name === provider ? " selected" : "") + ">" + PROVIDERS[name].label + "</option>"; }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Antinote AI Notes</title><style>
  :root{--paper:#f5f3ee;--ink:#171717;--note:#1a1a1a;--edge:#343434;--mint:#39eba6;--orange:#d93900;--grid:rgba(23,23,23,.055)}*{box-sizing:border-box}body{min-height:100vh;margin:0;color:var(--ink);font-family:"Avenir Next","Helvetica Neue",sans-serif;background-color:var(--paper);background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:28px 28px}main{width:min(920px,calc(100% - 40px));margin:auto;padding:clamp(40px,8vh,88px) 0}.masthead{display:flex;align-items:center;justify-content:space-between;margin-bottom:30px}.brand{display:flex;gap:12px;align-items:center;font-size:13px;font-weight:800;letter-spacing:.16em}.mark{width:38px;height:38px;border-radius:10px;background:var(--mint);position:relative;overflow:hidden}.mark:before{content:"";position:absolute;width:19px;height:19px;top:8px;left:8px;border:2px solid #dfffee;border-radius:50%}.mark:after{content:"";position:absolute;width:25px;height:25px;right:-2px;bottom:-4px;border:3px solid #dfffee;border-radius:7px;transform:rotate(45deg)}.pill{border:1px solid #bbb;border-radius:999px;padding:7px 10px 6px;font:700 11px/1 ui-monospace,monospace;letter-spacing:.08em}.intro{max-width:720px;margin-bottom:34px}h1{margin:0;font-size:clamp(43px,7vw,72px);line-height:.96;letter-spacing:-.065em}.lead{margin:18px 0 0;color:#5e5e59;font-size:clamp(18px,2.5vw,23px);letter-spacing:-.025em}code,.field input,.field select{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}code{color:var(--orange);font-weight:700}.note{position:relative;padding:30px clamp(25px,5vw,54px) 38px;overflow:hidden;color:#f7f7f4;background:var(--note);border:1px solid var(--edge);border-radius:22px;box-shadow:0 24px 70px rgba(23,23,23,.18)}.note:after{content:"";position:absolute;top:22px;right:7px;width:4px;height:76px;border-radius:99px;background:var(--orange)}.bar{display:flex;justify-content:space-between;padding-bottom:24px;border-bottom:1px solid #303030;color:#777;font:700 11px/1 ui-monospace,monospace;letter-spacing:.09em}.dots{color:var(--orange);letter-spacing:4px}.status{margin:28px 0 22px;color:var(--mint);font:650 20px/1.2 ui-monospace,monospace}.status i{display:inline-block;width:10px;height:10px;margin-right:10px;border-radius:50%;background:var(--mint);box-shadow:0 0 0 5px rgba(57,235,166,.11)}.field{margin-top:18px}.field label{display:block;margin-bottom:8px;color:#aaa;font:700 11px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}.field input,.field select{width:100%;height:48px;border:1px solid #3d3d3d;border-radius:9px;padding:0 13px;color:#eee;background:#222;font-size:14px}.field input:focus,.field select:focus{outline:2px solid var(--mint);outline-offset:1px}.field select{appearance:auto}.key-row{display:flex;gap:10px}.key-row input{flex:1}.button{margin-top:26px;min-height:46px;padding:0 19px;border:0;border-radius:9px;cursor:pointer;color:#10241d;background:var(--mint);font-size:15px;font-weight:800;box-shadow:inset 0 -2px rgba(0,0,0,.13)}.button:after{content:" ↗";font-size:17px}.hint{margin:18px 0 0;color:#888;font:600 12px/1.5 ui-monospace,monospace}.toast{display:none;margin-top:18px;padding:12px 14px;border-radius:9px;font:600 13px/1.45 ui-monospace,monospace}.toast.ok{display:block;color:var(--mint);background:rgba(57,235,166,.08);border:1px solid rgba(57,235,166,.28)}.toast.error{display:block;color:#ff8d70;background:rgba(217,57,0,.1);border:1px solid rgba(217,57,0,.3)}@media(max-width:620px){main{width:calc(100% - 24px);padding-top:24px}.pill{display:none}.note{padding:22px 20px 28px;border-radius:18px}.key-row{display:block}.button{width:100%}}</style></head><body><main><header class="masthead"><div class="brand"><span class="mark"></span><span>ANTINOTE / AI</span></div><span class="pill">LOCAL COMPANION</span></header><section class="intro"><h1>Think in notes.<br>Keep the good bits.</h1><p class="lead">Use <code>::ai_structure()</code> or <code>::ai(your instruction)</code> on the entire page.</p></section><section class="note"><div class="bar"><span>AI PROVIDER</span><span class="dots">●●●</span></div><div class="status"><i></i>${keySaved ? "Key saved. Ready to process." : "Add an API key to begin."}</div><form id="settings"><div class="field"><label for="provider">Provider</label><select id="provider" name="provider">${options}</select></div><div class="field"><label for="model">Model</label><input id="model" name="model" value="${escapeHTML(config.model || PROVIDERS[provider].model)}" required></div><div class="field"><label for="apiKey">API key ${keySaved ? "(leave blank to keep current key)" : ""}</label><div class="key-row"><input id="apiKey" name="apiKey" type="password" autocomplete="off" placeholder="Paste your API key"></div></div><button class="button" type="submit">Save settings</button><div id="toast" class="toast"></div><p class="hint">Your key is stored in macOS Keychain. Notes go only to the provider selected above. API usage is billed by that provider.</p></form></section></main><script>const form=document.getElementById('settings'),toast=document.getElementById('toast'),defaults=${JSON.stringify(Object.fromEntries(Object.entries(PROVIDERS).map(([k,v])=>[k,v.model])))};document.getElementById('provider').addEventListener('change',e=>{document.getElementById('model').value=defaults[e.target.value]});form.addEventListener('submit',async e=>{e.preventDefault();toast.className='toast';try{const r=await fetch('/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});const d=await r.json();if(!r.ok)throw new Error(d.error);toast.textContent=d.message;toast.className='toast ok';document.getElementById('apiKey').value=''}catch(err){toast.textContent=err.message||'Could not save settings.';toast.className='toast error'}})</script></body></html>`;
}

function readBody(request, limit) { return new Promise(function (resolve, reject) { let body = ""; request.on("data", function (chunk) { body += chunk; if (body.length > limit) { reject(new Error("Request is too large.")); request.destroy(); } }); request.on("end", function () { resolve(body); }); request.on("error", reject); }); }
function send(response, status, type, body) { response.writeHead(status, {"Content-Type": type, "Cache-Control": "no-store"}); response.end(body); }

async function handle(request, response) {
  const url = new URL(request.url, "http://" + HOST + ":" + PORT);
  try {
    if (request.method === "GET" && url.pathname === "/") return send(response, 200, "text/html; charset=utf-8", page());
    if (request.method === "POST" && url.pathname === "/settings") {
      const input = JSON.parse(await readBody(request, 64 * 1024));
      const provider = String(input.provider || "");
      const model = String(input.model || "").trim();
      if (!validProvider(provider)) throw new Error("Choose OpenAI, Claude, or Gemini.");
      if (!model || model.length > 120) throw new Error("Enter a valid model name.");
      const key = String(input.apiKey || "").trim();
      if (key) saveKey(provider, key);
      if (!key && !readKey(provider)) throw new Error("Paste an API key to continue.");
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
      const key = readKey(provider);
      if (!key) throw new Error("No " + PROVIDERS[provider].label + " API key is saved. Run ::ai_setup().");
      const length = ["small", "medium", "large"].indexOf(input.length) >= 0 ? input.length : "small";
      const output = await providerRequest(provider, key, config.model || PROVIDERS[provider].model, content, instructions(mode, instruction, length), length);
      return send(response, 200, "application/json", JSON.stringify({ok: true, output: formatForAntinote(output)}));
    }
    send(response, 404, "application/json", JSON.stringify({ok: false, error: "Not found."}));
  } catch (error) { send(response, 400, "application/json", JSON.stringify({ok: false, error: error.message || "Request failed."})); }
}

function start() { const server = http.createServer(handle); server.listen(PORT, HOST, function () { console.log("Antinote AI Notes running at http://" + HOST + ":" + PORT); }); return server; }
if (require.main === module) start();
module.exports = {PROVIDERS, loadConfig, saveConfig, validProvider, outputLimit, instructions, providerError, openAIOutput, providerRequest, handle, start};
