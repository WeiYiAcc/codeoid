/**
 * The daemon's background wake: when background work the agent started
 * finishes between turns, the daemon injects one turn carrying every task's
 * digest, sent as the `system:background` principal. It is a user-role message
 * (it rides the ordinary turn machinery), but it is not the owner speaking —
 * rendered as plain text under "you" it read as a wall of text from nowhere.
 *
 * Shape (session.ts #maybeDeliverBackgroundReports):
 *
 *   <background_tasks>
 *   (daemon-injected … NOT a message from the owner)
 *   - [completed] task ab12cd34: first line of the digest
 *     …more digest lines…
 *   - [failed] task ef56ab78: …
 *   </background_tasks>
 *
 *   Background work you started earlier has finished. …
 */


export const BACKGROUND_PRINCIPAL = "system:background";

export interface BackgroundWakeTask {
  status: string;
  taskId: string;
  /** First non-empty line of the digest — the row's one-line summary. */
  headline: string;
}

export function isBackgroundWake(msg: { role: string; identity: { sub: string } }): boolean {
  return msg.role === "user" && msg.identity.sub === BACKGROUND_PRINCIPAL;
}

const TASK_LINE = /^- \[([a-z]+)\] task (\S+?):\s?(.*)$/;

/** The tasks a wake reports, in order. Empty when the body is not the wake shape. */
export function parseBackgroundWake(content: string): BackgroundWakeTask[] {
  const start = content.indexOf("<background_tasks>");
  const end = content.indexOf("</background_tasks>");
  if (start < 0 || end < start) return [];
  const tasks: BackgroundWakeTask[] = [];
  for (const line of content.slice(start, end).split("\n")) {
    const m = TASK_LINE.exec(line);
    if (m) {
      tasks.push({ status: m[1]!, taskId: m[2]!, headline: m[3]!.trim() });
    } else {
      // A digest's first line may be empty ("task x: \n# Heading"); take the
      // next non-empty line as the headline.
      const last = tasks.at(-1);
      if (last && !last.headline && line.trim()) last.headline = line.trim();
    }
  }
  return tasks;
}
