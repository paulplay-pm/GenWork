import './skinPresentation.css';

import React, { type CSSProperties } from 'react';

import type { SkinPresentation } from '../../../shared/skin/presentation';
import { useSkin } from '../../providers/SkinProvider';

type SkinPresentationStyle = CSSProperties & Record<`--genwork-skin-${string}`, string>;

export const buildSkinPresentationStyle = (
  presentation: SkinPresentation,
): SkinPresentationStyle => ({
  '--genwork-skin-canvas': presentation.palette.canvas,
  '--genwork-skin-panel': presentation.palette.panel,
  '--genwork-skin-panel-raised': presentation.palette.panelRaised,
  '--genwork-skin-accent': presentation.palette.accent,
  '--genwork-skin-accent-foreground': presentation.palette.accentForeground,
  '--genwork-skin-accent-alt': presentation.palette.accentAlt,
  '--genwork-skin-foreground': presentation.palette.foreground,
  '--genwork-skin-muted': presentation.palette.muted,
  '--genwork-skin-border': presentation.palette.border,
  '--genwork-skin-focus-x': `${(presentation.art?.focusX ?? 0.5) * 100}%`,
  '--genwork-skin-focus-y': `${(presentation.art?.focusY ?? 0.5) * 100}%`,
});

interface SkinPresentationScopeProps extends React.HTMLAttributes<HTMLDivElement> {
  enabled: boolean;
}

const SkinPresentationScope: React.FC<SkinPresentationScopeProps> = ({
  children,
  enabled,
  style,
  ...props
}) => {
  const { activeSkin } = useSkin();
  const presentation = enabled ? activeSkin?.presentation : undefined;

  return (
    <div
      {...props}
      data-skin-presentation={presentation?.mode}
      style={presentation ? { ...style, ...buildSkinPresentationStyle(presentation) } : style}
    >
      {children}
    </div>
  );
};

export default SkinPresentationScope;
