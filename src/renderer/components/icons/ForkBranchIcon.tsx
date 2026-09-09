import React from 'react';

const ForkBranchIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M7 5.5V11C7 14.3137 9.68629 17 13 17H17"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M7 11C7 8.79086 8.79086 7 11 7H15.5"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M13.5 5L15.5 7L13.5 9"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M15 15L17 17L15 19"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default ForkBranchIcon;
