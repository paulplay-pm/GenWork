/** Copy text to the clipboard. Resolves `false` when the clipboard API is
 * unavailable (insecure context, some browsers) or the write is rejected —
 * the caller can still show the text, which remains selectable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
