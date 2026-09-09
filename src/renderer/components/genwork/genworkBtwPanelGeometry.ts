export interface GenWorkBtwPanelGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GenWorkBtwPanelViewport {
  width: number;
  height: number;
}

export interface GenWorkBtwPanelAnchor {
  top: number;
  right: number;
  width: number;
  height: number;
}

export const GenWorkBtwResizeDirection = {
  Top: 'top',
  TopRight: 'top-right',
  Right: 'right',
  BottomRight: 'bottom-right',
  Bottom: 'bottom',
  BottomLeft: 'bottom-left',
  Left: 'left',
  TopLeft: 'top-left',
} as const;
export type GenWorkBtwResizeDirection =
  typeof GenWorkBtwResizeDirection[keyof typeof GenWorkBtwResizeDirection];

export const GENWORK_BTW_PANEL_MARGIN = 16;
export const GENWORK_BTW_PANEL_DEFAULT_WIDTH = 340;
export const GENWORK_BTW_PANEL_DEFAULT_HEIGHT = 380;
export const GENWORK_BTW_PANEL_MIN_WIDTH = 320;
export const GENWORK_BTW_PANEL_MIN_HEIGHT = 320;
export const GENWORK_BTW_PANEL_ANCHOR_GAP = 16;

const clamp = (value: number, minimum: number, maximum: number): number => (
  Math.min(Math.max(value, minimum), maximum)
);

const getAvailableSize = (value: number): number => (
  Math.max(1, value - GENWORK_BTW_PANEL_MARGIN * 2)
);

const isUsableAnchor = (
  anchor: GenWorkBtwPanelAnchor | undefined,
): anchor is GenWorkBtwPanelAnchor => Boolean(
  anchor
  && Number.isFinite(anchor.top)
  && Number.isFinite(anchor.right)
  && Number.isFinite(anchor.width)
  && Number.isFinite(anchor.height)
  && anchor.width > 0
  && anchor.height > 0
);

export const clampGenWorkBtwPanelGeometry = (
  geometry: GenWorkBtwPanelGeometry,
  viewport: GenWorkBtwPanelViewport,
): GenWorkBtwPanelGeometry => {
  const availableWidth = getAvailableSize(viewport.width);
  const availableHeight = getAvailableSize(viewport.height);
  const minimumWidth = Math.min(GENWORK_BTW_PANEL_MIN_WIDTH, availableWidth);
  const minimumHeight = Math.min(GENWORK_BTW_PANEL_MIN_HEIGHT, availableHeight);
  const width = clamp(geometry.width, minimumWidth, availableWidth);
  const height = clamp(geometry.height, minimumHeight, availableHeight);
  return {
    x: clamp(
      geometry.x,
      GENWORK_BTW_PANEL_MARGIN,
      Math.max(GENWORK_BTW_PANEL_MARGIN, viewport.width - width - GENWORK_BTW_PANEL_MARGIN),
    ),
    y: clamp(
      geometry.y,
      GENWORK_BTW_PANEL_MARGIN,
      Math.max(GENWORK_BTW_PANEL_MARGIN, viewport.height - height - GENWORK_BTW_PANEL_MARGIN),
    ),
    width,
    height,
  };
};

export const getInitialGenWorkBtwPanelGeometry = (
  viewport: GenWorkBtwPanelViewport,
  anchor?: GenWorkBtwPanelAnchor,
): GenWorkBtwPanelGeometry => {
  const usableAnchor = isUsableAnchor(anchor) ? anchor : undefined;
  return clampGenWorkBtwPanelGeometry({
    x: usableAnchor
      ? usableAnchor.right - GENWORK_BTW_PANEL_DEFAULT_WIDTH
      : viewport.width - GENWORK_BTW_PANEL_DEFAULT_WIDTH - GENWORK_BTW_PANEL_MARGIN,
    y: usableAnchor
      ? usableAnchor.top - GENWORK_BTW_PANEL_DEFAULT_HEIGHT - GENWORK_BTW_PANEL_ANCHOR_GAP
      : viewport.height - GENWORK_BTW_PANEL_DEFAULT_HEIGHT - GENWORK_BTW_PANEL_MARGIN,
    width: GENWORK_BTW_PANEL_DEFAULT_WIDTH,
    height: GENWORK_BTW_PANEL_DEFAULT_HEIGHT,
  }, viewport);
};

export const resizeGenWorkBtwPanelGeometry = (
  geometry: GenWorkBtwPanelGeometry,
  deltaX: number,
  deltaY: number,
  direction: GenWorkBtwResizeDirection,
  viewport: GenWorkBtwPanelViewport,
): GenWorkBtwPanelGeometry => {
  const start = clampGenWorkBtwPanelGeometry(geometry, viewport);
  const availableWidth = getAvailableSize(viewport.width);
  const availableHeight = getAvailableSize(viewport.height);
  const minimumWidth = Math.min(GENWORK_BTW_PANEL_MIN_WIDTH, availableWidth);
  const minimumHeight = Math.min(GENWORK_BTW_PANEL_MIN_HEIGHT, availableHeight);
  const startRight = start.x + start.width;
  const startBottom = start.y + start.height;
  let left = start.x;
  let right = startRight;
  let top = start.y;
  let bottom = startBottom;

  if (
    direction === GenWorkBtwResizeDirection.Left
    || direction === GenWorkBtwResizeDirection.TopLeft
    || direction === GenWorkBtwResizeDirection.BottomLeft
  ) {
    left = clamp(
      start.x + deltaX,
      GENWORK_BTW_PANEL_MARGIN,
      startRight - minimumWidth,
    );
  } else if (
    direction === GenWorkBtwResizeDirection.Right
    || direction === GenWorkBtwResizeDirection.TopRight
    || direction === GenWorkBtwResizeDirection.BottomRight
  ) {
    right = clamp(
      startRight + deltaX,
      start.x + minimumWidth,
      viewport.width - GENWORK_BTW_PANEL_MARGIN,
    );
  }

  if (
    direction === GenWorkBtwResizeDirection.Top
    || direction === GenWorkBtwResizeDirection.TopLeft
    || direction === GenWorkBtwResizeDirection.TopRight
  ) {
    top = clamp(
      start.y + deltaY,
      GENWORK_BTW_PANEL_MARGIN,
      startBottom - minimumHeight,
    );
  } else if (
    direction === GenWorkBtwResizeDirection.Bottom
    || direction === GenWorkBtwResizeDirection.BottomLeft
    || direction === GenWorkBtwResizeDirection.BottomRight
  ) {
    bottom = clamp(
      startBottom + deltaY,
      start.y + minimumHeight,
      viewport.height - GENWORK_BTW_PANEL_MARGIN,
    );
  }

  return clampGenWorkBtwPanelGeometry({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }, viewport);
};