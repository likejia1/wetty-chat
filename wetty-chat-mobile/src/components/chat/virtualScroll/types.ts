import type { MutableRefObject, ReactNode } from 'react';
import type { MessageResponse } from '@/api/messages';

// ── Row model ──

export type ChatRow =
  | { type: 'date'; key: string; dateLabel: string }
  | {
    type: 'message';
    key: string;
    message: MessageResponse;
    showName: boolean;
    showAvatar: boolean;
  };

// ── Geometry ──

export interface CoreRange {
  start: number; // index into ChatRow[]
  end: number; // inclusive
}

export interface MountedWindow {
  start: number; // index into ChatRow[]
  end: number; // inclusive
}

// ── State machine ──

export type Phase = 'WAITING_VIEWPORT' | 'BOOTSTRAP' | 'READY' | 'RECENTERING';

// ── Mutations ──

export type MutationType = 'none' | 'prepend' | 'append' | 'reset';
export type BatchDirection = 'backward' | 'forward';

export interface PendingBatch {
  direction: BatchDirection;
  keys: string[];
}

// ── Layout intents ──

export interface LayoutIntent {
  preserveHeightDelta?: number;
  scrollToBottom?: boolean;
  scrollToKey?: { key: string; behavior: ScrollBehavior };
}

// ── Public API ──

export interface VirtualScrollHandle {
  scrollToBottom: () => void;
  scrollToItem: (key: string, behavior?: ScrollBehavior) => void;
}

export type VirtualScrollAnchor =
  | { type: 'bottom'; token: number }
  | { type: 'item'; key: string; token: number };

export interface LoadController {
  hasMore: boolean;
  loading?: boolean;
  onLoad: () => void;
}

export interface ChatVirtualScrollProps {
  rows: ChatRow[];
  renderRow: (row: ChatRow) => ReactNode;
  initialAnchor: VirtualScrollAnchor;
  scrollApiRef?: MutableRefObject<VirtualScrollHandle | null>;
  loadOlder: LoadController;
  loadNewer?: LoadController;
  header?: ReactNode;
  bottomPadding?: number;
  onAtBottomChange?: (atBottom: boolean) => void;
}

// ── Constants ──

export const BOOTSTRAP_HEIGHT_MULTIPLIER = 2;
export const STAGING_BATCH_SIZE = 40;
export const MOUNT_OVERSCAN = 30;
export const MOUNT_CAP = 80;
export const CORE_CAP = 200;
export const VIEWPORT_TRIGGER_PX = 300;
export const BOUNDARY_HEIGHT_PX = 60;
export const SCROLL_IDLE_MS = 200;
export const AT_BOTTOM_THRESHOLD_PX = 30;
