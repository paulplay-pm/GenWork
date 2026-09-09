import React, { useCallback, useEffect, useRef, useState } from 'react';

import type { Artifact } from '@/types/artifact';

interface ImageRendererProps {
  artifact: Artifact;
}

const ImageRenderer: React.FC<ImageRendererProps> = ({ artifact }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [error, setError] = useState(false);

  const handleWheel = useCallback((e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setScale(prev => Math.max(0.1, Math.min(5, prev - e.deltaY * 0.001)));
    }
  }, []);

  const resetZoom = useCallback(() => setScale(1), []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  if (!artifact.content) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Loading image...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Failed to load image
      </div>
    );
  }

  return (
    <div className="relative w-full h-full overflow-auto" ref={containerRef}>
      <div
        className="flex items-center justify-center min-h-full p-4"
        style={{ transform: `scale(${scale})`, transformOrigin: 'center center' }}
      >
        <img
          src={artifact.content}
          alt={artifact.title}
          className="max-w-full max-h-full object-contain"
          onError={() => setError(true)}
        />
      </div>
      {scale !== 1 && (
        <button
          onClick={resetZoom}
          className="absolute bottom-3 right-3 px-2 py-1 text-xs rounded bg-surface text-secondary hover:bg-surface-hover"
        >
          {Math.round(scale * 100)}%
        </button>
      )}
    </div>
  );
};

export default ImageRenderer;
