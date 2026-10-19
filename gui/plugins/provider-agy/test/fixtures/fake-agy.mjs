#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const MODELS = [
  "gemini-4-argon-medium\tGemini 4 Argon (Medium)",
  "gemini-4-argon-high\tGemini 4 Argon (High)",
  "gemini-4-argon-low\tGemini 4 Argon (Low)",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
].join("\n");

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write("9.9.9\n");
  process.exit(0);
}
if (argv[0] === "update") {
  process.stdout.write("Update successful, restart CLI to use\n");
  process.exit(0);
}
if (argv.length === 1 && argv[0] === "-p=/usage") {
  process.stdout.write(
    [
      "Gemini Models\tWeekly Limit Remaining\t100%\t2026-10-25T09:41:37Z",
      "Gemini Models\tFive Hour Limit Remaining\t99%\t2026-10-18T23:22:40Z",
      "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-21T22:54:08Z",
      "Claude and GPT models\tFive Hour Limit Remaining\t40%\t2026-10-18T23:57:04Z",
      "",
    ].join("\n"),
  );
  process.exit(0);
}
if (argv[0] === "models") {
  process.stdout.write(`Fetching available models...\n${MODELS}\n`);
  process.exit(0);
}

const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const logDir = join(process.cwd(), ".fake-agy");
mkdirSync(logDir, { recursive: true });
appendFileSync(join(logDir, "argv.ndjson"), `${JSON.stringify(argv)}\n`);

const model = flag("--model") ?? "gemini-3.8-flash";
if (model === "fail-to-start") {
  process.stderr.write("error: you are not signed in; run agy to sign in\n");
  process.exit(1);
}

const conversation = flag("--conversation") ?? randomUUID();
let stepIndex = 0;
let turns = 0;

const write = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const step = (fields) =>
  write({
    event: "step_update",
    step_update: { conversation_id: conversation, ...fields },
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const usage = {
  input_tokens: 100,
  output_tokens: 10,
  thinking_tokens: 5,
  cache_read_tokens: 0,
  total_tokens: 110,
};

write({
  event: "init",
  conversation_id: conversation,
  init: {
    model,
    cwd: process.cwd(),
    tools: ["view_file"],
    permission_mode: "request-review",
  },
});

async function turn(message) {
  const raw = message?.message?.content;
  const content =
    typeof raw === "string"
      ? raw
      : (raw ?? []).map((block) => block.text).join("");
  appendFileSync(
    join(logDir, "prompts.ndjson"),
    `${JSON.stringify(content)}\n`,
  );
  const request = content.includes("User request:\n")
    ? content.split("User request:\n").pop()
    : content;
  turns += 1;
  step({ step_index: stepIndex++, state: "DONE", step_type: "user_input" });

  if (request.startsWith("fail")) {
    write({
      event: "result",
      result: {
        conversation_id: conversation,
        status: "ERROR",
        error: "boom",
        num_turns: turns,
        usage,
      },
    });
    return;
  }
  if (request.startsWith("denied")) {
    const index = stepIndex++;
    const info = {
      name: "run_command",
      parameters: { CommandLine: "uname -s" },
    };
    step({
      step_index: index,
      state: "ACTIVE",
      step_type: "tool",
      tool_info: info,
    });
    step({
      step_index: index,
      state: "DONE",
      step_type: "tool",
      tool_info: info,
    });
    write({
      event: "result",
      result: {
        conversation_id: conversation,
        status: "SUCCESS",
        response: "",
        num_turns: turns,
        usage,
      },
    });
    // Real agy prints this on stderr, which can arrive after the result.
    await sleep(20);
    process.stderr.write(
      'jetski: no output produced \u2014 a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)).\n',
    );
    return;
  }
  if (request.startsWith("tool")) {
    const index = stepIndex++;
    const info = {
      name: "view_file",
      parameters: { AbsolutePath: "/tmp/note.txt" },
    };
    step({
      step_index: index,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "view_file",
      tool_info: info,
    });
    step({
      step_index: index,
      state: "DONE",
      step_type: "tool",
      tool_name: "view_file",
      tool_info: { ...info, output: "2 lines, 27 bytes" },
    });
  }
  const index = stepIndex++;
  const reply = `echo: ${request}`;
  if (request.startsWith("slow")) {
    for (let part = 1; part <= 5; part += 1) {
      step({
        step_index: index,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: `part${part} `,
      });
      await sleep(150);
    }
  }
  step({
    step_index: index,
    state: "ACTIVE",
    step_type: "agent_response",
    text_delta: reply,
  });
  step({
    step_index: index,
    state: "DONE",
    step_type: "agent_response",
    text_delta: "\n",
    usage,
  });
  write({
    event: "result",
    result: {
      conversation_id: conversation,
      status: "SUCCESS",
      response: `${reply}\n`,
      num_turns: turns,
      usage,
    },
  });
}

let queue = Promise.resolve();
createInterface({ input: process.stdin })
  .on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    queue = queue.then(() => turn(message));
  })
  .on("close", () => {
    void queue.then(() => process.exit(0));
  });
