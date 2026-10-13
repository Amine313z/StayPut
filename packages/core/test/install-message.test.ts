import { describe, expect, it } from 'vitest';
import { installChatMessage, installNotification } from '../src/install-message';

describe('the message to whoever installs StayPut', () => {
  it('greets them by name, says what StayPut does, the first three steps, and invites a reply', () => {
    const text = installChatMessage('en', 'Eden');
    expect(text.startsWith('Hey Eden 👋 Thanks for installing **StayPut**!')).toBe(true);
    expect(text).toContain('1. Connect Discord or Telegram in **Integrations**');
    expect(text).toContain('2. Choose manual or automatic in **Automations**');
    expect(text).toContain('3. Open **Members** to see who is at risk');
    expect(text.endsWith('Reply right here, I read every message.')).toBe(true);
  });

  it('speaks French to a French community, with the screens’ French names', () => {
    const text = installChatMessage('fr', 'Eden');
    expect(text.startsWith('Bonjour Eden 👋 Merci d’avoir installé **StayPut** !')).toBe(true);
    expect(text).toContain('**Intégrations**');
    expect(text).toContain('**Automatisations**');
    expect(text).toContain('**Membres**');
  });

  it('greets without a name when Whop gave none, and never lets a name carry Markdown', () => {
    expect(installChatMessage('en', null).startsWith('Hey there 👋')).toBe(true);
    expect(installChatMessage('en', '   ').startsWith('Hey there 👋')).toBe(true);
    expect(installChatMessage('fr', undefined).startsWith('Bonjour 👋')).toBe(true);
    const sly = installChatMessage('en', '**[click](https://evil.example)**');
    expect(sly.startsWith('Hey clickhttps://evil.example 👋')).toBe(true);
    expect(installChatMessage('en', 'x'.repeat(200)).split(' ')[1]).toHaveLength(60);
  });

  it('has a short notification for when the support chat could not be opened', () => {
    expect(installNotification('en')).toEqual({
      title: 'Welcome to StayPut',
      content: expect.stringContaining('connect Discord or Telegram in Integrations') as string,
    });
    expect(installNotification('fr').title).toBe('Bienvenue sur StayPut');
  });
});
