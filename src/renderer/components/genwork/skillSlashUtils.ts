/**
 * Slash-trigger detection for the in-input skill picker.
 *
 * Typing "/" opens the skill list only when the "/" sits at the *message
 * start* — i.e. everything before it is whitespace (the standard
 * slash-command convention, so a mid-sentence "/" never fires). The text
 * between the "/" and the caret is the live filter; a space ends the token.
 */
export interface SkillSlashTrigger {
  /** Index of the "/" that opened the picker. */
  slashIndex: number;
  /** Caret position the trigger was resolved against. */
  cursorPos: number;
  /** Text between the "/" and the caret (the search filter). */
  filter: string;
}

export function resolveSkillSlashTrigger(
  text: string,
  cursorPos: number,
): SkillSlashTrigger | null {
  const normalizedCursorPos = Math.min(Math.max(cursorPos, 0), text.length);
  const textBeforeCursor = text.slice(0, normalizedCursorPos);
  const slashIndex = textBeforeCursor.lastIndexOf('/');
  if (slashIndex === -1) return null;

  // The "/" must be at the message start: only whitespace before it.
  if (textBeforeCursor.slice(0, slashIndex).trim() !== '') return null;

  const filter = textBeforeCursor.slice(slashIndex + 1);
  // A space (or newline) after the "/" ends the token.
  if (/\s/.test(filter)) return null;

  return { slashIndex, cursorPos: normalizedCursorPos, filter };
}
