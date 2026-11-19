import { useEffect } from 'react';

/**
 * Cabeça de PWA só da `/digitalizar` (PAGES.md §24, D-326 item 2): manifesto
 * próprio, ícone da tela de início do iOS e `viewport-fit=cover` (para o
 * `env(safe-area-inset-*)` valer). Sem service worker. Sai tudo ao desmontar —
 * o resto do CRM não ganha manifesto.
 */
const HEAD_TAGS: ReadonlyArray<{ tag: 'link' | 'meta'; attrs: Record<string, string> }> = [
  { tag: 'link', attrs: { rel: 'manifest', href: '/digitalizar.webmanifest' } },
  { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/digitalizar-icons/apple-touch-icon.png' } },
  { tag: 'meta', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' } },
  { tag: 'meta', attrs: { name: 'mobile-web-app-capable', content: 'yes' } },
  { tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: 'Digitalizar' } },
  { tag: 'meta', attrs: { name: 'apple-mobile-web-app-status-bar-style', content: 'default' } },
];

export function usePwaHead(): void {
  useEffect(() => {
    const added = HEAD_TAGS.map(({ tag, attrs }) => {
      const element = document.createElement(tag);
      for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
      element.setAttribute('data-digitalizar', '');
      document.head.appendChild(element);
      return element;
    });

    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const previousViewport = viewport?.content ?? null;
    if (viewport && !viewport.content.includes('viewport-fit')) {
      viewport.content = `${viewport.content}, viewport-fit=cover`;
    }
    const previousTitle = document.title;
    document.title = 'Digitalizar';

    return () => {
      for (const element of added) element.remove();
      if (viewport && previousViewport !== null) viewport.content = previousViewport;
      document.title = previousTitle;
    };
  }, []);
}
