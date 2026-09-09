import React from 'react';

const TaskPauseIcon: React.FC<React.SVGProps<SVGSVGElement>> = ({ className, ...props }) => {
  return (
    <svg
      className={className}
      viewBox="0 0 34 34"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <circle cx="17" cy="17" r="13" fill="black" />
      <rect x="12" y="12" width="10" height="10" rx="2" fill="white" />
    </svg>
  );
};

export default TaskPauseIcon;
