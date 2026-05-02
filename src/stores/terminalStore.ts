import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from '@/services/logger';
import { isDesktopRuntimeAvailable } from '@/services/runtimeEnvironment';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  findPanelZone,
  useWorkspaceLayoutStore,
  type DockZoneId,
  type PanelId,
} from './workspaceLayoutStore';

const logger = createLogger('TerminalStore');

const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 32;
const DEFAULT_TERMINAL_HEIGHT = 220;
const MAX_SCROLLBACK_BYTES = 512 * 1024;
const TERMINAL_ZONE_ID: DockZoneId = 'bottom';
export const TERMINAL_PANEL_ID: PanelId = 'terminal';

type TerminalSessionStatus = 'starting' | 'running' | 'exited' | 'error';

interface StartTerminalSessionInput {
  sessionId: string;
  cwd?: string | null;
  cols?: number | null;
  rows?: number | null;
  profileId?: string | null;
  shell?: string | null;
  shellArgs?: string[] | null;
}

interface TerminalSessionStartResult {
  sessionId: string;
  cwd: string;
  shell: string;
}

interface DetectedTerminalProfile {
  id: string;
  label: string;
  commandLine: string;
  source: string;
  isDefault: boolean;
}

type TerminalStreamEvent =
  | { type: 'data'; data: string }
  | { type: 'exit'; exitCode: number | null }
  | { type: 'error'; message: string };

export interface TerminalBufferChunk {
  id: number;
  data: string;
}

