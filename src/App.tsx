/**
 * OpenReelio Application
 *
 * Main application component using layout components.
 */

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Play } from 'lucide-react';
import { MainLayout, Header, Sidebar, BottomPanel, Panel } from './components/layout';

// =============================================================================
// Project Explorer Sidebar Content
// =============================================================================

function ProjectExplorer() {
  return (
    <p className="text-sm text-editor-text-muted">No project loaded</p>
  );
}

// =============================================================================
// Inspector Sidebar Content
// =============================================================================

function Inspector() {
  const [greetMsg, setGreetMsg] = useState('');
  const [name, setName] = useState('');

  async function greet() {
    const message = await invoke<string>('greet', { name });
    setGreetMsg(message);
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      greet();
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-editor-text-muted">Test Tauri Connection:</p>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full px-3 py-2 bg-editor-bg border border-editor-border rounded text-sm text-editor-text focus:outline-none focus:ring-1 focus:ring-primary-500"
        placeholder="Enter your name"
      />
      <button
        onClick={greet}
        className="w-full px-3 py-2 bg-primary-600 text-white text-sm rounded hover:bg-primary-700 transition-colors"
      >
        Greet
      </button>
      {greetMsg && <p className="text-sm text-primary-400">{greetMsg}</p>}
    </div>
  );
}

// =============================================================================
// Preview Player Content
// =============================================================================

function PreviewPlayer() {
  return (
    <div className="h-full bg-black flex items-center justify-center">
      <div className="text-center">
        <div className="w-32 h-32 bg-editor-panel rounded-lg flex items-center justify-center mb-4">
          <Play className="w-16 h-16 text-editor-text-muted" />
        </div>
        <p className="text-editor-text-muted text-sm">Preview Player</p>
      </div>
    </div>
  );
}

// =============================================================================
// Timeline Content
// =============================================================================

function Timeline() {
  return (
    <Panel title="Timeline" variant="default" className="h-full">
      <div className="h-full bg-editor-bg rounded border border-editor-border flex items-center justify-center">
        <p className="text-editor-text-muted text-sm">Timeline will be rendered here</p>
      </div>
    </Panel>
  );
}

// =============================================================================
// Console Content
// =============================================================================

function Console() {
  return (
    <div className="h-full bg-editor-bg rounded border border-editor-border p-2 font-mono text-xs text-editor-text-muted overflow-auto">
      <p>OpenReelio initialized.</p>
      <p>Ready to edit.</p>
    </div>
  );
}

// =============================================================================
// Main Application Component
// =============================================================================

function App() {
  return (
    <MainLayout
      header={<Header />}
      leftSidebar={
        <Sidebar title="Project Explorer" position="left">
          <ProjectExplorer />
        </Sidebar>
      }
      rightSidebar={
        <Sidebar title="Inspector" position="right" width={288}>
          <Inspector />
        </Sidebar>
      }
      footer={
        <BottomPanel title="Console">
          <Console />
        </BottomPanel>
      }
    >
      {/* Center content split between preview and timeline */}
      <div className="flex flex-col h-full">
        <div className="flex-1 border-b border-editor-border">
          <PreviewPlayer />
        </div>
        <div className="flex-1">
          <Timeline />
        </div>
      </div>
    </MainLayout>
  );
}

export default App;
