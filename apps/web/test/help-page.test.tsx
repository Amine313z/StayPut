import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuideContext, type GuideControls } from '../src/components/guide/context';
import { I18nProvider } from '../src/i18n';
import { FaqTab, SupportTab } from '../src/views/creator/HelpTab';

/**
 * Help & support (decision of 2026-10-13): the questions creators ask, the tour one click away,
 * and a message to the founder (refused in the demo, where nothing is sent).
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const guide: GuideControls = {
  openGuide: vi.fn(),
  startTour: vi.fn(),
  showMe: vi.fn(),
  go: vi.fn(),
};

function show(
  screenToShow: 'faq' | 'support',
  { demo = false, locale = 'en' }: { demo?: boolean; locale?: 'en' | 'fr' } = {},
) {
  render(
    <I18nProvider initialLocale={locale}>
      <GuideContext.Provider value={guide}>
        <MemoryRouter initialEntries={['/help']}>
          <Routes>
            <Route element={<Outlet context={{ api: '/api/creator/biz_A1', demo }} />}>
              <Route path="/help" element={screenToShow === 'faq' ? <FaqTab /> : <SupportTab />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </GuideContext.Provider>
    </I18nProvider>,
  );
}

function answering(status: number, body: unknown) {
  const fetchMock = vi.fn((_input: string, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Help & support › FAQ', () => {
  it('lists the questions, each answered in place, and starts the tour', () => {
    show('faq');
    const questions = document.querySelectorAll('[data-faq]');
    expect(questions).toHaveLength(12);
    const question = screen.getByText('How is the money saved counted?');
    const item = question.closest('details')!;
    expect(item.open).toBe(false);
    fireEvent.click(question);
    expect(item.open).toBe(true);
    expect(item.textContent).toContain('within 14 days of StayPut’s action');
    fireEvent.click(screen.getByRole('button', { name: 'Take the tour' }));
    expect(guide.startTour).toHaveBeenCalled();
  });

  it('speaks French too', () => {
    show('faq', { locale: 'fr' });
    expect(screen.getByText('Questions fréquentes')).toBeTruthy();
    expect(screen.getByText('Dois-je créer un bot Discord ou Telegram ?')).toBeTruthy();
  });
});

describe('Help & support › Support', () => {
  it('sends the message to the founder, then says where the answer comes', async () => {
    const fetchMock = answering(200, { received: true });
    show('support');
    const send = screen.getByRole('button', { name: 'Send to the founder' });
    expect(send).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Your message'), { target: { value: 'Too short' } });
    expect(screen.getByText('A few more words, please.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Your message'), {
      target: { value: '  My Discord server does not show up.  ' },
    });
    expect(send).toHaveProperty('disabled', false);
    fireEvent.click(send);
    expect(await screen.findByText('Message sent')).toBeTruthy();
    expect(
      screen.getByText('Thanks! The founder will answer you in your Whop chats.'),
    ).toBeTruthy();
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/creator/biz_A1/support');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
      message: 'My Discord server does not show up.',
    });
  });

  it('says so when the day’s messages are used', async () => {
    answering(409, { error: { code: 'conflict', message: 'too many support messages today' } });
    show('support');
    fireEvent.change(screen.getByLabelText('Your message'), {
      target: { value: 'Another message for the founder' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to the founder' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'You already wrote several times today: the founder has your messages. Write again tomorrow.',
    );
  });

  it('sends nothing in the demo', () => {
    const fetchMock = answering(200, { received: true });
    show('support', { demo: true });
    fireEvent.change(screen.getByLabelText('Your message'), {
      target: { value: 'A message written in the demo' },
    });
    const send = screen.getByRole('button', { name: 'Send to the founder' });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(send);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Disabled in the demo')).toBeTruthy();
  });
});
