const MIRROR_STYLES = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
  'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'boxSizing', 'whiteSpace', 'wordWrap', 'overflowWrap', 'direction',
] as const;

export function getCaretPixelPosition(
  textarea: HTMLTextAreaElement,
  charIndex: number,
): { top: number; left: number; height: number } {
  const computed = getComputedStyle(textarea);
  const mirror = document.createElement('div');

  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.overflow = 'hidden';
  mirror.style.width = `${textarea.clientWidth}px`;

  for (const prop of MIRROR_STYLES) {
    mirror.style[prop as unknown as number] = computed[prop];
  }

  const textBefore = textarea.value.slice(0, charIndex);
  mirror.textContent = textBefore;

  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const markerTop = marker.offsetTop - textarea.scrollTop;
  const markerLeft = marker.offsetLeft - textarea.scrollLeft;
  const lineHeight = parseInt(computed.lineHeight, 10) || parseInt(computed.fontSize, 10) * 1.2;

  document.body.removeChild(mirror);

  const rect = textarea.getBoundingClientRect();
  const paddingTop = parseFloat(computed.paddingTop);
  const paddingLeft = parseFloat(computed.paddingLeft);
  const borderTop = parseFloat(computed.borderTopWidth);
  const borderLeft = parseFloat(computed.borderLeftWidth);

  return {
    top: rect.top + borderTop + paddingTop + markerTop,
    left: rect.left + borderLeft + paddingLeft + markerLeft,
    height: lineHeight,
  };
}
