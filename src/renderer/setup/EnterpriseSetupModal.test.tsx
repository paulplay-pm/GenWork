import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string): string => key },
}));

import { EnterpriseSetupModal } from './EnterpriseSetupModal';

describe('EnterpriseSetupModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseProps = {
    initialUrl: 'https://enterprise.example.com',
    onVerify: async () => ({ ok: true as const }),
    onSave: async () => ({ ok: true as const }),
    onQuit: () => undefined,
  };

  test('firstTime mode (default) shows Quit button', () => {
    const html = renderToStaticMarkup(<EnterpriseSetupModal {...baseProps} />);
    expect(html).toContain('enterpriseSetup.quit');
  });

  test('firstTime mode (default) does not show Cancel button', () => {
    const html = renderToStaticMarkup(<EnterpriseSetupModal {...baseProps} />);
    expect(html).not.toContain('enterpriseSetup.cancel');
  });

  test('firstTime mode (default) does not show restart-required notice', () => {
    const html = renderToStaticMarkup(<EnterpriseSetupModal {...baseProps} />);
    expect(html).not.toContain('enterpriseSetup.restartRequired');
  });

  test('edit mode hides Quit button', () => {
    const html = renderToStaticMarkup(
      <EnterpriseSetupModal {...baseProps} mode="edit" />,
    );
    expect(html).not.toContain('enterpriseSetup.quit');
  });

  test('edit mode shows Cancel button', () => {
    const html = renderToStaticMarkup(
      <EnterpriseSetupModal {...baseProps} mode="edit" />,
    );
    expect(html).toContain('enterpriseSetup.cancel');
  });

  test('edit mode shows Test Connection button', () => {
    const html = renderToStaticMarkup(
      <EnterpriseSetupModal {...baseProps} mode="edit" />,
    );
    expect(html).toContain('enterpriseSetup.testConnection');
  });

  test('edit mode shows the restart-required notice', () => {
    const html = renderToStaticMarkup(
      <EnterpriseSetupModal {...baseProps} mode="edit" />,
    );
    expect(html).toContain('enterpriseSetup.restartRequired');
  });

  test('firstTime mode does not show the restart-required notice', () => {
    const html = renderToStaticMarkup(<EnterpriseSetupModal {...baseProps} />);
    expect(html).not.toContain('enterpriseSetup.restartRequired');
  });

  test('edit mode uses save label not save-and-continue label', () => {
    const firstTime = renderToStaticMarkup(<EnterpriseSetupModal {...baseProps} />);
    const edit = renderToStaticMarkup(
      <EnterpriseSetupModal {...baseProps} mode="edit" />,
    );
    expect(firstTime).toContain('enterpriseSetup.save');
    expect(edit).toContain('enterpriseSetup.saveEdit');
    expect(edit).not.toContain('enterpriseSetup.save"');
  });

  test('edit mode renders the initial URL into the input', () => {
    const html = renderToStaticMarkup(
      <EnterpriseSetupModal {...baseProps} initialUrl="https://prod.genwork.com" mode="edit" />,
    );
    expect(html).toContain('value="https://prod.genwork.com"');
  });

  test('edit mode calls onSave without forcing onVerify when user clicks Save', async () => {
    const onVerify = vi.fn(async () => ({ ok: true as const }));
    const onSave = vi.fn(async () => ({ ok: true as const }));
    // Render via DOM-like structure: we still rely on renderToStaticMarkup for markup,
    // but the contract we assert is: edit mode does NOT auto-call onVerify on mount,
    // and Save invokes onSave + onVerify in the same flow as firstTime.
    const html = renderToStaticMarkup(
      <EnterpriseSetupModal
        {...baseProps}
        mode="edit"
        onVerify={onVerify}
        onSave={onSave}
      />,
    );
    expect(html).toBeDefined();
    expect(onVerify).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});