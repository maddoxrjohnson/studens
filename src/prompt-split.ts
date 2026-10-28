/**
 * Marks where a teacher prompt turns from context that rarely changes to the changing request.
 * Only the local `teacherPromptOrder: "cache"` setting emits it. The Claude teacher sends the
 * first part as an appended system prompt, which Claude caches across requests; every other
 * backend gets the prompt as one text with the marker removed.
 */
export const PROMPT_SPLIT = "<<studens-prompt-split>>";

export function splitPrompt(prompt: string): { stable?: string; request: string } {
  const at = prompt.indexOf(PROMPT_SPLIT);
  if (at < 0) return { request: prompt };
  return {
    stable: prompt.slice(0, at).trimEnd(),
    request: prompt.slice(at + PROMPT_SPLIT.length).trimStart(),
  };
}

export function joinPrompt(prompt: string): string {
  return prompt.split(PROMPT_SPLIT).join("");
}
