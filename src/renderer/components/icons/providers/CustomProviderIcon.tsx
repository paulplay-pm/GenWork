import React from 'react';

const CustomProviderIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" height="24" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{ flex: '0 0 auto', lineHeight: 1 }}>
    <title>Custom</title>
    <path d="m21 7.5-9-5.25L3 7.5m18 0-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default CustomProviderIcon;
