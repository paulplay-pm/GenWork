import React from 'react';

const EditIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 34 34" fill="none" aria-hidden="true">
    <path
      d="M21.6098 6.43144C22.3812 5.64088 23.6474 5.62536 24.438 6.39677L28.7323 10.5871C29.5229 11.3585 29.5384 12.6247 28.767 13.4153L14.889 27.6377C14.4901 28.0465 13.9354 28.2652 13.3648 28.2388L8.46672 28.0114C7.96024 27.9879 7.55151 27.5891 7.51559 27.0833L7.16827 22.1923C7.12781 21.6225 7.33289 21.0626 7.73181 20.6538L21.6098 6.43144Z"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinejoin="round"
    />
    <path
      d="M19.6642 9.85669L25.8599 15.7634"
      stroke="currentColor"
      strokeWidth="2.4"
    />
  </svg>
);

export default EditIcon;
