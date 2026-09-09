import React from 'react';

const SidebarKitsIcon: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg className={className} viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="11.0001"
        y="6"
        width="7.07123"
        height="7.07123"
        rx="1"
        transform="rotate(45 11.0001 6)"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <rect
        x="7"
        y="19"
        width="8"
        height="8"
        rx="2"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <rect
        x="19"
        y="7"
        width="8"
        height="8"
        rx="4"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <rect
        x="19"
        y="19"
        width="8"
        height="8"
        rx="4"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default SidebarKitsIcon;
