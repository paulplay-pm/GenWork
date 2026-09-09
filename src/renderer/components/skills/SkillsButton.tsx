import React, { useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import { Skill } from '../../types/skill';
import SkillIcon from '../icons/SkillIcon';
import SkillsPopover from './SkillsPopover';

interface SkillsButtonProps {
  onSelectSkill: (skill: Skill) => void;
  onManageSkills: () => void;
  className?: string;
  iconClassName?: string;
}

const SkillsButton: React.FC<SkillsButtonProps> = ({
  onSelectSkill,
  onManageSkills,
  className = '',
  iconClassName = 'h-5 w-5',
}) => {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleButtonClick = () => {
    setIsPopoverOpen(prev => !prev);
  };

  const handleClosePopover = () => {
    setIsPopoverOpen(false);
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={handleButtonClick}
        className={`flex h-[34px] w-[34px] items-center justify-center rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground transition-colors ${className}`}
        title={i18nService.t('skills')}
        aria-label={i18nService.t('skills')}
      >
        <SkillIcon className={iconClassName} />
      </button>
      <SkillsPopover
        isOpen={isPopoverOpen}
        onClose={handleClosePopover}
        onSelectSkill={onSelectSkill}
        onManageSkills={onManageSkills}
        anchorRef={buttonRef}
      />
    </div>
  );
};

export default SkillsButton;
