"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const server = require("./server");

test("only known providers are accepted", function () {
  assert.equal(server.validProvider("openai"), true);
  assert.equal(server.validProvider("anthropic"), true);
  assert.equal(server.validProvider("gemini"), true);
  assert.equal(server.validProvider("other"), false);
});

test("AI instructions demand direct output", function () {
  const prompt = server.instructions("custom", "Convert this into meeting notes");
  assert.match(prompt, /Return only the finished output/);
  assert.match(prompt, /Never add a preamble/);
  assert.match(prompt, /do not add headings, bullets/);
  assert.match(server.instructions("custom", "Summarize", "small"), /under 80 words/);
  assert.doesNotMatch(server.instructions("custom", "Improve this", "default"), /under 80 words/);
  assert.match(server.instructions("structure", ""), /use #, ##, or ###/);
  assert.match(server.instructions("structure", ""), /Never replace checklist markers/);
});

test("output limit scales safely", function () {
  assert.equal(server.outputLimit("short"), 8000);
  assert.equal(server.outputLimit("short", "large"), 6000);
});

test("OpenAI message output is extracted from the Responses API shape", function () {
  assert.equal(server.openAIOutput({output: [{content: [{type: "output_text", text: "Finished note"}]}]}), "Finished note");
});

test("provider errors identify the provider without exposing credentials", function () {
  assert.equal(server.providerError("openai", {error: {message: "Bad key"}}, 401), "OpenAI request failed: Bad key");
});
