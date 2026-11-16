import type { MockModelRequest, MockModelResponse } from "eve/evals";

import { findScript } from "../../../support/protocol";

/** How eve's compaction prompt begins. The compaction call goes to the agent's own model. */
const COMPACTION_PROMPT = "You are performing a CONTEXT CHECKPOINT COMPACTION";

/** How eve's compaction transcript introduces each assistant message. */
const TRANSCRIPT_ASSISTANT = "\n### assistant\n";

/* The steps a compaction summary recorded as already taken for one script. */
const recordedProgress = (text: string, hex: string): number =>
  Math.max(
    0,
    ...[...text.matchAll(/PROGRESS:(?<taken>\d+):(?<hex>[0-9a-f]+)/gu)]
      .filter((match) => match.groups?.hex === hex)
      .map((match) => Number(match.groups?.taken))
  );

/**
 * Writes the summary for eve's compaction call, recording how far the running script got.
 *
 * @param transcript - The conversation as eve's compaction prompt renders it, with any earlier summary.
 * @returns A summary with a `PROGRESS:<steps taken>:<script>` marker, or a plain one when the transcript holds no script.
 * @remarks Compaction keeps the turn's scripted message and replaces the assistant messages after it with this summary, so the step count has to travel in the summary. A step that reports more input tokens than the model's context window triggers compaction, as the session usage test does.
 */
const summarize = (transcript: string): string => {
  const script = findScript(transcript);
  if (script === null) {
    return "Summary of a conversation with no script.";
  }
  const sinceScript = transcript.slice(transcript.lastIndexOf("SCRIPT:"));
  const taken =
    recordedProgress(transcript, script.hex) +
    sinceScript.split(TRANSCRIPT_ASSISTANT).length -
    1;
  return `Summary of a scripted conversation. PROGRESS:${taken}:${script.hex}`;
};

/**
 * Answers one model call from the script in the conversation's latest scripted message.
 *
 * @param request - The prompt as eve's mock model presents it.
 * @returns The script step for this model call. The step number is the count of assistant messages after the scripted message, plus any steps a compaction summary recorded, so a turn that pauses for an approval or a budget prompt continues its script when it resumes.
 * @remarks Searches inside message text, because channels wrap what a person wrote. A conversation with no script, or one whose script has run out, gets a fixed reply.
 */
export const respondFromScript = ({
  messages,
  toolResults,
  tools,
}: MockModelRequest): MockModelResponse => {
  if (messages[0]?.text.startsWith(COMPACTION_PROMPT)) {
    return { text: summarize(messages.at(-1)?.text ?? "") };
  }
  const scripted = messages.findLastIndex(
    (message) => message.role === "user" && findScript(message.text) !== null
  );
  const script = findScript(messages[scripted]?.text ?? "");
  if (script === null) {
    return { text: "No script in this conversation." };
  }
  const summarized = messages
    .slice(0, scripted)
    .filter((message) => message.role === "assistant")
    .map((message) => recordedProgress(message.text, script.hex));
  const taken =
    Math.max(0, ...summarized) +
    messages
      .slice(scripted + 1)
      .filter((message) => message.role === "assistant").length;
  const step = script.steps[taken];
  if (step === undefined) {
    return { text: "The script has no more steps." };
  }
  // Tests read this back as a ModelReport.
  const report = JSON.stringify({
    messages,
    toolResults: toolResults.map(({ isError, name, output }) => ({
      isError,
      name,
      output,
    })),
    tools: tools.map((tool) => tool.name),
  });
  const text = step.report ? report : step.text;
  return {
    ...(text !== undefined && { text }),
    ...(step.calls && { toolCalls: step.calls }),
    ...(step.usage && { usage: step.usage }),
    ...(text === undefined && !step.calls?.length && { text: "" }),
  };
};
