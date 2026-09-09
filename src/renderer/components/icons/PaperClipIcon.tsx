import React from 'react';

const PaperClipIcon: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg className={className} viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M20.6214 10.4486L11.3107 19.7593C10.2823 20.7877 10.2823 22.4551 11.3107 23.4836C12.3391 24.512 14.0065 24.512 15.035 23.4836L24.3457 14.1728C26.4026 12.116 26.4025 8.78115 24.3457 6.72428C22.2888 4.66742 18.954 4.66742 16.8971 6.72428L7.58641 16.035C4.50111 19.1203 4.50111 24.1225 7.58641 27.2078C10.6717 30.2931 15.674 30.2931 18.7593 27.2078L24.7979 21.1692" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
};

export default PaperClipIcon;
