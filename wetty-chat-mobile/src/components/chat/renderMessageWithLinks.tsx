import type { ReactNode } from 'react';
import styles from './ChatBubble.module.scss';

const URL_REGEX = /(https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+)/g;
const TRAILING_PUNCT = /[.,);!?]+$/;

export function renderMessageWithLinks(message: string): ReactNode[] {
  const parts = message.split(URL_REGEX);
  if (parts.length === 1) return [message];

  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const trimmed = part.replace(TRAILING_PUNCT, '');
      const suffix = part.slice(trimmed.length);
      return (
        <span key={i}>
          <a
            href={trimmed}
            className={styles.messageLink}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {trimmed}
          </a>
          {suffix}
        </span>
      );
    }

    return part;
  });
}
