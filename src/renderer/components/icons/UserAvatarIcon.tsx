import React from 'react';

const UserAvatarIcon: React.FC<{ className?: string }> = ({ className }) => {
  const clipPathId = `user-avatar-icon-clip-${React.useId().replace(/:/g, '')}`;

  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g clipPath={`url(#${clipPathId})`}>
        <circle cx="16" cy="16" r="16" fill="currentColor" fillOpacity="0.12" />
        <circle cx="16" cy="12" r="6" fill="currentColor" fillOpacity="0.64" />
        <circle cx="16" cy="35" r="14" fill="currentColor" fillOpacity="0.64" />
      </g>
      <defs>
        <clipPath id={clipPathId}>
          <rect width="32" height="32" rx="16" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
};

export default UserAvatarIcon;
