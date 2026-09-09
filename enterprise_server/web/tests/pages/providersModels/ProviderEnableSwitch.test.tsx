import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ProviderEnableSwitch } from '../../../src/pages/providersModels/ProviderEnableSwitch';

describe('providersModels/ProviderEnableSwitch', () => {
  test('renders the "enabled" title and hint when enabled', () => {
    render(
      <ProviderEnableSwitch
        enabled
        canManage
        busy={false}
        onToggle={vi.fn()}
      />
    );
    expect(screen.getByText('Provider enabled')).toBeInTheDocument();
    expect(
      screen.getByText(/This provider’s models are available for business use/i)
    ).toBeInTheDocument();
  });

  test('renders the "disabled" title and hint when off', () => {
    render(
      <ProviderEnableSwitch
        enabled={false}
        canManage
        busy={false}
        onToggle={vi.fn()}
      />
    );
    expect(screen.getByText('Provider disabled')).toBeInTheDocument();
    expect(
      screen.getByText(/not used in business calls/i)
    ).toBeInTheDocument();
  });

  test('toggles via the switch role and reports the new value', () => {
    const onToggle = vi.fn();
    render(
      <ProviderEnableSwitch
        enabled
        canManage
        busy={false}
        onToggle={onToggle}
      />
    );
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  test('switch is disabled when canManage is false', () => {
    render(
      <ProviderEnableSwitch
        enabled
        canManage={false}
        busy={false}
        onToggle={vi.fn()}
      />
    );
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  test('switch is disabled while a mutation is in flight', () => {
    render(
      <ProviderEnableSwitch
        enabled
        canManage
        busy
        onToggle={vi.fn()}
      />
    );
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});
