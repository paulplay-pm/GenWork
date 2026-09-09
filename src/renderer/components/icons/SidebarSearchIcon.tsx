import React from 'react';

const SidebarSearchIcon: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg className={className} viewBox="0 0 34 34" fill="none" aria-hidden="true">
      <path
        d="M16.5 27C22.299 27 27 22.299 27 16.5C27 10.701 22.299 6 16.5 6C10.701 6 6 10.701 6 16.5C6 22.299 10.701 27 16.5 27Z"
        stroke="currentColor"
        strokeWidth="2.4"
      />
      <path
        d="M25 25L28 28"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
};

export default SidebarSearchIcon;
