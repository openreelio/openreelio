/**
 * Agent Components Index
 *
 * Exports all agent-related UI components.
 */

// Core agent components
export { ApprovalDialog, type ApprovalDialogProps } from './ApprovalDialog';
export { WorkflowProgress, type WorkflowProgressProps } from './WorkflowProgress';
export { StreamingResponse, type StreamingResponseProps } from './StreamingResponse';

// Agentic loop components (Phase 7)
export { ThinkingIndicator, type ThinkingIndicatorProps } from './ThinkingIndicator';
export { PlanViewer, type PlanViewerProps } from './PlanViewer';
export { ActionFeed, type ActionFeedProps } from './ActionFeed';
export { AgenticChat, type AgenticChatProps } from './AgenticChat';
export { ChatMessageList, type ChatMessageListProps } from './ChatMessageList';
export { ChatInputArea, type ChatInputAreaProps } from './ChatInputArea';

// Integration components (Phase 8)
export { AgenticSidebarContent, type AgenticSidebarContentProps } from './AgenticSidebarContent';

// Enhanced prompt input (Phase 4 - Rich Chat UI)
export { PromptInput, type PromptInputProps } from './PromptInput';
export { MentionPopover, type MentionItem } from './MentionPopover';
export { CommandPopover, type CommandItem } from './CommandPopover';
export { SessionList } from './SessionList';

// Agent Manager (Phase 5 - Mission Control)
export { AgentManager } from './AgentManager';
export { AgentCard } from './AgentCard';
export { InboxPanel } from './InboxPanel';
