import React from 'react';

const SidebarLibraryIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M4.5 5.5h4v13h-4z" />
    <path d="M10 5.5h4v13h-4z" />
    <path d="m16 6.2 3.5-1.1 3.2 12.4-3.5 1.1z" />
  </svg>
);

export default SidebarLibraryIcon;
