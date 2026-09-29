import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { parseWhatsApp } from '@/lib/whatsapp-format';
import type { WhatsAppLine, WhatsAppNode } from '@/lib/whatsapp-format';

/**
 * Texto de mensagem com a formatação do WhatsApp — COMPONENTS.md, D-183/D-242.
 *
 * Desenha a árvore de `parseWhatsApp` só com nós React: o React escapa o texto,
 * então HTML ou `<script>` vindo do paciente aparece como texto. Nunca
 * `dangerouslySetInnerHTML`.
 *
 * Fica dentro de um elemento com `whitespace-pre-wrap` (a bolha): linha comum é
 * texto + `\n`; citação e item de lista são `<span class="block">`, que já
 * quebram sozinhos — por isso não levam `\n` do lado.
 */

function renderNode(node: WhatsAppNode, key: number): ReactNode {
  switch (node.type) {
    case 'text':
      return node.text;
    case 'bold':
      return <strong key={key}>{renderNodes(node.children)}</strong>;
    case 'italic':
      return <em key={key}>{renderNodes(node.children)}</em>;
    case 'strike':
      return <s key={key}>{renderNodes(node.children)}</s>;
    case 'mono':
      return (
        <code key={key} data-format="mono" className="font-mono">
          {node.text}
        </code>
      );
    case 'code':
      return (
        <code key={key} data-format="code" className="rounded-sm bg-neutral-100 px-xs font-mono">
          {node.text}
        </code>
      );
    case 'link':
      return (
        <a
          key={key}
          href={node.href}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-accent-700 underline underline-offset-2 hover:text-accent-900"
        >
          {node.text}
        </a>
      );
  }
}

function renderNodes(nodes: WhatsAppNode[]): ReactNode[] {
  return nodes.map((node, index) => renderNode(node, index));
}

function renderLine(line: WhatsAppLine): ReactNode {
  const content = renderNodes(line.children);
  switch (line.kind) {
    case 'plain':
      return content;
    case 'quote':
      return (
        <span
          data-format="quote"
          className="block border-0 border-l-4 border-solid border-neutral-300 pl-sm text-neutral-700"
        >
          {content}
        </span>
      );
    case 'bullet':
      return (
        <span data-format="bullet" className="block pl-sm">
          {'• '}
          {content}
        </span>
      );
    case 'numbered':
      return (
        <span data-format="numbered" className="block pl-sm">
          {`${line.marker ?? ''}. `}
          {content}
        </span>
      );
  }
}

export function WhatsAppText({ text }: { text: string }) {
  const lines = parseWhatsApp(text);
  return (
    <>
      {lines.map((line, index) => {
        const next = lines[index + 1];
        // Quebra só entre duas linhas comuns: o bloco já começa/termina em linha própria.
        const newline = next !== undefined && line.kind === 'plain' && next.kind === 'plain';
        return (
          <Fragment key={index}>
            {renderLine(line)}
            {newline && '\n'}
          </Fragment>
        );
      })}
    </>
  );
}