export interface TerminalSessionRecord {
  id: string;
  shell: string | null;
  cwd: string | null;
  status: TerminalSessionStatus;
  buffer: TerminalBufferChunk[];
  scrollbackBytes: number;
  exitCode: number | null;
  nextChunkId: number;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalGroupRecord {
  id: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface BottomLayoutSnapshot {
  collapsed: boolean;
  activePanelId: PanelId | null;
  bottomHeight: number;
}

interface CloseTerminalOptions {
  restoreBottomState?: boolean;
}

interface TerminalStoreState {
  sessions: Record<string, TerminalSessionRecord>;
  groups: Record<string, TerminalGroupRecord>;
  groupOrder: string[];
  activeGroupId: string | null;
  visibleSessionIds: string[];
  openingSessionIds: string[];
  lastError: string | null;
  openTerminal: () => Promise<boolean>;
  createTerminal: () => Promise<string | null>;
  splitGroup: (groupId: string) => Promise<string | null>;
  selectGroup: (groupId: string) => void;
  closeSession: (sessionId: string, options?: CloseTerminalOptions) => Promise<boolean>;
  closeGroup: (groupId: string, options?: CloseTerminalOptions) => Promise<boolean>;
  closeTerminal: (options?: CloseTerminalOptions) => Promise<boolean>;
  toggleTerminal: () => Promise<boolean>;
  writeToSession: (sessionId: string, data: string) => Promise<void>;
  resizeSession: (sessionId: string, cols: number, rows: number) => Promise<void>;
  cleanupSessions: () => Promise<boolean>;
}

const sessionListeners = new Map<string, UnlistenFn>();
const pendingCloseSessionIds = new Set<string>();
let bottomSnapshot: BottomLayoutSnapshot | null = null;
let terminalLayoutMutationDepth = 0;

function terminalEventName(sessionId: string): string {
  return `terminal:session:${sessionId}`;
}

function isTerminalLayoutMutationSuppressed(): boolean {
  return terminalLayoutMutationDepth > 0;
}

function runTerminalLayoutMutation(work: () => void): void {
  terminalLayoutMutationDepth += 1;
  try {
    work();
  } finally {
    queueMicrotask(() => {
      terminalLayoutMutationDepth = Math.max(0, terminalLayoutMutationDepth - 1);
    });
  }
}

function detachSessionListener(sessionId: string): void {
  const unlisten = sessionListeners.get(sessionId);
  if (!unlisten) {
    return;
  }

  try {
    unlisten();
  } catch (error) {
    logger.warn('Terminal event listener cleanup failed', { error, sessionId });
  }

  sessionListeners.delete(sessionId);
}

function createPendingSession(sessionId: string): TerminalSessionRecord {
  const timestamp = new Date().toISOString();
  return {
    id: sessionId,
    shell: null,
    cwd: null,
    status: 'starting',
    buffer: [],
    scrollbackBytes: 0,
    exitCode: null,
    nextChunkId: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createGroupRecord(groupId: string, sessionIds: string[]): TerminalGroupRecord {
  const timestamp = new Date().toISOString();
  return {
    id: groupId,
    sessionIds,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function appendScrollback(session: TerminalSessionRecord, chunk: string): void {
  if (!chunk) {
    return;
  }

  const nextChunkId = session.nextChunkId + 1;
  session.nextChunkId = nextChunkId;
  session.buffer = [...session.buffer, { id: nextChunkId, data: chunk }];
  session.scrollbackBytes += new TextEncoder().encode(chunk).length;

  while (session.scrollbackBytes > MAX_SCROLLBACK_BYTES && session.buffer.length > 1) {
    const [removed, ...rest] = session.buffer;
    session.buffer = rest;
    session.scrollbackBytes -= new TextEncoder().encode(removed.data).length;
  }
}

function captureBottomSnapshot(): BottomLayoutSnapshot {
  const layout = useWorkspaceLayoutStore.getState().layout;
  const fallbackActivePanelId = layout.zones.bottom.panelIds.find(
    (panelId) => panelId !== TERMINAL_PANEL_ID,
  );

  return {
    collapsed: layout.zones.bottom.collapsed,
    activePanelId:
      layout.zones.bottom.activePanelId === TERMINAL_PANEL_ID
        ? (fallbackActivePanelId ?? null)
        : layout.zones.bottom.activePanelId,
    bottomHeight: layout.sizes.bottomHeight,
  };
}

function ensureTerminalVisible(): void {
  const layoutStore = useWorkspaceLayoutStore.getState();
  const terminalZoneId = findPanelZone(layoutStore.layout, TERMINAL_PANEL_ID);

  runTerminalLayoutMutation(() => {
    if (terminalZoneId !== TERMINAL_ZONE_ID) {
      layoutStore.hidePanel(TERMINAL_PANEL_ID);
      layoutStore.restorePanel(TERMINAL_PANEL_ID, TERMINAL_ZONE_ID);
    }

    if (layoutStore.layout.sizes.bottomHeight < DEFAULT_TERMINAL_HEIGHT) {
      layoutStore.setBottomHeight(DEFAULT_TERMINAL_HEIGHT);
    }

    layoutStore.setActivePanel(TERMINAL_ZONE_ID, TERMINAL_PANEL_ID);
    layoutStore.setZoneCollapsed(TERMINAL_ZONE_ID, false);
  });
}

function hideTerminalPanel(options: CloseTerminalOptions = {}): void {
  const layoutStore = useWorkspaceLayoutStore.getState();

  runTerminalLayoutMutation(() => {
    layoutStore.hidePanel(TERMINAL_PANEL_ID);

    const bottomZone = useWorkspaceLayoutStore.getState().layout.zones.bottom;
    if (options.restoreBottomState !== false && bottomSnapshot) {
      const nextActivePanelId =
        bottomSnapshot.activePanelId && bottomZone.panelIds.includes(bottomSnapshot.activePanelId)
          ? bottomSnapshot.activePanelId
          : (bottomZone.panelIds[0] ?? null);

      if (nextActivePanelId) {
        layoutStore.setActivePanel(TERMINAL_ZONE_ID, nextActivePanelId);
      }

      layoutStore.setBottomHeight(bottomSnapshot.bottomHeight);
      layoutStore.setZoneCollapsed(
        TERMINAL_ZONE_ID,
        bottomSnapshot.collapsed || bottomZone.panelIds.length === 0,
      );
      return;
    }

    const nextActivePanelId =
      bottomZone.activePanelId && bottomZone.panelIds.includes(bottomZone.activePanelId)
        ? bottomZone.activePanelId
        : (bottomZone.panelIds[0] ?? null);

    if (nextActivePanelId) {
      layoutStore.setActivePanel(TERMINAL_ZONE_ID, nextActivePanelId);
    }
    if (bottomZone.panelIds.length === 0) {
      layoutStore.setZoneCollapsed(TERMINAL_ZONE_ID, true);
    }
  });
}

function isTerminalVisible(): boolean {
  const layout = useWorkspaceLayoutStore.getState().layout;
  return (
    findPanelZone(layout, TERMINAL_PANEL_ID) === TERMINAL_ZONE_ID &&
    layout.zones.bottom.activePanelId === TERMINAL_PANEL_ID &&
    !layout.zones.bottom.collapsed
  );
}

async function resolveConfiguredProfileId(): Promise<{
  profileId: string | null;
  error: string | null;
}> {
  const configuredCommand =
    useSettingsStore.getState().settings.terminal.defaultShellCommand?.trim() ?? '';

  if (!configuredCommand) {
    return { profileId: null, error: null };
  }

  try {
    const profiles = await invoke<DetectedTerminalProfile[]>('list_terminal_profiles');
    const profile = profiles.find((candidate) => candidate.commandLine === configuredCommand);
    if (profile) {
      return { profileId: profile.id, error: null };
    }
  } catch (error) {
    return {
      profileId: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    profileId: null,
    error:
      'Custom terminal command lines are disabled. Select a detected terminal profile in Settings.',
  };
}

function findGroupIdBySessionId(
  state: Pick<TerminalStoreState, 'groups' | 'groupOrder'>,
  sessionId: string,
): string | null {
  for (const groupId of state.groupOrder) {
    if (state.groups[groupId]?.sessionIds.includes(sessionId)) {
      return groupId;
    }
  }
  return null;
}

function resolveVisibleSessionIds(
  state: Pick<TerminalStoreState, 'groups' | 'sessions' | 'openingSessionIds'>,
  groupId: string | null,
): string[] {
  if (!groupId) {
    return [];
  }

  return (state.groups[groupId]?.sessionIds ?? []).filter(
    (sessionId) =>
      Boolean(state.sessions[sessionId]) || state.openingSessionIds.includes(sessionId),
  );
}

function resolveNextActiveGroupId(
  groupOrder: string[],
  groups: Record<string, TerminalGroupRecord>,
  preferredGroupId: string | null,
): string | null {
  if (preferredGroupId && groups[preferredGroupId]) {
    return preferredGroupId;
  }
  return groupOrder[0] ?? null;
}

function resolveStateAfterSessionRemoval(state: TerminalStoreState, sessionId: string) {
  const nextSessions = Object.fromEntries(
    Object.entries(state.sessions).filter(([candidateId]) => candidateId !== sessionId),
  );
  const nextOpeningSessionIds = state.openingSessionIds.filter(
    (candidateId) => candidateId !== sessionId,
  );

  const nextGroups: Record<string, TerminalGroupRecord> = {};
  const nextGroupOrder: string[] = [];
  for (const groupId of state.groupOrder) {
    const group = state.groups[groupId];
    if (!group) {
      continue;
    }

    const nextSessionIds = group.sessionIds.filter((candidateId) => candidateId !== sessionId);
    if (nextSessionIds.length === 0) {
      continue;
    }

    nextGroups[groupId] = {
      ...group,
      sessionIds: nextSessionIds,
      updatedAt: new Date().toISOString(),
    };
    nextGroupOrder.push(groupId);
  }

  const currentGroupId = findGroupIdBySessionId(state, sessionId);
  const nextActiveGroupId = resolveNextActiveGroupId(
    nextGroupOrder,
    nextGroups,
    state.activeGroupId === currentGroupId ? null : state.activeGroupId,
  );

  return {
    sessions: nextSessions,
    groups: nextGroups,
    groupOrder: nextGroupOrder,
    openingSessionIds: nextOpeningSessionIds,
    activeGroupId: nextActiveGroupId,
    visibleSessionIds: resolveVisibleSessionIds(
      { groups: nextGroups, sessions: nextSessions, openingSessionIds: nextOpeningSessionIds },
      nextActiveGroupId,
    ),
  };
}

function maybeHideTerminalAfterRemoval(options: CloseTerminalOptions = {}): void {
  const state = useTerminalStore.getState();
  if (state.groupOrder.length === 0 && state.openingSessionIds.length === 0) {
    hideTerminalPanel(options);
    bottomSnapshot = null;
  }
}

function registerTerminalListener(sessionId: string): Promise<UnlistenFn> {
  return listen<TerminalStreamEvent>(terminalEventName(sessionId), (event) => {
    const payload = event.payload;

    useTerminalStore.setState((state) => {
      const session = state.sessions[sessionId];
      if (!session) {
        return state;
      }

      const nextSession: TerminalSessionRecord = {
        ...session,
        updatedAt: new Date().toISOString(),
      };
      let nextLastError = state.lastError;

      if (payload.type === 'data') {
        appendScrollback(nextSession, payload.data);
      }

      if (payload.type === 'error') {
        nextSession.status = 'error';
        appendScrollback(nextSession, `\r\n[error] ${payload.message}\r\n`);
        nextLastError = payload.message;
      }

      if (payload.type === 'exit') {
        nextSession.status = nextSession.status === 'error' ? 'error' : 'exited';
        nextSession.exitCode = payload.exitCode ?? null;
        appendScrollback(
          nextSession,
          `\r\n[process exited${payload.exitCode == null ? '' : ` with code ${payload.exitCode}`}]\r\n`,
        );
        detachSessionListener(sessionId);
      }

      return {
        ...state,
        lastError: nextLastError,
        sessions: {
          ...state.sessions,
          [sessionId]: nextSession,
        },
      };
    });
  });
}

async function startSession(
  sessionId: string,
  mode: { type: 'new-group'; groupId: string } | { type: 'split-group'; groupId: string },
): Promise<string | null> {
  const resolvedProfile = await resolveConfiguredProfileId();
  if (resolvedProfile.error) {
    useTerminalStore.setState({ lastError: resolvedProfile.error });
    return null;
  }

  if (!bottomSnapshot) {
    bottomSnapshot = captureBottomSnapshot();
  }

  ensureTerminalVisible();

  const pendingSession = createPendingSession(sessionId);
  useTerminalStore.setState((state) => {
    const nextGroups = { ...state.groups };
    const nextGroupOrder = [...state.groupOrder];
    if (mode.type === 'new-group') {
      nextGroups[mode.groupId] = createGroupRecord(mode.groupId, [sessionId]);
      nextGroupOrder.push(mode.groupId);
    } else {
      const group = state.groups[mode.groupId];
      if (group) {
        nextGroups[mode.groupId] = {
          ...group,
          sessionIds: [...group.sessionIds, sessionId],
          updatedAt: new Date().toISOString(),
        };
      }
    }

    const nextOpeningSessionIds = [...state.openingSessionIds, sessionId];
    const nextActiveGroupId = mode.groupId;
    const nextSessions = {
      ...state.sessions,
      [sessionId]: pendingSession,
    };

    return {
      ...state,
      lastError: null,
      sessions: nextSessions,
      groups: nextGroups,
      groupOrder: nextGroupOrder,
      activeGroupId: nextActiveGroupId,
      openingSessionIds: nextOpeningSessionIds,
      visibleSessionIds: resolveVisibleSessionIds(
        { groups: nextGroups, sessions: nextSessions, openingSessionIds: nextOpeningSessionIds },
        nextActiveGroupId,
      ),
    };
  });

  let unlisten: UnlistenFn | null = null;

  try {
    unlisten = await registerTerminalListener(sessionId);
    sessionListeners.set(sessionId, unlisten);

    const result = await invoke<TerminalSessionStartResult>('start_terminal_session', {
      input: {
        sessionId,
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
        profileId: resolvedProfile.profileId,
      } satisfies StartTerminalSessionInput,
    });

    if (pendingCloseSessionIds.has(sessionId)) {
      pendingCloseSessionIds.delete(sessionId);

      try {
        await invoke('close_terminal_session', { input: { sessionId } });
      } catch (error) {
        logger.warn('Deferred terminal close failed after open race', { error, sessionId });
      }

      detachSessionListener(sessionId);
      useTerminalStore.setState((state) => ({
        ...state,
        ...resolveStateAfterSessionRemoval(state, sessionId),
      }));
      maybeHideTerminalAfterRemoval();
      return null;
    }

    useTerminalStore.setState((state) => {
      const session = state.sessions[sessionId];
      if (!session) {
        return state;
      }

      const nextSessions = {
        ...state.sessions,
        [sessionId]: {
          ...session,
          shell: result.shell,
          cwd: result.cwd,
          status: 'running' as const,
          updatedAt: new Date().toISOString(),
        },
      };
      const nextOpeningSessionIds = state.openingSessionIds.filter(
        (candidateId) => candidateId !== sessionId,
      );

      return {
        ...state,
        sessions: nextSessions,
        openingSessionIds: nextOpeningSessionIds,
        visibleSessionIds: resolveVisibleSessionIds(
          {
            groups: state.groups,
            sessions: nextSessions,
            openingSessionIds: nextOpeningSessionIds,
          },
          state.activeGroupId,
        ),
      };
    });

    return sessionId;
  } catch (error) {
    pendingCloseSessionIds.delete(sessionId);
    if (unlisten) {
      detachSessionListener(sessionId);
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to open terminal session', { error, sessionId });
    useTerminalStore.setState((state) => ({
      ...state,
      lastError: message,
      ...resolveStateAfterSessionRemoval(state, sessionId),
    }));
    maybeHideTerminalAfterRemoval();
    return null;
  }
}

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
  sessions: {},
  groups: {},
  groupOrder: [],
  activeGroupId: null,
  visibleSessionIds: [],
  openingSessionIds: [],
  lastError: null,

  openTerminal: async () => {
    if (!isDesktopRuntimeAvailable()) {
      set({ lastError: 'Integrated terminal is only available in the desktop app runtime.' });
      return false;
    }

    if (!bottomSnapshot) {
      bottomSnapshot = captureBottomSnapshot();
    }

    ensureTerminalVisible();

    if (get().groupOrder.length > 0) {
      const targetGroupId = get().activeGroupId ?? get().groupOrder[0] ?? null;
      if (targetGroupId) {
        get().selectGroup(targetGroupId);
        return true;
      }
    }

    return (await get().createTerminal()) !== null;
  },

  createTerminal: async () => {
    if (!isDesktopRuntimeAvailable()) {
      set({ lastError: 'Integrated terminal is only available in the desktop app runtime.' });
      return null;
    }

    const groupId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    return startSession(sessionId, { type: 'new-group', groupId });
  },

  splitGroup: async (groupId) => {
    if (!get().groups[groupId]) {
      return null;
    }

    const sessionId = crypto.randomUUID();
    return startSession(sessionId, { type: 'split-group', groupId });
  },

  selectGroup: (groupId) => {
    if (!get().groups[groupId]) {
      return;
    }

    ensureTerminalVisible();
    set((state) => ({
      ...state,
      activeGroupId: groupId,
      visibleSessionIds: resolveVisibleSessionIds(state, groupId),
    }));
  },

  closeSession: async (sessionId, options = {}) => {
    const state = get();
    const session = state.sessions[sessionId];
    if (!session) {
      return true;
    }

    if (state.openingSessionIds.includes(sessionId) && session.status === 'starting') {
      pendingCloseSessionIds.add(sessionId);
      detachSessionListener(sessionId);
      set((currentState) => ({
        ...currentState,
        ...resolveStateAfterSessionRemoval(currentState, sessionId),
      }));
      maybeHideTerminalAfterRemoval(options);
      return true;
    }

    if (isDesktopRuntimeAvailable() && session.status === 'running') {
      try {
        await invoke('close_terminal_session', { input: { sessionId } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to close terminal session', { error, sessionId });
        set({ lastError: message });
        return false;
      }
    }

    pendingCloseSessionIds.delete(sessionId);
    detachSessionListener(sessionId);
    set((currentState) => ({
      ...currentState,
      ...resolveStateAfterSessionRemoval(currentState, sessionId),
    }));
    maybeHideTerminalAfterRemoval(options);
    return true;
  },

  closeGroup: async (groupId, options = {}) => {
    const group = get().groups[groupId];
    if (!group) {
      return true;
    }

    let allClosed = true;
    for (const sessionId of [...group.sessionIds]) {
      const closed = await get().closeSession(sessionId, options);
      allClosed = allClosed && closed;
    }

    return allClosed;
  },

  closeTerminal: async (options = {}) => {
    const groupIds = [...get().groupOrder];
    if (groupIds.length === 0 && get().openingSessionIds.length === 0) {
      hideTerminalPanel(options);
      bottomSnapshot = null;
      set({
        sessions: {},
        groups: {},
        groupOrder: [],
        activeGroupId: null,
        visibleSessionIds: [],
        openingSessionIds: [],
        lastError: null,
      });
      return true;
    }

    let allClosed = true;
    for (const groupId of groupIds) {
      const closed = await get().closeGroup(groupId, options);
      allClosed = allClosed && closed;
    }

    if (allClosed) {
      bottomSnapshot = null;
      set((state) => ({
        ...state,
        activeGroupId: null,
        visibleSessionIds: [],
        lastError: null,
      }));
    }

    return allClosed;
  },

  toggleTerminal: async () => {
    if (isTerminalVisible() || get().groupOrder.length > 0 || get().openingSessionIds.length > 0) {
      return get().closeTerminal();
    }

    return get().openTerminal();
  },

  writeToSession: async (sessionId, data) => {
    const session = get().sessions[sessionId];
    if (!session || session.status !== 'running' || !data || !isDesktopRuntimeAvailable()) {
      return;
    }

    try {
      await invoke('write_terminal_input', { input: { sessionId, data } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to write terminal input', { error, sessionId });
      set((state) => {
        const target = state.sessions[sessionId];
        if (!target) {
          return state;
        }

        const nextSession = {
          ...target,
          status: 'error' as const,
          updatedAt: new Date().toISOString(),
        };
        appendScrollback(nextSession, `\r\n[error] ${message}\r\n`);

        return {
          ...state,
          lastError: message,
          sessions: {
            ...state.sessions,
            [sessionId]: nextSession,
          },
        };
      });
    }
  },

  resizeSession: async (sessionId, cols, rows) => {
    const session = get().sessions[sessionId];
    if (!session || session.status !== 'running' || !isDesktopRuntimeAvailable()) {
      return;
    }

    try {
      await invoke('resize_terminal_session', {
        input: {
          sessionId,
          cols,
          rows,
        },
      });
    } catch (error) {
      logger.warn('Failed to resize terminal session', { error, sessionId, cols, rows });
    }
  },

  cleanupSessions: async () => {
    pendingCloseSessionIds.clear();
    const closed = await get().closeTerminal({ restoreBottomState: false });
    if (closed) {
      set({
        sessions: {},
        groups: {},
        groupOrder: [],
        activeGroupId: null,
        visibleSessionIds: [],
        openingSessionIds: [],
        lastError: null,
      });
    }
    return closed;
  },
}));

useWorkspaceLayoutStore.subscribe((state, previousState) => {
  if (isTerminalLayoutMutationSuppressed()) {
    return;
  }

  const terminalState = useTerminalStore.getState();
  if (terminalState.groupOrder.length === 0 && terminalState.openingSessionIds.length === 0) {
    return;
  }

  const previousZoneId = findPanelZone(previousState.layout, TERMINAL_PANEL_ID);
  const nextZoneId = findPanelZone(state.layout, TERMINAL_PANEL_ID);
  const previousBottomCollapsed = previousState.layout.zones.bottom.collapsed;
  const nextBottomCollapsed = state.layout.zones.bottom.collapsed;
  const previousActivePanelId = previousState.layout.zones.bottom.activePanelId;
  const nextActivePanelId = state.layout.zones.bottom.activePanelId;

  const terminalRemoved = previousZoneId !== null && nextZoneId === null;
  const terminalMoved = nextZoneId !== null && nextZoneId !== TERMINAL_ZONE_ID;
  const bottomClosed =
    previousZoneId === TERMINAL_ZONE_ID && !previousBottomCollapsed && nextBottomCollapsed;
  const terminalHiddenByTabSwitch =
    previousZoneId === TERMINAL_ZONE_ID &&
    previousActivePanelId === TERMINAL_PANEL_ID &&
    nextActivePanelId !== TERMINAL_PANEL_ID;

  if (terminalRemoved || terminalMoved || bottomClosed || terminalHiddenByTabSwitch) {
    void terminalState.closeTerminal({ restoreBottomState: false });
  }
});

export async function cleanupTerminalSessions(): Promise<boolean> {
  return useTerminalStore.getState().cleanupSessions();
}
