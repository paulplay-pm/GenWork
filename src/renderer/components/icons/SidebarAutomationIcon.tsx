import React from 'react';

const SidebarAutomationIcon: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg className={className} viewBox="0 0 34 34" fill="none" aria-hidden="true">
      <path
        d="M17 29C23.6274 29 29 23.6274 29 17C29 10.3726 23.6274 5 17 5C10.3726 5 5 10.3726 5 17C5 23.6274 10.3726 29 17 29Z"
        stroke="currentColor"
        strokeWidth="2.4"
      />
      <path
        d="M17 11V17L21 19.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default SidebarAutomationIcon;
