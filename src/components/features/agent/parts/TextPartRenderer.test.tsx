/**
 * TextPartRenderer Tests
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TextPartRenderer } from './TextPartRenderer';
import type { TextPart } from '@/agents/engine/core/conversation';

describe('TextPartRenderer', () => {
  it('should render plain text', () => {
    const part: TextPart = { type: 'text', content: 'Hello world' };
    render(<TextPartRenderer part={part} />);

    expect(screen.getByTestId('text-part')).toBeInTheDocument();
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('should render bold text', () => {
    const part: TextPart = { type: 'text', content: '**bold text**' };
    render(<TextPartRenderer part={part} />);

    const strong = screen.getByText('bold text');
    expect(strong.tagName).toBe('STRONG');
  });

  it('should render italic text', () => {
    const part: TextPart = { type: 'text', content: '*italic text*' };
    render(<TextPartRenderer part={part} />);

    const em = screen.getByText('italic text');
    expect(em.tagName).toBe('EM');
  });

  it('should render inline code', () => {
    const part: TextPart = { type: 'text', content: '`inline code`' };
    render(<TextPartRenderer part={part} />);

    const code = screen.getByText('inline code');
    expect(code.tagName).toBe('CODE');
  });

  it('should render unordered list items', () => {
    const part: TextPart = { type: 'text', content: '- list item one\n- list item two' };
    render(<TextPartRenderer part={part} />);

    expect(screen.getByText('list item one')).toBeInTheDocument();
    expect(screen.getByText('list item two')).toBeInTheDocument();
  });

  it('should render ordered list items', () => {
    const part: TextPart = { type: 'text', content: '1. first item\n2. second item' };
    render(<TextPartRenderer part={part} />);

    expect(screen.getByText('first item')).toBeInTheDocument();
    expect(screen.getByText('second item')).toBeInTheDocument();
  });

  it('should render safe links', () => {
    const part: TextPart = { type: 'text', content: '[click](https://example.com)' };
    render(<TextPartRenderer part={part} />);

    const link = screen.getByText('click');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://example.com');
  });

  it('should block javascript: URLs in links', () => {
    const part: TextPart = { type: 'text', content: '[xss](javascript:alert(1))' };
    render(<TextPartRenderer part={part} />);

    const link = screen.getByText('xss');
    expect(link).toHaveAttribute('href', '#');
  });

  it('should block data: URLs in links', () => {
    const part: TextPart = { type: 'text', content: '[xss](data:text/html,<script>alert(1)</script>)' };
    render(<TextPartRenderer part={part} />);

    const link = screen.getByText('xss');
    expect(link).toHaveAttribute('href', '#');
  });

  it('should apply custom className', () => {
    const part: TextPart = { type: 'text', content: 'test' };
    render(<TextPartRenderer part={part} className="custom" />);

    expect(screen.getByTestId('text-part')).toHaveClass('custom');
  });
});
